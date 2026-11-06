//! What a session connects to.

use std::sync::Arc;
use std::time::Duration;

use uuid::Uuid;

use super::SessionError;
use crate::connections::{AccessLevel, ConnectionInput, Engine};
use crate::engine::{self, Connector};

/// Used when the connection has no connect timeout of its own.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Everything needed to open (and reopen) a session for one connection. The access level is
/// captured here, so a session keeps the level it was opened with even if the connection changes.
#[derive(Clone, Debug)]
pub struct ConnectTarget {
    pub connection_id: Uuid,
    pub engine: Engine,
    pub access_level: AccessLevel,
    pub(super) connector: Arc<dyn Connector>,
    pub(super) connect_timeout: Duration,
    pub(super) startup_sql: Option<String>,
}

impl ConnectTarget {
    /// `password` comes from the credential store or a prompt; it is never part of `input`.
    pub fn new(
        connection_id: Uuid,
        input: &ConnectionInput,
        password: Option<&str>,
    ) -> Result<Self, SessionError> {
        input
            .validate()
            .map_err(|e| SessionError::Invalid(e.to_string()))?;

        Ok(Self {
            connection_id,
            engine: input.engine,
            access_level: input.access_level,
            connector: engine::connector(input, password),
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
    use super::*;

    #[test]
    fn rejects_invalid_connections_and_defaults_the_timeout() {
        let input = ConnectionInput::new("pg", Engine::Postgres, AccessLevel::Rw);
        assert!(matches!(
            ConnectTarget::new(Uuid::new_v4(), &input, None),
            Err(SessionError::Invalid(_))
        ));

        let mut lite = ConnectionInput::new("f", Engine::Sqlite, AccessLevel::Ro);
        lite.file_path = Some("/tmp/x.db".into());
        lite.startup_sql = Some("   ".into());
        let target = ConnectTarget::new(Uuid::new_v4(), &lite, None).unwrap();
        assert_eq!(target.connect_timeout, DEFAULT_CONNECT_TIMEOUT);
        assert_eq!(target.startup_sql, None);
        assert_eq!(target.access_level, AccessLevel::Ro);
    }
}
