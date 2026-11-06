//! Queries the app builds itself (schema loading, structure, table pages, counts), read whole on the
//! session. They follow the same rules as user statements: cancel, query timeout, and reconnecting
//! when the connection was lost outside a transaction.

use std::sync::atomic::Ordering;

use super::run::{canceled, connection_lost};
use super::{Session, SessionError};
use crate::query::{QueryError, Values};

impl Session {
    /// Runs a query the app built and returns all its rows. Only for queries whose size is bounded.
    pub async fn fetch_values(&mut self, sql: &str) -> Result<Values, SessionError> {
        self.finish_open_result().await;
        self.ensure_connected().await?;

        match self.fetch_once(sql).await {
            Err(SessionError::ConnectionLost(_)) if !self.in_transaction => {
                self.ensure_connected().await?;
                self.fetch_once(sql).await
            }
            Err(SessionError::ConnectionLost(_)) => {
                self.in_transaction = false;
                self.transaction_lost = true;
                Err(SessionError::TransactionLost)
            }
            other => other,
        }
    }

    async fn fetch_once(&mut self, sql: &str) -> Result<Values, SessionError> {
        let Some(conn) = self.conn.as_mut() else {
            return Err(SessionError::NotFound(self.info.id));
        };
        self.cancel.reset();

        let timer = self.target.query_timeout.map(|timeout| {
            let cancel = self.cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(timeout).await;
                cancel.timed_out.store(true, Ordering::SeqCst);
                let _ = cancel.cancel().await;
            })
        });
        let result = conn.fetch_values(sql).await;
        if let Some(timer) = timer {
            timer.abort();
        }

        match result {
            Ok(values) => Ok(values),
            Err(e) if connection_lost(&e) => {
                if let Some(conn) = self.conn.take() {
                    conn.close().await;
                }
                Err(SessionError::ConnectionLost(e.to_string()))
            }
            Err(e) => {
                let error = QueryError::from_sqlx(&e);
                if canceled(&error) {
                    let limit = self
                        .target
                        .query_timeout
                        .filter(|_| self.cancel.timed_out.load(Ordering::SeqCst));
                    return Err(match limit {
                        Some(limit) => SessionError::QueryTimeout(limit),
                        None => SessionError::Canceled,
                    });
                }
                Err(SessionError::Query(error))
            }
        }
    }
}
