//! SSL and SSH tunnel tests against a TLS-enabled PostgreSQL and an OpenSSH server, both in Docker on
//! one private network. Skipped without Docker. The key and agent tests also need `ssh-keygen`,
//! `ssh-agent` and `ssh-add`, and are skipped without them.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, DnType, IsCa, KeyPair};
use testcontainers::core::{IntoContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, CopyTargetOptions, GenericImage, ImageExt};
use testcontainers_modules::postgres::Postgres;
use uuid::Uuid;

use super::*;
use crate::connections::{AccessLevel, ConnectionInput, Engine, SslMode};
use crate::session::{ConnectTarget, Credentials, Liveness, Session, SessionError, test};

const PG_PASSWORD: &str = "postgres";
const SSH_USER: &str = "tunnel";
const SSH_PASSWORD: &str = "tunnel-pass";
const PASSPHRASE: &str = "open sesame";

/// A CA and a server certificate for `localhost` and the database's name on the Docker network.
struct Certs {
    ca_path: PathBuf,
    server_cert: String,
    server_key: String,
}

fn make_certs(dir: &Path, pg_name: &str) -> Certs {
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(DnType::CommonName, "dbrief test CA");
    let ca = CertifiedIssuer::self_signed(ca_params, KeyPair::generate().unwrap()).unwrap();

    let server_key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(vec!["localhost".into(), pg_name.into()]).unwrap();
    params
        .distinguished_name
        .push(DnType::CommonName, "localhost");
    let server_cert = params.signed_by(&server_key, &ca).unwrap();

    let ca_path = dir.join("ca.pem");
    std::fs::write(&ca_path, ca.pem()).unwrap();
    Certs {
        ca_path,
        server_cert: server_cert.pem(),
        server_key: server_key.serialize_pem(),
    }
}

/// Runs as the postgres user during initdb; the server then restarts with SSL on.
const PG_SSL_INIT: &str = r#"
cp /certs/server.crt /certs/server.key "$PGDATA"/
chmod 600 "$PGDATA/server.key"
cat >> "$PGDATA/postgresql.conf" <<CONF
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
CONF
"#;

/// The image disables TCP forwarding; turn it on before sshd starts.
const SSH_FORWARDING_INIT: &str = r#"#!/bin/sh
sed -i 's/^#\?AllowTcpForwarding.*/AllowTcpForwarding yes/' /config/sshd/sshd_config
"#;

struct Keys {
    /// No passphrase; also loaded into the agent.
    plain: PathBuf,
    /// Protected by [`PASSPHRASE`].
    protected: PathBuf,
}

/// `None` when `ssh-keygen` isn't available.
fn make_keys(dir: &Path) -> Option<Keys> {
    let keygen = |name: &str, passphrase: &str| -> Option<PathBuf> {
        let path = dir.join(name);
        let status = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-C", name, "-N", passphrase, "-f"])
            .arg(&path)
            .status()
            .ok()?;
        status.success().then_some(path)
    };

    Some(Keys {
        plain: keygen("id_plain", "")?,
        protected: keygen("id_protected", PASSPHRASE)?,
    })
}

fn public_key(key: &Path) -> String {
    std::fs::read_to_string(key.with_extension("pub")).unwrap()
}

/// An ssh-agent on its own socket, holding `key`. Killed on drop.
struct Agent {
    child: Child,
    socket: PathBuf,
}

impl Agent {
    fn start(dir: &Path, key: &Path) -> Option<Self> {
        let socket = dir.join("agent.sock");
        let child = Command::new("ssh-agent")
            .arg("-D")
            .arg("-a")
            .arg(&socket)
            .stdout(Stdio::null())
            .spawn()
            .ok()?;
        let agent = Self { child, socket };

        for _ in 0..50 {
            if agent.socket.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        let added = Command::new("ssh-add")
            .arg("-q")
            .arg(key)
            .env("SSH_AUTH_SOCK", &agent.socket)
            .status()
            .ok()?;
        added.success().then_some(agent)
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Fixture {
    _pg: ContainerAsync<Postgres>,
    _ssh: ContainerAsync<GenericImage>,
    pg_name: String,
    pg_port: u16,
    ssh_port: u16,
    certs: Certs,
    keys: Option<Keys>,
    dir: tempfile::TempDir,
}

async fn start() -> Option<Fixture> {
    let dir = tempfile::tempdir().unwrap();
    let id = &Uuid::new_v4().simple().to_string()[..8];
    let network = format!("dbrief-test-{id}");
    let pg_name = format!("dbrief-pg-{id}");
    let certs = make_certs(dir.path(), &pg_name);
    let keys = make_keys(dir.path());

    let pg = Postgres::default()
        .with_tag("17-alpine")
        .with_network(&network)
        .with_container_name(&pg_name)
        .with_copy_to("/certs/server.crt", certs.server_cert.clone().into_bytes())
        .with_copy_to(
            CopyTargetOptions::new("/certs/server.key").with_mode(0o644),
            certs.server_key.clone().into_bytes(),
        )
        .with_copy_to(
            "/docker-entrypoint-initdb.d/ssl.sh",
            PG_SSL_INIT.as_bytes().to_vec(),
        )
        .start()
        .await;
    let pg = match pg {
        Ok(pg) => pg,
        Err(e) => {
            eprintln!("skipping SSL and SSH tests: Docker is not available ({e})");
            return None;
        }
    };

    let mut ssh = GenericImage::new("lscr.io/linuxserver/openssh-server", "latest")
        .with_exposed_port(2222.tcp())
        .with_wait_for(WaitFor::message_on_stdout("[ls.io-init] done."))
        .with_network(&network)
        .with_env_var("USER_NAME", SSH_USER)
        .with_env_var("PASSWORD_ACCESS", "true")
        .with_env_var("USER_PASSWORD", SSH_PASSWORD)
        .with_copy_to(
            CopyTargetOptions::new("/custom-cont-init.d/forwarding.sh").with_mode(0o755),
            SSH_FORWARDING_INIT.as_bytes().to_vec(),
        );
    if let Some(keys) = &keys {
        let authorized = format!("{}{}", public_key(&keys.plain), public_key(&keys.protected));
        ssh = ssh
            .with_env_var("PUBLIC_KEY_FILE", "/pubkeys/authorized")
            .with_copy_to("/pubkeys/authorized", authorized.into_bytes());
    }
    let ssh = ssh.start().await.expect("start the SSH server");

    Some(Fixture {
        pg_port: pg.get_host_port_ipv4(5432).await.unwrap(),
        ssh_port: ssh.get_host_port_ipv4(2222).await.unwrap(),
        _pg: pg,
        _ssh: ssh,
        pg_name,
        certs,
        keys,
        dir,
    })
}

impl Fixture {
    fn env(&self) -> SshEnv {
        SshEnv {
            app_known_hosts: self.dir.path().join("app/known_hosts"),
            ssh_dir: Some(self.dir.path().join("dot-ssh")),
            agent_socket: None,
        }
    }

    /// A direct connection to the published port.
    fn direct(&self, host: &str, mode: SslMode, ca: bool) -> ConnectionInput {
        let mut input = ConnectionInput::new("pg", Engine::Postgres, AccessLevel::Rw);
        input.host = Some(host.into());
        input.port = Some(self.pg_port);
        input.username = Some("postgres".into());
        input.database = Some("postgres".into());
        input.ssl_mode = Some(mode);
        input.connect_timeout_s = Some(10);
        if ca {
            input.ca_cert_path = Some(self.certs.ca_path.display().to_string());
        }
        input
    }

    /// The database by its network name, through the SSH server.
    fn tunneled(&self, auth: SshAuth) -> ConnectionInput {
        let mut input = self.direct(&self.pg_name, SslMode::VerifyFull, true);
        input.port = Some(5432);
        input.ssh = Some(SshTunnel {
            host: "127.0.0.1".into(),
            port: Some(self.ssh_port),
            user: Some(SSH_USER.into()),
            auth,
        });
        input
    }

    fn target(&self, input: &ConnectionInput, credentials: Credentials) -> ConnectTarget {
        let credentials = Credentials {
            password: Some(PG_PASSWORD.into()),
            ..credentials
        };
        ConnectTarget::new(Uuid::new_v4(), input, &credentials, &self.env()).unwrap()
    }
}

async fn uses_ssl(session: &mut Session) -> String {
    session
        .fetch_text(
            r#"
            SELECT
                ssl::text
            FROM
                pg_stat_ssl
            WHERE
                pid = pg_backend_pid()
            "#,
        )
        .await
        .unwrap()
}

/// Retries while the servers finish starting (PostgreSQL restarts after initdb; sshd starts last).
async fn open_eventually(target: ConnectTarget) -> Session {
    let mut last = None;
    for _ in 0..40 {
        match Session::open(target.clone()).await {
            Ok(session) => return session,
            Err(e) => last = Some(e),
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("could not connect: {last:?}");
}

#[tokio::test]
async fn ssl_and_ssh_tunnels() {
    let Some(fx) = start().await else {
        return;
    };

    ssl_modes(&fx).await;
    tunnel_with_password(&fx).await;
    tunnel_with_keys(&fx).await;
    tunnel_with_agent(&fx).await;
    tunnel_from_ssh_config(&fx).await;
}

async fn ssl_modes(fx: &Fixture) {
    // verify-full with the CA, against a name in the certificate.
    let mut session = open_eventually(fx.target(
        &fx.direct("localhost", SslMode::VerifyFull, true),
        Credentials::default(),
    ))
    .await;
    assert_eq!(uses_ssl(&mut session).await, "true");
    session.close().await;

    // verify-ca checks the chain but not the name; verify-full rejects the name.
    let ip_ca = fx.target(
        &fx.direct("127.0.0.1", SslMode::VerifyCa, true),
        Credentials::default(),
    );
    test(&ip_ca).await.unwrap();
    let ip_full = fx.target(
        &fx.direct("127.0.0.1", SslMode::VerifyFull, true),
        Credentials::default(),
    );
    assert!(matches!(
        test(&ip_full).await,
        Err(SessionError::Connect(_))
    ));

    // Without the CA the system roots don't trust the server; require doesn't verify.
    let no_ca = fx.target(
        &fx.direct("localhost", SslMode::VerifyCa, false),
        Credentials::default(),
    );
    assert!(matches!(test(&no_ca).await, Err(SessionError::Connect(_))));
    let mut session = Session::open(fx.target(
        &fx.direct("localhost", SslMode::Require, false),
        Credentials::default(),
    ))
    .await
    .unwrap();
    assert_eq!(uses_ssl(&mut session).await, "true");
    session.close().await;

    // disable connects in plain text.
    let mut session = Session::open(fx.target(
        &fx.direct("localhost", SslMode::Disable, false),
        Credentials::default(),
    ))
    .await
    .unwrap();
    assert_eq!(uses_ssl(&mut session).await, "false");
    session.close().await;
}

fn ssh_password(password: &str) -> Credentials {
    Credentials {
        ssh_password: Some(password.into()),
        ..Credentials::default()
    }
}

async fn tunnel_with_password(fx: &Fixture) {
    let input = fx.tunneled(SshAuth::Password);

    // Missing and wrong passwords.
    let err = test(&fx.target(&input, Credentials::default()))
        .await
        .unwrap_err();
    assert!(
        matches!(err, SessionError::Ssh(SshError::PasswordRequired)),
        "{err}"
    );

    let target = fx.target(&input, ssh_password(SSH_PASSWORD));
    let mut session = open_eventually(target).await;

    let err = test(&fx.target(&input, ssh_password("wrong")))
        .await
        .unwrap_err();
    assert!(
        matches!(err, SessionError::Ssh(SshError::AuthFailed(_))),
        "{err}"
    );

    // verify-full holds through the tunnel: the driver still checks the database's own name.
    assert_eq!(uses_ssl(&mut session).await, "true");
    assert!(session.info().server_version.starts_with("PostgreSQL 17"));

    // The bastion was trusted on first use.
    let known = std::fs::read_to_string(&fx.env().app_known_hosts).unwrap();
    assert!(
        known.starts_with(&format!("[127.0.0.1]:{} ", fx.ssh_port)),
        "{known}"
    );

    // A dropped database connection reconnects through the same tunnel.
    session.drop_connection().await;
    assert_eq!(session.ensure_alive().await.unwrap(), Liveness::Reconnected);
    assert_eq!(uses_ssl(&mut session).await, "true");

    // Closing the session closes the tunnel and removes its socket.
    #[cfg(unix)]
    let socket_dir = match session.tunnel_endpoint().unwrap() {
        Endpoint::UnixDir(dir) => dir.clone(),
        other => panic!("{other:?}"),
    };
    session.close().await;
    #[cfg(unix)]
    assert!(!socket_dir.exists());

    // A forward the bastion can't make is reported by the tunnel, not as a database error.
    let mut nowhere = input.clone();
    nowhere.host = Some("no-such-host.invalid".into());
    let err = test(&fx.target(&nowhere, ssh_password(SSH_PASSWORD)))
        .await
        .unwrap_err();
    assert!(
        matches!(err, SessionError::Ssh(SshError::Forward { .. })),
        "{err}"
    );
}

async fn tunnel_with_keys(fx: &Fixture) {
    let Some(keys) = &fx.keys else {
        eprintln!("skipping private key tunnel tests: ssh-keygen is not available");
        return;
    };

    let input = fx.tunneled(SshAuth::PrivateKey {
        key_path: keys.protected.display().to_string(),
    });

    let err = test(&fx.target(&input, Credentials::default()))
        .await
        .unwrap_err();
    assert!(
        matches!(err, SessionError::Ssh(SshError::PassphraseRequired(_))),
        "{err}"
    );

    let wrong = Credentials {
        ssh_passphrase: Some("wrong".into()),
        ..Credentials::default()
    };
    let err = test(&fx.target(&input, wrong)).await.unwrap_err();
    assert!(
        matches!(err, SessionError::Ssh(SshError::Key { .. })),
        "{err}"
    );

    let right = Credentials {
        ssh_passphrase: Some(PASSPHRASE.into()),
        ..Credentials::default()
    };
    let result = test(&fx.target(&input, right)).await.unwrap();
    assert!(result.server_version.starts_with("PostgreSQL 17"));

    let plain = fx.tunneled(SshAuth::PrivateKey {
        key_path: keys.plain.display().to_string(),
    });
    test(&fx.target(&plain, Credentials::default()))
        .await
        .unwrap();
}

async fn tunnel_with_agent(fx: &Fixture) {
    let Some(keys) = &fx.keys else {
        return;
    };
    let Some(agent) = Agent::start(fx.dir.path(), &keys.plain) else {
        eprintln!("skipping SSH agent tunnel test: ssh-agent is not available");
        return;
    };

    let input = fx.tunneled(SshAuth::Agent);
    let mut env = fx.env();
    env.agent_socket = Some(agent.socket.clone());
    let credentials = Credentials::password(PG_PASSWORD);
    let target = ConnectTarget::new(Uuid::new_v4(), &input, &credentials, &env).unwrap();
    test(&target).await.unwrap();
}

async fn tunnel_from_ssh_config(fx: &Fixture) {
    let Some(keys) = &fx.keys else {
        return;
    };

    let ssh_dir = fx.env().ssh_dir.unwrap();
    std::fs::create_dir_all(&ssh_dir).unwrap();
    std::fs::write(
        ssh_dir.join("config"),
        format!(
            "Host db-bastion\n  HostName 127.0.0.1\n  Port {}\n  User {SSH_USER}\n  IdentityFile \"{}\"\n",
            fx.ssh_port,
            keys.plain.display()
        ),
    )
    .unwrap();

    // Only the alias is set on the connection; the rest comes from the config.
    let mut input = fx.tunneled(SshAuth::PrivateKey {
        key_path: String::new(),
    });
    input.ssh = Some(SshTunnel {
        host: "db-bastion".into(),
        port: None,
        user: None,
        auth: SshAuth::PrivateKey {
            key_path: String::new(),
        },
    });
    test(&fx.target(&input, Credentials::default()))
        .await
        .unwrap();

    std::fs::write(
        ssh_dir.join("config"),
        "Host db-bastion\n  ProxyJump elsewhere\n",
    )
    .unwrap();
    let err = test(&fx.target(&input, Credentials::default()))
        .await
        .unwrap_err();
    assert!(
        matches!(err, SessionError::Ssh(SshError::Unsupported(_))),
        "{err}"
    );
}
