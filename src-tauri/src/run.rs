//! Running statements in a tab's session, paging results, cancelling, and transactions.
//!
//! A tab opens its session with the `connect` command and passes the session id here.

use dbrief_core::classify::StatementKind;
use dbrief_core::session::{
    MoreRows, RunError, RunOutput, SessionError, TransactionMode, TransactionStatement,
};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::AppState;

type Result<T> = std::result::Result<T, RunError>;

/// A session's transaction state, for the toolbar (mode, Commit / Roll back) and close prompts.
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct TransactionState {
    pub mode: TransactionMode,
    pub open: bool,
    pub statements: Vec<TransactionStatement>,
}

async fn session(
    state: &AppState,
    id: Uuid,
) -> Result<std::sync::Arc<tokio::sync::Mutex<dbrief_core::session::Session>>> {
    state.sessions.get(id).await.map_err(RunError::from)
}

/// Runs one statement and returns its first page of rows.
#[tauri::command]
#[specta::specta]
pub async fn run_statement(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: Uuid,
    sql: String,
    page_size: u32,
) -> Result<RunOutput> {
    let session = session(&state, session_id).await?;
    let mut session = session.lock().await;
    let output = session.run(&sql, page_size as usize).await?;
    // Committed DDL changes the schema. Inside a transaction, the background session can't see it
    // until the commit.
    if output.kind == StatementKind::Ddl && !output.in_transaction {
        crate::schema::refresh_later(&app, session.info().connection_id);
    }
    Ok(output)
}

/// Ends the session's transaction, then reloads the schema if the transaction ran DDL (a rollback
/// too: a user-typed `BEGIN` may have committed part of it already).
async fn end_transaction(
    app: &tauri::AppHandle,
    state: &AppState,
    session_id: Uuid,
    commit: bool,
) -> Result<()> {
    let session = session(state, session_id).await?;
    let mut session = session.lock().await;
    let ran_ddl = session
        .transaction_statements()
        .iter()
        .any(|s| s.kind == StatementKind::Ddl);
    let result = if commit {
        session.commit().await
    } else {
        session.rollback().await
    };
    if ran_ddl {
        crate::schema::refresh_later(app, session.info().connection_id);
    }
    Ok(result?)
}

/// The next page of the session's open result.
#[tauri::command]
#[specta::specta]
pub async fn fetch_more(state: State<'_, AppState>, session_id: Uuid) -> Result<MoreRows> {
    let session = session(&state, session_id).await?;
    let mut session = session.lock().await;
    Ok(session.fetch_more().await?)
}

#[tauri::command]
#[specta::specta]
pub async fn close_result(state: State<'_, AppState>, session_id: Uuid) -> Result<()> {
    let session = session(&state, session_id).await?;
    session.lock().await.close_result().await;
    Ok(())
}

/// Stops the session's running statement. Doesn't wait for the session's lock.
#[tauri::command]
#[specta::specta]
pub async fn cancel_statement(state: State<'_, AppState>, session_id: Uuid) -> Result<()> {
    Ok(state.sessions.cancel(session_id).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn transaction_state(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<TransactionState> {
    let session = session(&state, session_id).await?;
    let session = session.lock().await;
    Ok(TransactionState {
        mode: session.transaction_mode(),
        open: session.in_transaction(),
        statements: session.transaction_statements().to_vec(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn set_transaction_mode(
    state: State<'_, AppState>,
    session_id: Uuid,
    mode: TransactionMode,
) -> Result<()> {
    let session = session(&state, session_id).await?;
    Ok(session.lock().await.set_transaction_mode(mode)?)
}

#[tauri::command]
#[specta::specta]
pub async fn commit(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<()> {
    end_transaction(&app, &state, session_id, true).await
}

#[tauri::command]
#[specta::specta]
pub async fn rollback(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<()> {
    end_transaction(&app, &state, session_id, false).await
}

/// Reconnects after the user acknowledged that an open transaction was lost.
#[tauri::command]
#[specta::specta]
pub async fn acknowledge_lost_transaction(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<()> {
    let session = session(&state, session_id).await?;
    Ok(session
        .lock()
        .await
        .reconnect_after_lost_transaction()
        .await?)
}

/// Sets the PostgreSQL `search_path` for the session (`None` resets it to the server default).
#[tauri::command]
#[specta::specta]
pub async fn set_session_schema(
    state: State<'_, AppState>,
    session_id: Uuid,
    schema: Option<String>,
) -> Result<()> {
    let session = session(&state, session_id).await?;
    let sql = match schema {
        Some(schema) => format!("SET search_path TO \"{}\"", schema.replace('"', "\"\"")),
        None => "RESET search_path".to_owned(),
    };
    session
        .lock()
        .await
        .execute(&sql)
        .await
        .map_err(|e: SessionError| RunError::from(e))
}

/// Runs a read statement again and writes all its rows to `path`. Returns the number of rows.
#[tauri::command]
#[specta::specta]
pub async fn export_result(
    state: State<'_, AppState>,
    session_id: Uuid,
    sql: String,
    format: dbrief_core::export::ExportFormat,
    path: String,
    table: String,
) -> Result<f64> {
    let failed = |message: String| RunError::Failed { message };
    let mut writer =
        dbrief_core::export::ExportWriter::create(std::path::Path::new(&path), format, &table)
            .map_err(|e| failed(format!("could not write {path}: {e}")))?;

    let session = session(&state, session_id).await?;
    session.lock().await.export(&sql, &mut writer).await?;
    let rows = writer
        .finish()
        .map_err(|e| failed(format!("could not write {path}: {e}")))?;
    Ok(rows as f64)
}
