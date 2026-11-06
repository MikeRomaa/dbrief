//! Connection, folder and session commands. Thin wrappers over `dbrief_core::actions` and the repo.
//!
//! Errors are [`ActionError`]: `secret-required` names the secret to ask for (connect and test retry
//! with it in `prompted`), anything else is a message to show.

use dbrief_core::actions::{
    self, ActionError, Connected, OpenedFile, Saved, SavedSecrets, SecretChanges,
};
use dbrief_core::connections::{
    Connection, ConnectionInput, ConnectionTree, DeleteCounts, Folder, ItemRef, Removed,
};
use dbrief_core::engine::{self, UrlParts};
use dbrief_core::session::{Credentials, SessionInfo, TestResult};
use tauri::State;
use uuid::Uuid;

use crate::AppState;

type Result<T> = std::result::Result<T, ActionError>;

/// The Connections view: pinned connections and the folder tree.
#[tauri::command]
#[specta::specta]
pub async fn connection_tree(state: State<'_, AppState>) -> Result<ConnectionTree> {
    Ok(state.connections.tree().await?)
}

#[tauri::command]
#[specta::specta]
pub async fn get_connection(state: State<'_, AppState>, id: Uuid) -> Result<Connection> {
    Ok(state.connections.connection(id).await?)
}

/// Which secrets are stored for a connection; the secrets themselves never leave the backend.
#[tauri::command]
#[specta::specta]
pub fn saved_secrets(state: State<'_, AppState>, id: Uuid) -> SavedSecrets {
    actions::saved_secrets(&state.secrets, id)
}

/// False when there is no OS credential store: secrets are then asked for on connect and kept only
/// until the app quits, so the modal hides "Save in keychain".
#[tauri::command]
#[specta::specta]
pub fn secret_store_persistent(state: State<'_, AppState>) -> bool {
    state.secrets.persistent()
}

#[tauri::command]
#[specta::specta]
pub async fn create_folder(
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<Uuid>,
) -> Result<Folder> {
    Ok(state.connections.create_folder(&name, parent_id).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn rename_folder(state: State<'_, AppState>, id: Uuid, name: String) -> Result<()> {
    Ok(state.connections.rename_folder(id, &name).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn create_connection(
    state: State<'_, AppState>,
    input: ConnectionInput,
    secrets: SecretChanges,
) -> Result<Saved> {
    actions::create_connection(&state.connections, &state.secrets, input, &secrets).await
}

/// Saves edits. Open sessions keep their access level and settings until they reconnect.
#[tauri::command]
#[specta::specta]
pub async fn update_connection(
    state: State<'_, AppState>,
    id: Uuid,
    input: ConnectionInput,
    secrets: SecretChanges,
) -> Result<Saved> {
    actions::update_connection(&state.connections, &state.secrets, id, input, &secrets).await
}

#[tauri::command]
#[specta::specta]
pub async fn duplicate_connection(state: State<'_, AppState>, id: Uuid) -> Result<Saved> {
    actions::duplicate_connection(&state.connections, &state.secrets, id).await
}

/// Moves into `parent_id` (`null` = root), before `before`, or to the end when `before` is `null`.
#[tauri::command]
#[specta::specta]
pub async fn move_item(
    state: State<'_, AppState>,
    item: ItemRef,
    parent_id: Option<Uuid>,
    before: Option<ItemRef>,
) -> Result<()> {
    Ok(state.connections.move_item(item, parent_id, before).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn set_pinned(state: State<'_, AppState>, id: Uuid, pinned: bool) -> Result<()> {
    Ok(state.connections.set_pinned(id, pinned).await?)
}

/// What removing `item` would delete, for the confirm dialog.
#[tauri::command]
#[specta::specta]
pub async fn delete_counts(state: State<'_, AppState>, item: ItemRef) -> Result<DeleteCounts> {
    Ok(state.connections.delete_counts(item).await?)
}

/// Removes a folder or connection with everything tied to it, closing its open sessions.
#[tauri::command]
#[specta::specta]
pub async fn remove_item(state: State<'_, AppState>, item: ItemRef) -> Result<Removed> {
    actions::remove_item(&state.connections, &state.secrets, &state.sessions, item).await
}

/// Tests the modal's settings. `id` is set when editing, so stored secrets fill in untyped ones.
#[tauri::command]
#[specta::specta]
pub async fn test_connection(
    state: State<'_, AppState>,
    id: Option<Uuid>,
    input: ConnectionInput,
    prompted: Credentials,
) -> Result<TestResult> {
    actions::test_connection(&state.secrets, &state.ssh_env, id, &input, &prompted).await
}

/// Opens a session. On `secret-required`, ask for that secret and call again with it in `prompted`.
#[tauri::command]
#[specta::specta]
pub async fn connect(
    state: State<'_, AppState>,
    id: Uuid,
    prompted: Credentials,
    remember: bool,
) -> Result<Connected> {
    actions::connect(
        &state.connections,
        &state.secrets,
        &state.sessions,
        &state.ssh_env,
        id,
        &prompted,
        remember,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn disconnect(state: State<'_, AppState>, session_id: Uuid) -> Result<()> {
    state
        .sessions
        .close(session_id)
        .await
        .map_err(ActionError::failed)
}

#[tauri::command]
#[specta::specta]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>> {
    Ok(state.sessions.list().await)
}

/// Reads a pasted `postgresql://…`, `sqlite:…` URL or file path into connection fields.
#[tauri::command]
#[specta::specta]
pub fn parse_connection_url(text: String) -> Result<UrlParts> {
    engine::parse_url(&text).map_err(ActionError::failed)
}

/// The copyable URL for the modal's settings, without the password.
#[tauri::command]
#[specta::specta]
pub fn build_connection_url(input: ConnectionInput) -> String {
    engine::build_url(&input)
}

/// The connection for a SQLite file: reused when one exists for the same path, else created at the root.
#[tauri::command]
#[specta::specta]
pub async fn open_sqlite_file(state: State<'_, AppState>, path: String) -> Result<OpenedFile> {
    actions::open_sqlite_file(&state.connections, std::path::Path::new(&path)).await
}
