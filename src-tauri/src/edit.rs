//! Grid editing commands: a table's row identity and columns (background session), and previewing
//! and applying staged changes on the table tab's session.

use dbrief_core::edit::{EditBatch, EditInfo, EditStatement};
use dbrief_core::grid::{self, CopyFormat};
use dbrief_core::query::{Column, Value, Values};
use dbrief_core::schema::{self, ObjectRef};
use dbrief_core::session::{ApplyOutcome, EditFailure, RunError, StagedFile};
use tauri::State;
use uuid::Uuid;

use crate::AppState;

type Result<T> = std::result::Result<T, RunError>;

/// Row identity and columns of a table, loaded live on the connection's background session.
#[tauri::command]
#[specta::specta]
pub async fn table_edit_info(
    state: State<'_, AppState>,
    connection_id: Uuid,
    object: ObjectRef,
) -> Result<EditInfo> {
    let session = state.sessions.background(connection_id).await?;
    let mut session = session.lock().await;
    Ok(schema::edit_info(&mut session, &object).await?)
}

/// The statements a batch of staged changes would run.
#[tauri::command]
#[specta::specta]
pub async fn preview_changes(
    state: State<'_, AppState>,
    session_id: Uuid,
    batch: EditBatch,
) -> Result<Vec<EditStatement>> {
    let session = state.sessions.get(session_id).await?;
    let session = session.lock().await;
    Ok(session.edit_statements(&batch)?)
}

/// Applies staged changes: commits them in auto-commit mode (or leaves the transaction open for
/// confirm before commit), or runs them inside the open transaction in manual mode.
#[tauri::command]
#[specta::specta]
pub async fn apply_changes(
    state: State<'_, AppState>,
    session_id: Uuid,
    batch: EditBatch,
    confirm: bool,
) -> std::result::Result<ApplyOutcome, EditFailure> {
    let session = state
        .sessions
        .get(session_id)
        .await
        .map_err(EditFailure::from)?;
    let mut session = session.lock().await;
    session.apply_edits(&batch, confirm).await
}

/// Reads a file for a staged binary value.
#[tauri::command]
#[specta::specta]
pub async fn stage_file(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
) -> Result<StagedFile> {
    let session = state.sessions.get(session_id).await?;
    let mut session = session.lock().await;
    Ok(session.stage_file(std::path::Path::new(&path))?)
}

/// Forgets uploaded files after their changes were committed or discarded.
#[tauri::command]
#[specta::specta]
pub async fn discard_uploads(state: State<'_, AppState>, session_id: Uuid) -> Result<()> {
    let session = state.sessions.get(session_id).await?;
    session.lock().await.discard_uploads();
    Ok(())
}

/// Copies rows the frontend holds (script results) in a copy format.
#[tauri::command]
#[specta::specta]
pub fn copy_rows(
    columns: Vec<Column>,
    rows: Vec<Vec<Option<String>>>,
    format: CopyFormat,
    target: String,
) -> Result<String> {
    let count = rows.len() as u32;
    let width = columns.len() as u32;
    let values = Values {
        columns,
        rows: rows
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|v| v.map_or(Value::Null, Value::Text))
                    .collect()
            })
            .collect(),
    };
    Ok(grid::copy(
        &values,
        &(0..count).collect::<Vec<_>>(),
        &(0..width).collect::<Vec<_>>(),
        format,
        target,
    )?)
}
