//! SSH tunnels to databases behind a bastion host.
//!
//! A [`Tunnel`] logs in to the bastion with russh and listens locally; every local connection becomes a
//! `direct-tcpip` channel to the database. On macOS and Linux it listens on a Unix socket in a private
//! directory, so the PostgreSQL driver still verifies TLS against the real database host name
//! (`verify-full`). Windows has no Unix sockets in the driver, so it listens on `127.0.0.1`.
//!
//! Host keys: a key in `~/.ssh/known_hosts` or the app's own `known_hosts` must match. An unknown host
//! is trusted on first use and remembered in the app's file (OpenSSH's `accept-new`); a changed key
//! is refused.

mod config;
mod host_keys;

#[cfg(test)]
mod tests;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::agent::client::AgentClient;
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, Disconnect};
use tokio::task::JoinHandle;

use crate::connections::{SshAuth, SshTunnel};

#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("SSH config: {0}")]
    Config(String),
    #[error("{0} in ~/.ssh/config is not supported yet")]
    Unsupported(String),
    #[error("SSH user is required")]
    UserRequired,
    #[error("SSH password is required")]
    PasswordRequired,
    #[error("the private key {0} needs a passphrase")]
    PassphraseRequired(String),
    #[error("wrong passphrase for the private key {0}")]
    WrongPassphrase(String),
    #[error("could not read private key {path}: {reason}")]
    Key { path: String, reason: String },
    #[error("no private key file; choose one or set IdentityFile in ~/.ssh/config")]
    NoKeyFile,
    #[error("could not use the SSH agent: {0}")]
    Agent(String),
    #[error("could not reach SSH host {host}:{port}: {reason}")]
    Unreachable {
        host: String,
        port: u16,
        reason: String,
    },
    #[error(
        "the host key of {host} has changed (known_hosts: {file} line {line}); refusing to connect"
    )]
    HostKeyChanged {
        host: String,
        file: String,
        line: usize,
    },
    #[error("could not check the host key: {0}")]
    HostKeyStore(String),
    #[error("SSH authentication failed: {0}")]
    AuthFailed(String),
    #[error("the SSH server would not forward to {host}:{port}: {reason}")]
    Forward {
        host: String,
        port: u16,
        reason: String,
    },
    #[error("could not listen for the tunnel: {0}")]
    Listen(String),
    #[error("SSH error: {0}")]
    Protocol(#[from] russh::Error),
}

/// Where the tunnel and SSH settings live on this machine.
#[derive(Clone, Debug)]
pub struct SshEnv {
    /// The app's own known_hosts file, for hosts trusted on first use.
    pub(crate) app_known_hosts: PathBuf,
    /// `~/.ssh`: `config` and `known_hosts`. `None` when there is no home directory.
    pub(crate) ssh_dir: Option<PathBuf>,
    /// The agent socket; `None` uses `SSH_AUTH_SOCK` (Pageant or the OpenSSH agent on Windows).
    pub(crate) agent_socket: Option<PathBuf>,
}

impl SshEnv {
    /// Keeps the app's known_hosts in `data_dir` and reads `~/.ssh`.
    pub fn new(data_dir: &Path) -> Self {
        Self {
            app_known_hosts: data_dir.join("known_hosts"),
            ssh_dir: home_dir().map(|h| h.join(".ssh")),
            agent_socket: None,
        }
    }
}

/// A connection's tunnel settings plus its secrets. Resolved against `~/.ssh/config` on every open, so
/// edits there apply on the next connect.
#[derive(Clone)]
pub struct TunnelConfig {
    pub(crate) tunnel: SshTunnel,
    pub(crate) password: Option<String>,
    pub(crate) passphrase: Option<String>,
    pub(crate) env: SshEnv,
    /// The database, as seen from the bastion.
    pub(crate) forward_host: String,
    pub(crate) forward_port: u16,
}

impl fmt::Debug for TunnelConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TunnelConfig")
            .field("tunnel", &self.tunnel)
            .field("password", &self.password.as_ref().map(|_| "…"))
            .field("passphrase", &self.passphrase.as_ref().map(|_| "…"))
            .field("env", &self.env)
            .field("forward_host", &self.forward_host)
            .field("forward_port", &self.forward_port)
            .finish()
    }
}

/// Where the database driver connects to reach the tunnel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Endpoint {
    Tcp(std::net::SocketAddr),
    /// A directory holding the PostgreSQL-style socket `.s.PGSQL.<database port>`.
    #[cfg(unix)]
    UnixDir(PathBuf),
}

/// An open tunnel. Closed by [`Tunnel::close`]; dropping it also stops it, without a clean SSH goodbye.
pub struct Tunnel {
    handle: Arc<Handle<Client>>,
    endpoint: Endpoint,
    accept_task: JoinHandle<()>,
    #[cfg(unix)]
    socket_dir: Option<PathBuf>,
}

impl fmt::Debug for Tunnel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Tunnel")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl Tunnel {
    /// Logs in to the bastion, checks that it forwards to the database, and starts listening.
    pub async fn open(config: &TunnelConfig) -> Result<Self, SshError> {
        let target = ResolvedHost::resolve(config)?;
        let mut handle = login(&target, config).await?;
        authenticate(&mut handle, &target, config).await?;

        // Open the first channel now, so a refused forward is reported here and not as a vague
        // database error later. The first local connection uses it.
        let first = handle
            .channel_open_direct_tcpip(
                config.forward_host.clone(),
                config.forward_port.into(),
                "127.0.0.1",
                0,
            )
            .await
            .map_err(|e| SshError::Forward {
                host: config.forward_host.clone(),
                port: config.forward_port,
                reason: e.to_string(),
            })?;

        let handle = Arc::new(handle);
        let (listener, endpoint, socket_dir) = Listener::bind(config.forward_port).await?;
        let accept_task = tokio::spawn(accept_loop(
            listener,
            handle.clone(),
            first,
            config.forward_host.clone(),
            config.forward_port,
        ));

        #[cfg(not(unix))]
        let _ = socket_dir;

        Ok(Self {
            handle,
            endpoint,
            accept_task,
            #[cfg(unix)]
            socket_dir,
        })
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// False once the SSH connection dropped; the session then opens a new tunnel.
    pub fn is_open(&self) -> bool {
        !self.handle.is_closed() && !self.accept_task.is_finished()
    }

    pub async fn close(self) {
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.accept_task.abort();
        #[cfg(unix)]
        if let Some(dir) = &self.socket_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// The bastion after applying `~/.ssh/config`.
#[derive(Debug)]
struct ResolvedHost {
    host: String,
    port: u16,
    user: String,
    auth: Auth,
}

#[derive(Debug)]
enum Auth {
    Password,
    Keys(Vec<PathBuf>),
    Agent,
}

/// Tried in order when a key login has no key file and the config names none.
const DEFAULT_KEYS: [&str; 3] = ["id_ed25519", "id_ecdsa", "id_rsa"];

impl ResolvedHost {
    /// Fields set on the connection win over `~/.ssh/config`, like options on the `ssh` command line.
    fn resolve(config: &TunnelConfig) -> Result<Self, SshError> {
        let tunnel = &config.tunnel;
        let alias = tunnel.host.trim();
        let host_config = match &config.env.ssh_dir {
            Some(dir) => config::resolve(alias, dir)?,
            None => config::HostConfig::default(),
        };

        if let Some(proxy) = host_config.proxy {
            let name = if proxy == "proxyjump" {
                "ProxyJump"
            } else {
                "ProxyCommand"
            };
            return Err(SshError::Unsupported(name.into()));
        }

        let user = tunnel
            .user
            .clone()
            .filter(|u| !u.trim().is_empty())
            .or(host_config.user)
            .or_else(local_user)
            .ok_or(SshError::UserRequired)?;

        let auth = match &tunnel.auth {
            SshAuth::Password => Auth::Password,
            SshAuth::Agent => Auth::Agent,
            SshAuth::PrivateKey { key_path } if !key_path.trim().is_empty() => {
                Auth::Keys(vec![expand_home(key_path.trim())])
            }
            SshAuth::PrivateKey { .. } if !host_config.identity_files.is_empty() => {
                Auth::Keys(host_config.identity_files)
            }
            SshAuth::PrivateKey { .. } => {
                let keys: Vec<PathBuf> = config
                    .env
                    .ssh_dir
                    .iter()
                    .flat_map(|dir| DEFAULT_KEYS.iter().map(move |k| dir.join(k)))
                    .filter(|p| p.is_file())
                    .collect();
                if keys.is_empty() {
                    return Err(SshError::NoKeyFile);
                }
                Auth::Keys(keys)
            }
        };

        Ok(Self {
            host: host_config.hostname.unwrap_or_else(|| alias.to_string()),
            port: tunnel.port.or(host_config.port).unwrap_or(22),
            user,
            auth,
        })
    }
}

async fn login(target: &ResolvedHost, config: &TunnelConfig) -> Result<Handle<Client>, SshError> {
    let unreachable = |reason: String| SshError::Unreachable {
        host: target.host.clone(),
        port: target.port,
        reason,
    };

    let stream = tokio::net::TcpStream::connect((target.host.as_str(), target.port))
        .await
        .map_err(|e| unreachable(e.to_string()))?;

    let ssh_config = client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        nodelay: true,
        ..Default::default()
    };
    let client = Client {
        host: target.host.clone(),
        port: target.port,
        env: config.env.clone(),
    };

    client::connect_stream(Arc::new(ssh_config), stream, client).await
}

async fn authenticate(
    handle: &mut Handle<Client>,
    target: &ResolvedHost,
    config: &TunnelConfig,
) -> Result<(), SshError> {
    let user = target.user.as_str();
    let succeeded = match &target.auth {
        Auth::Password => {
            let password = config
                .password
                .as_deref()
                .ok_or(SshError::PasswordRequired)?;
            handle
                .authenticate_password(user, password)
                .await?
                .success()
        }
        Auth::Keys(paths) => {
            let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
            let mut succeeded = false;
            for path in paths {
                let key = load_key(path, config.passphrase.as_deref())?;
                let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);
                if handle.authenticate_publickey(user, key).await?.success() {
                    succeeded = true;
                    break;
                }
            }
            succeeded
        }
        Auth::Agent => authenticate_with_agent(handle, user, &config.env).await?,
    };

    if succeeded {
        Ok(())
    } else {
        let method = match target.auth {
            Auth::Password => "password",
            Auth::Keys(_) => "private key",
            Auth::Agent => "SSH agent keys",
        };
        Err(SshError::AuthFailed(format!(
            "{user}@{} did not accept the {method}",
            target.host
        )))
    }
}

fn load_key(path: &Path, passphrase: Option<&str>) -> Result<russh::keys::PrivateKey, SshError> {
    let shown = path.display().to_string();
    russh::keys::load_secret_key(path, passphrase).map_err(|e| match e {
        russh::keys::Error::KeyIsEncrypted => SshError::PassphraseRequired(shown),
        e if passphrase.is_some() && is_decrypt_error(&e) => SshError::WrongPassphrase(shown),
        e => SshError::Key {
            path: shown,
            reason: e.to_string(),
        },
    })
}

/// A wrong passphrase shows up as a decryption or integrity failure, depending on the key format.
fn is_decrypt_error(e: &russh::keys::Error) -> bool {
    let text = e.to_string().to_lowercase();
    ["crypto", "decrypt", "cipher", "padding", "checkint", "mac"]
        .iter()
        .any(|word| text.contains(word))
}

type AgentStream = Box<dyn russh::keys::agent::client::AgentStream + Send + Unpin>;

async fn connect_agent(env: &SshEnv) -> Result<AgentClient<AgentStream>, SshError> {
    let agent_error = |e: russh::keys::Error| SshError::Agent(e.to_string());

    #[cfg(unix)]
    {
        let client = match &env.agent_socket {
            Some(path) => AgentClient::connect_uds(path).await,
            None => AgentClient::connect_env().await,
        }
        .map_err(agent_error)?;
        Ok(AgentClient::connect(client.into_inner()))
    }

    #[cfg(windows)]
    {
        if let Some(path) = &env.agent_socket {
            let client = AgentClient::connect_named_pipe(path)
                .await
                .map_err(agent_error)?;
            return Ok(AgentClient::connect(client.into_inner()));
        }

        // Pageant first, then the Windows OpenSSH agent.
        match AgentClient::connect_pageant().await {
            Ok(client) => Ok(AgentClient::connect(client.into_inner())),
            Err(_) => {
                let client = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
                    .await
                    .map_err(|e| {
                        SshError::Agent(format!(
                            "neither Pageant nor the OpenSSH agent is running ({e})"
                        ))
                    })?;
                Ok(AgentClient::connect(client.into_inner()))
            }
        }
    }
}

async fn authenticate_with_agent(
    handle: &mut Handle<Client>,
    user: &str,
    env: &SshEnv,
) -> Result<bool, SshError> {
    let mut agent = connect_agent(env).await?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SshError::Agent(e.to_string()))?;
    if identities.is_empty() {
        return Err(SshError::Agent("the agent has no keys".into()));
    }

    let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
    for identity in identities {
        let key = identity.public_key().into_owned();
        let result = handle
            .authenticate_publickey_with(user, key, hash_alg, &mut agent)
            .await
            .map_err(|e| SshError::Agent(e.to_string()))?;
        if result.success() {
            return Ok(true);
        }
    }

    Ok(false)
}

/// The russh client handler; its only job is checking the host key.
struct Client {
    host: String,
    port: u16,
    env: SshEnv,
}

impl client::Handler for Client {
    type Error = SshError;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, SshError> {
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                russh::keys::PublicKey::new(cert.public_key().clone(), "")
            }
        };

        host_keys::verify(&self.host, self.port, &key, &self.env)?;
        Ok(true)
    }
}

enum Listener {
    #[cfg(not(unix))]
    Tcp(tokio::net::TcpListener),
    #[cfg(unix)]
    Unix(tokio::net::UnixListener),
}

enum LocalStream {
    #[cfg(not(unix))]
    Tcp(tokio::net::TcpStream),
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
}

impl Listener {
    /// A Unix socket in a new private directory on macOS and Linux; `127.0.0.1` elsewhere.
    async fn bind(forward_port: u16) -> Result<(Self, Endpoint, Option<PathBuf>), SshError> {
        let listen_error = |e: std::io::Error| SshError::Listen(e.to_string());

        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;

            let id = uuid::Uuid::new_v4().simple().to_string();
            let dir = std::env::temp_dir().join(format!("dbrief-{}", &id[..12]));
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&dir)
                .map_err(listen_error)?;

            // Named the way PostgreSQL clients look for a server socket.
            let path = dir.join(format!(".s.PGSQL.{forward_port}"));
            match tokio::net::UnixListener::bind(&path) {
                Ok(listener) => Ok((
                    Self::Unix(listener),
                    Endpoint::UnixDir(dir.clone()),
                    Some(dir),
                )),
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&dir);
                    Err(listen_error(e))
                }
            }
        }

        #[cfg(not(unix))]
        {
            let _ = forward_port;
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(listen_error)?;
            let addr = listener.local_addr().map_err(listen_error)?;
            Ok((Self::Tcp(listener), Endpoint::Tcp(addr), None))
        }
    }

    async fn accept(&self) -> std::io::Result<LocalStream> {
        match self {
            #[cfg(not(unix))]
            Self::Tcp(listener) => {
                let (stream, _) = listener.accept().await?;
                stream.set_nodelay(true)?;
                Ok(LocalStream::Tcp(stream))
            }
            #[cfg(unix)]
            Self::Unix(listener) => Ok(LocalStream::Unix(listener.accept().await?.0)),
        }
    }
}

async fn accept_loop(
    listener: Listener,
    handle: Arc<Handle<Client>>,
    first: Channel<client::Msg>,
    host: String,
    port: u16,
) {
    let mut first = Some(first);
    while let Ok(local) = listener.accept().await {
        let channel = match first.take() {
            Some(channel) => channel,
            None => match handle
                .channel_open_direct_tcpip(host.clone(), port.into(), "127.0.0.1", 0)
                .await
            {
                Ok(channel) => channel,
                // Dropping the local stream tells the driver the connection failed.
                Err(_) => continue,
            },
        };

        tokio::spawn(async move {
            let mut remote = channel.into_stream();
            let _ = match local {
                #[cfg(not(unix))]
                LocalStream::Tcp(mut s) => tokio::io::copy_bidirectional(&mut s, &mut remote).await,
                #[cfg(unix)]
                LocalStream::Unix(mut s) => {
                    tokio::io::copy_bidirectional(&mut s, &mut remote).await
                }
            };
        });
    }
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::home_dir().filter(|h| !h.as_os_str().is_empty())
}

fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix('~'), home_dir()) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            home.join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(path),
    }
}

/// The local account name, the default SSH user as in OpenSSH.
fn local_user() -> Option<String> {
    ["USER", "USERNAME"]
        .iter()
        .find_map(|var| std::env::var(var).ok())
        .filter(|u| !u.is_empty())
}
