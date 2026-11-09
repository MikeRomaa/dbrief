//! Schema cache, structure, search, and table tab commands.
//!
//! The app's own SQL (schema loading, structure, DDL, counts) runs on the connection's background
//! session; table pages run on the table tab's session.

use std::time::Instant;

use dbrief_core::connections::Engine;
use dbrief_core::export::{ExportFormat, ExportWriter};
use dbrief_core::grid::{self, CopyFormat, FullValue, GridPage, TableQuery};
use dbrief_core::schema::{
    self, ObjectKind, ObjectRef, SchemaColumn, SchemaObject, SearchHit, TableStructure,
};
use dbrief_core::session::RunError;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event as _;
use uuid::Uuid;

use crate::AppState;

type Result<T> = std::result::Result<T, RunError>;

fn failed(message: impl std::fmt::Display) -> RunError {
    RunError::Failed {
        message: message.to_string(),
    }
}

/// A connection's schema was loaded into the cache (or loading failed: `error`).
#[derive(Clone, Debug, Serialize, specta::Type, tauri_specta::Event)]
pub struct SchemaChanged {
    pub connection_id: Uuid,
    pub objects: u32,
    pub duration_ms: f64,
    pub error: Option<String>,
}

/// Sessions were opened or closed, so "connected" changed for some connection.
#[derive(Clone, Debug, Serialize, specta::Type, tauri_specta::Event)]
pub struct SessionsChanged {}

pub fn sessions_changed(app: &AppHandle) {
    let _ = SessionsChanged {}.emit(app);
}

/// Loads the connection's schema on its background session and stores it in the cache.
async fn load_schema(app: &AppHandle, connection_id: Uuid) -> std::result::Result<u32, String> {
    let state = app.state::<AppState>();
    let session = state
        .sessions
        .background(connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let snapshot = {
        let mut session = session.lock().await;
        schema::load(&mut session)
            .await
            .map_err(|e| e.to_string())?
    };
    state
        .schema
        .replace(connection_id, &snapshot)
        .await
        .map_err(|e| format!("could not save the schema: {e}"))?;
    Ok(snapshot.objects.len() as u32)
}

/// Reloads the connection's schema and reports it with [`SchemaChanged`].
pub async fn refresh(app: &AppHandle, connection_id: Uuid) -> std::result::Result<(), String> {
    let started = Instant::now();
    let result = load_schema(app, connection_id).await;
    let _ = SchemaChanged {
        connection_id,
        objects: *result.as_ref().unwrap_or(&0),
        duration_ms: started.elapsed().as_secs_f64() * 1000.0,
        error: result.as_ref().err().cloned(),
    }
    .emit(app);
    result.map(|_| ())
}

/// Reloads the schema in the background (after connect, DDL, or a commit that ran DDL).
pub fn refresh_later(app: &AppHandle, connection_id: Uuid) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = refresh(&app, connection_id).await;
    });
}

#[tauri::command]
#[specta::specta]
pub async fn refresh_schema(app: AppHandle, connection_id: Uuid) -> Result<()> {
    refresh(&app, connection_id).await.map_err(failed)
}

/// Closes every session of a connection (its tabs ask about open transactions first).
#[tauri::command]
#[specta::specta]
pub async fn disconnect_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> Result<()> {
    state.sessions.close_connection(connection_id).await;
    sessions_changed(&app);
    Ok(())
}

/// The cached schema of a connection; `refreshed_at` is `None` when it was never loaded.
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct SchemaTree {
    pub objects: Vec<SchemaObject>,
    pub refreshed_at: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn schema_tree(state: State<'_, AppState>, connection_id: Uuid) -> Result<SchemaTree> {
    Ok(SchemaTree {
        objects: state.schema.objects(connection_id).await.map_err(failed)?,
        refreshed_at: state
            .schema
            .refreshed_at(connection_id)
            .await
            .map_err(failed)?,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn table_columns(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    table: String,
) -> Result<Vec<SchemaColumn>> {
    state
        .schema
        .columns(connection_id, &schema, &table)
        .await
        .map_err(failed)
}

/// A table's column names, for autocomplete.
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct CompletionTable {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn completion_columns(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> Result<Vec<CompletionTable>> {
    let names = state
        .schema
        .column_names(connection_id)
        .await
        .map_err(failed)?;
    let mut tables: Vec<CompletionTable> = Vec::new();
    for (schema, table, column) in names {
        match tables.last_mut() {
            Some(t) if t.schema == schema && t.table == table => t.columns.push(column),
            _ => tables.push(CompletionTable {
                schema,
                table,
                columns: vec![column],
            }),
        }
    }
    Ok(tables)
}

#[tauri::command]
#[specta::specta]
pub async fn search_schema(
    state: State<'_, AppState>,
    query: String,
    limit: u32,
) -> Result<Vec<SearchHit>> {
    state
        .schema
        .search(&query, limit as usize)
        .await
        .map_err(failed)
}

/// Runs `work` on the connection's background session.
macro_rules! on_background {
    ($state:expr, $connection_id:expr, |$session:ident| $work:expr) => {{
        let session = $state
            .sessions
            .background($connection_id)
            .await
            .map_err(RunError::from)?;
        let mut guard = session.lock().await;
        let $session = &mut *guard;
        $work.await.map_err(RunError::from)
    }};
}

#[tauri::command]
#[specta::specta]
pub async fn table_structure(
    state: State<'_, AppState>,
    connection_id: Uuid,
    object: ObjectRef,
) -> Result<TableStructure> {
    on_background!(state, connection_id, |session| schema::structure(
        session, &object
    ))
}

#[tauri::command]
#[specta::specta]
pub async fn object_ddl(
    state: State<'_, AppState>,
    connection_id: Uuid,
    object: ObjectRef,
) -> Result<String> {
    on_background!(state, connection_id, |session| schema::ddl(
        session, &object
    ))
}

/// An exact row count, and the SQL that counted (for the Log).
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct RowCount {
    pub count: f64,
    pub sql: String,
    pub duration_ms: f64,
}

#[tauri::command]
#[specta::specta]
pub async fn count_rows(
    state: State<'_, AppState>,
    connection_id: Uuid,
    query: TableQuery,
) -> Result<RowCount> {
    let session = state
        .sessions
        .background(connection_id)
        .await
        .map_err(RunError::from)?;
    let mut session = session.lock().await;
    let sql = query.count_sql(session.info().engine)?;
    let started = Instant::now();
    let values = session.fetch_values(&sql).await?;
    let count = values
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_f64())
        .unwrap_or_default();
    Ok(RowCount {
        count,
        sql,
        duration_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

/// The sort that keeps pages stable, from the cached primary key.
async fn default_order(
    state: &AppState,
    engine: Engine,
    connection_id: Uuid,
    kind: ObjectKind,
    query: &TableQuery,
) -> Option<String> {
    let columns = state
        .schema
        .columns(connection_id, &query.schema, &query.name)
        .await
        .unwrap_or_default();
    grid::default_order(engine, kind, &columns)
}

/// A page of a table. `sql` is the query that ran; `unordered` means no sort applies, so rows may
/// move between pages.
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct TablePage {
    pub page: GridPage,
    pub sql: String,
    pub unordered: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn table_page(
    state: State<'_, AppState>,
    session_id: Uuid,
    kind: ObjectKind,
    query: TableQuery,
    rowid: Option<String>,
    limit: u32,
    offset: f64,
) -> Result<TablePage> {
    let session = state.sessions.get(session_id).await?;
    let mut session = session.lock().await;
    let info = session.info().clone();
    let default = default_order(&state, info.engine, info.connection_id, kind, &query).await;
    let unordered = default.is_none() && query.order.as_deref().is_none_or(|o| o.trim().is_empty());
    let sql = query.page_sql(
        info.engine,
        default.as_deref(),
        rowid.as_deref(),
        limit,
        offset.max(0.0) as u64,
    )?;
    let page = session.table_page(&sql, rowid.is_some()).await?;
    Ok(TablePage {
        page,
        sql,
        unordered,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn page_value(
    state: State<'_, AppState>,
    session_id: Uuid,
    row: u32,
    column: u32,
) -> Result<FullValue> {
    let session = state.sessions.get(session_id).await?;
    let session = session.lock().await;
    Ok(FullValue::of(session.page_value(row, column)?))
}

#[tauri::command]
#[specta::specta]
pub async fn save_page_value(
    state: State<'_, AppState>,
    session_id: Uuid,
    row: u32,
    column: u32,
    path: String,
) -> Result<()> {
    let session = state.sessions.get(session_id).await?;
    let session = session.lock().await;
    let value = session.page_value(row, column)?;
    grid::save(value, std::path::Path::new(&path))
        .map_err(|e| failed(format!("could not write {path}: {e}")))
}

#[tauri::command]
#[specta::specta]
pub async fn find_in_page(
    state: State<'_, AppState>,
    session_id: Uuid,
    text: String,
) -> Result<Vec<[u32; 2]>> {
    let session = state.sessions.get(session_id).await?;
    let session = session.lock().await;
    Ok(grid::find(session.page()?, &text))
}

#[tauri::command]
#[specta::specta]
pub async fn copy_page(
    state: State<'_, AppState>,
    session_id: Uuid,
    rows: Vec<u32>,
    columns: Vec<u32>,
    format: CopyFormat,
    query: TableQuery,
) -> Result<String> {
    let session = state.sessions.get(session_id).await?;
    let session = session.lock().await;
    Ok(grid::copy(
        session.page()?,
        &rows,
        &columns,
        format,
        query.target(),
    )?)
}

/// Writes every row matching the filter, in the grid's sort, to `path`. Returns the number of rows.
#[tauri::command]
#[specta::specta]
pub async fn export_table(
    state: State<'_, AppState>,
    session_id: Uuid,
    kind: ObjectKind,
    query: TableQuery,
    format: ExportFormat,
    path: String,
) -> Result<f64> {
    let session = state.sessions.get(session_id).await?;
    let mut session = session.lock().await;
    let info = session.info().clone();
    let default = default_order(&state, info.engine, info.connection_id, kind, &query).await;
    let sql = query.export_sql(info.engine, default.as_deref())?;

    let mut writer = ExportWriter::create_for(std::path::Path::new(&path), format, query.target())
        .map_err(|e| failed(format!("could not write {path}: {e}")))?;
    session.export(&sql, &mut writer).await?;
    let rows = writer
        .finish()
        .map_err(|e| failed(format!("could not write {path}: {e}")))?;
    Ok(rows as f64)
}

#[tauri::command]
#[specta::specta]
pub async fn table_layout(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    table: String,
) -> Result<Option<String>> {
    state
        .schema
        .layout(connection_id, &schema, &table)
        .await
        .map_err(failed)
}

#[tauri::command]
#[specta::specta]
pub async fn set_table_layout(
    state: State<'_, AppState>,
    connection_id: Uuid,
    schema: String,
    table: String,
    layout: String,
) -> Result<()> {
    state
        .schema
        .set_layout(connection_id, &schema, &table, &layout)
        .await
        .map_err(failed)
}
