//! What a session connects to.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use uuid::Uuid;

use super::SessionError;
use crate::connections::{AccessLevel, ConnectionInput, Engine};
use crate::engine::{self, Connector};
use crate::ssh::{SshEnv, TunnelConfig};

/// Used when the connection has no connect timeout of its own.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Secrets for connecting, from the credential store or a prompt. Never part of the connection.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Credentials {
    pub password: Option<String>,
    pub ssh_password: Option<String>,
    pub ssh_passphrase: Option<String>,
}

impl Credentials {
    pub fn password(password: impl Into<String>) -> Self {
        Self {
            password: Some(password.into()),
            ..Self::default()
        }
    }
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let shown = |secret: &Option<String>| secret.as_ref().map(|_| "…");
        f.debug_struct("Credentials")
            .field("password", &shown(&self.password))
            .field("ssh_password", &shown(&self.ssh_password))
            .field("ssh_passphrase", &shown(&self.ssh_passphrase))
            .finish()
    }
}

/// Everything needed to open (and reopen) a session for one connection. The access level is
/// captured here, so a session keeps the level it was opened with even if the connection changes.
#[derive(Clone, Debug)]
pub struct ConnectTarget {
    pub connection_id: Uuid,
    pub engine: Engine,
    pub access_level: AccessLevel,
    pub(super) connector: Arc<dyn Connector>,
    pub(super) ssh: Option<TunnelConfig>,
    pub(super) connect_timeout: Duration,
    pub(super) startup_sql: Option<String>,
}

impl ConnectTarget {
    pub fn new(
        connection_id: Uuid,
        input: &ConnectionInput,
        credentials: &Credentials,
        ssh_env: &SshEnv,
    ) -> Result<Self, SessionError> {
        input
            .validate()
            .map_err(|e| SessionError::Invalid(e.to_string()))?;

        // SQLite files are local; a tunnel only applies to servers.
        let ssh = match (&input.ssh, input.engine) {
            (Some(tunnel), Engine::Postgres) => Some(TunnelConfig {
                tunnel: tunnel.clone(),
                password: credentials.ssh_password.clone(),
                passphrase: credentials.ssh_passphrase.clone(),
                env: ssh_env.clone(),
                forward_host: input.host.clone().unwrap_or_default().trim().to_string(),
                forward_port: input.port.unwrap_or(5432),
            }),
            _ => None,
        };

        Ok(Self {
            connection_id,
            engine: input.engine,
            access_level: input.access_level,
            connector: engine::connector(input, credentials.password.as_deref()),
            ssh,
            connect_timeout: input
                .connect_timeout_s
                .map_or(DEFAULT_CONNECT_TIMEOUT, |s| Duration::from_secs(s.into())),
            startup_sql: input
                .startup_sql
                .clone()
                .filter(|sql| !sql.trim().is_empty()),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::connections::{SshAuth, SshTunnel};

    #[test]
    fn rejects_invalid_connections_and_defaults_the_timeout() {
        let env = SshEnv::new(Path::new("unused"));
        let input = ConnectionInput::new("pg", Engine::Postgres, AccessLevel::Rw);
        assert!(matches!(
            ConnectTarget::new(Uuid::new_v4(), &input, &Credentials::default(), &env),
            Err(SessionError::Invalid(_))
        ));

        let mut lite = ConnectionInput::new("f", Engine::Sqlite, AccessLevel::Ro);
        lite.file_path = Some("/tmp/x.db".into());
        lite.startup_sql = Some("   ".into());
        let target =
            ConnectTarget::new(Uuid::new_v4(), &lite, &Credentials::default(), &env).unwrap();
        assert_eq!(target.connect_timeout, DEFAULT_CONNECT_TIMEOUT);
        assert_eq!(target.startup_sql, None);
        assert_eq!(target.access_level, AccessLevel::Ro);
    }

    #[test]
    fn tunnels_forward_to_the_server_and_hide_secrets() {
        let env = SshEnv::new(Path::new("unused"));
        let mut input = ConnectionInput::new("pg", Engine::Postgres, AccessLevel::Rw);
        input.host = Some(" db.internal ".into());
        input.ssh = Some(SshTunnel {
            host: "bastion".into(),
            port: None,
            user: None,
            auth: SshAuth::Password,
        });
        let credentials = Credentials {
            password: Some("db-secret".into()),
            ssh_password: Some("ssh-secret".into()),
            ssh_passphrase: None,
        };

        let target = ConnectTarget::new(Uuid::new_v4(), &input, &credentials, &env).unwrap();
        let ssh = target.ssh.as_ref().unwrap();
        assert_eq!(
            (ssh.forward_host.as_str(), ssh.forward_port),
            ("db.internal", 5432)
        );
        assert_eq!(ssh.password.as_deref(), Some("ssh-secret"));

        let shown = format!("{target:?} {credentials:?}");
        assert!(!shown.contains("secret"), "{shown}");
    }
}
