//! Database sessions for user connections. Each session is one dedicated database connection with its
//! own transaction state; the app opens one per tab (one per connection until tabs exist). A session
//! with an SSH tunnel owns the tunnel: it opens with the session, is reopened on reconnect if it
//! dropped, and closes with the session.

mod target;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

pub use target::{ConnectTarget, Credentials, DEFAULT_CONNECT_TIMEOUT};

use crate::connections::{AccessLevel, Engine};
use crate::engine::EngineConnection;
use crate::ssh::{SshError, Tunnel};

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("{0}")]
    Invalid(String),
    #[error("could not connect: {0}")]
    Connect(String),
    /// The server rejected the password, or needed one and none was given.
    #[error("{0}")]
    PasswordRejected(String),
    #[error("timed out connecting after {} s", .0.as_secs())]
    Timeout(Duration),
    #[error("SSH tunnel: {0}")]
    Ssh(#[from] SshError),
    #[error("startup SQL failed: {0}")]
    StartupSql(String),
    #[error("the connection was lost during an open transaction; its changes were rolled back")]
    TransactionLost,
    #[error("session {0} is not open")]
    NotFound(Uuid),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

/// What the UI shows for an open session (status bar: connection, access level, server version).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SessionInfo {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub engine: Engine,
    pub access_level: AccessLevel,
    pub server_version: String,
}

/// Result of a connection test. `latency_ms` is one round trip after connecting.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TestResult {
    pub server_version: String,
    pub latency_ms: f64,
}

/// Opens a throwaway connection, reports the server version and round-trip latency, and closes it.
pub async fn test(target: &ConnectTarget) -> Result<TestResult, SessionError> {
    let mut tunnel = None;
    let result = test_with(target, &mut tunnel).await;
    if let Some(tunnel) = tunnel {
        tunnel.close().await;
    }

    result
}

async fn test_with(
    target: &ConnectTarget,
    tunnel: &mut Option<Tunnel>,
) -> Result<TestResult, SessionError> {
    let mut conn = connect(target, tunnel).await?;
    let measured = async {
        let server_version = conn.server_version().await?;
        let start = Instant::now();
        conn.ping().await?;
        let latency_ms = (start.elapsed().as_secs_f64() * 10_000.0).round() / 10.0;
        Ok::<_, sqlx::Error>(TestResult {
            server_version,
            latency_ms,
        })
    }
    .await;

    conn.close().await;
    Ok(measured?)
}

/// Opens the tunnel if the target has one and it isn't open, connects, and runs the startup SQL. The
/// connect timeout covers the tunnel too.
async fn connect(
    target: &ConnectTarget,
    tunnel: &mut Option<Tunnel>,
) -> Result<Box<dyn EngineConnection>, SessionError> {
    let attempt = async {
        let via = match &target.ssh {
            None => None,
            Some(config) => {
                if !tunnel.as_ref().is_some_and(Tunnel::is_open) {
                    if let Some(old) = tunnel.take() {
                        old.close().await;
                    }
                    *tunnel = Some(Tunnel::open(config).await?);
                }
                tunnel.as_ref().map(Tunnel::endpoint)
            }
        };

        target.connector.connect(via).await.map_err(connect_error)
    };

    let mut conn = tokio::time::timeout(target.connect_timeout, attempt)
        .await
        .map_err(|_| SessionError::Timeout(target.connect_timeout))??;

    if let Some(sql) = &target.startup_sql
        && let Err(e) = conn.execute(sql).await
    {
        conn.close().await;
        return Err(SessionError::StartupSql(e.to_string()));
    }

    Ok(conn)
}

/// SQLSTATE `invalid_password`: PostgreSQL's answer to a wrong or missing password.
const INVALID_PASSWORD: &str = "28P01";

fn connect_error(e: sqlx::Error) -> SessionError {
    if let sqlx::Error::Database(db) = &e
        && db.code().as_deref() == Some(INVALID_PASSWORD)
    {
        return SessionError::PasswordRejected(db.message().to_string());
    }

    SessionError::Connect(e.to_string())
}

/// Whether [`Session::ensure_alive`] found the connection working or had to reconnect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Liveness {
    Alive,
    Reconnected,
}

/// One open database connection and its transaction state.
///
/// When the connection drops, [`Session::ensure_alive`] reconnects on its own if no transaction was
/// open. If one was, the session reports [`SessionError::TransactionLost`] until the user
/// acknowledges it with [`Session::reconnect_after_lost_transaction`].
pub struct Session {
    info: SessionInfo,
    target: ConnectTarget,
    tunnel: Option<Tunnel>,
    conn: Option<Box<dyn EngineConnection>>,
    in_transaction: bool,
    transaction_lost: bool,
}

impl Session {
    pub async fn open(target: ConnectTarget) -> Result<Self, SessionError> {
        let mut tunnel = None;
        let opened = async {
            let mut conn = connect(&target, &mut tunnel).await?;
            match conn.server_version().await {
                Ok(version) => Ok((conn, version)),
                Err(e) => {
                    conn.close().await;
                    Err(SessionError::from(e))
                }
            }
        }
        .await;

        let (conn, server_version) = match opened {
            Ok(opened) => opened,
            Err(e) => {
                if let Some(tunnel) = tunnel {
                    tunnel.close().await;
                }
                return Err(e);
            }
        };

        Ok(Self {
            info: SessionInfo {
                id: Uuid::new_v4(),
                connection_id: target.connection_id,
                engine: target.engine,
                access_level: target.access_level,
                server_version,
            },
            target,
            tunnel,
            conn: Some(conn),
            in_transaction: false,
            transaction_lost: false,
        })
    }

    pub fn info(&self) -> &SessionInfo {
        &self.info
    }

    pub fn in_transaction(&self) -> bool {
        self.in_transaction
    }

    /// Set by whoever runs BEGIN / COMMIT / ROLLBACK on this session.
    pub fn set_in_transaction(&mut self, open: bool) {
        self.in_transaction = open;
    }

    /// Checks the connection, reconnecting when that's safe (see [`Session`]).
    pub async fn ensure_alive(&mut self) -> Result<Liveness, SessionError> {
        if self.transaction_lost {
            return Err(SessionError::TransactionLost);
        }

        if let Some(conn) = self.conn.as_mut()
            && conn.ping().await.is_ok()
        {
            return Ok(Liveness::Alive);
        }

        if let Some(conn) = self.conn.take() {
            conn.close().await;
        }

        if self.in_transaction {
            self.in_transaction = false;
            self.transaction_lost = true;
            return Err(SessionError::TransactionLost);
        }

        self.conn = Some(connect(&self.target, &mut self.tunnel).await?);
        Ok(Liveness::Reconnected)
    }

    /// Reconnects after the user acknowledged a lost transaction.
    pub async fn reconnect_after_lost_transaction(&mut self) -> Result<(), SessionError> {
        if let Some(conn) = self.conn.take() {
            conn.close().await;
        }

        self.conn = Some(connect(&self.target, &mut self.tunnel).await?);
        self.transaction_lost = false;
        Ok(())
    }

    /// Runs one or more statements, ignoring any rows.
    pub async fn execute(&mut self, sql: &str) -> Result<(), SessionError> {
        let conn = self
            .conn
            .as_mut()
            .ok_or(SessionError::NotFound(self.info.id))?;
        Ok(conn.execute(sql).await?)
    }

    pub async fn close(mut self) {
        self.close_all().await;
    }

    async fn close_all(&mut self) {
        if let Some(conn) = self.conn.take() {
            conn.close().await;
        }
        if let Some(tunnel) = self.tunnel.take() {
            tunnel.close().await;
        }
    }

    /// Where the database driver reaches this session's SSH tunnel.
    #[cfg(test)]
    pub(crate) fn tunnel_endpoint(&self) -> Option<&crate::ssh::Endpoint> {
        self.tunnel.as_ref().map(Tunnel::endpoint)
    }

    /// Simulates the network dropping the connection.
    #[cfg(test)]
    pub(crate) async fn drop_connection(&mut self) {
        if let Some(conn) = self.conn.take() {
            conn.close().await;
        }
    }

    /// The first column of the first row, as text.
    #[cfg(test)]
    pub(crate) async fn fetch_text(&mut self, sql: &str) -> Result<String, SessionError> {
        let conn = self
            .conn
            .as_mut()
            .ok_or(SessionError::NotFound(self.info.id))?;
        Ok(conn.fetch_text(sql).await?)
    }
}

/// All open sessions, by session id. Each session has its own lock, so sessions run in parallel.
#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<Uuid, Arc<Mutex<Session>>>>,
}

impl SessionManager {
    pub async fn open(&self, target: ConnectTarget) -> Result<SessionInfo, SessionError> {
        let session = Session::open(target).await?;
        let info = session.info().clone();
        self.sessions
            .lock()
            .await
            .insert(info.id, Arc::new(Mutex::new(session)));
        Ok(info)
    }

    pub async fn get(&self, id: Uuid) -> Result<Arc<Mutex<Session>>, SessionError> {
        self.sessions
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or(SessionError::NotFound(id))
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        let sessions: Vec<_> = self.sessions.lock().await.values().cloned().collect();
        let mut infos = Vec::with_capacity(sessions.len());
        for session in sessions {
            infos.push(session.lock().await.info().clone());
        }

        infos
    }

    pub async fn close(&self, id: Uuid) -> Result<(), SessionError> {
        let session = self
            .sessions
            .lock()
            .await
            .remove(&id)
            .ok_or(SessionError::NotFound(id))?;
        close_shared(session).await;
        Ok(())
    }

    /// Closes every session of a connection, e.g. when it is removed. Returns how many were closed.
    pub async fn close_connection(&self, connection_id: Uuid) -> usize {
        let mut removed = Vec::new();
        {
            let mut sessions = self.sessions.lock().await;
            let ids: Vec<Uuid> = sessions.keys().copied().collect();
            for id in ids {
                let belongs = sessions[&id].lock().await.info().connection_id == connection_id;
                if belongs && let Some(session) = sessions.remove(&id) {
                    removed.push(session);
                }
            }
        }

        let count = removed.len();
        for session in removed {
            close_shared(session).await;
        }

        count
    }
}

/// Closes a session that may still be borrowed elsewhere; waits for its lock first.
async fn close_shared(session: Arc<Mutex<Session>>) {
    session.lock().await.close_all().await;
}
