//! Scripts folder commands, and the watcher that reports outside changes as `ScriptsChanged`.

use std::path::PathBuf;

use dbrief_core::scripts::{self, ScriptNode, ScriptWatcher, meta::ParamValues, meta::ScriptMeta};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event as _;
use uuid::Uuid;

use crate::AppState;

type Result<T> = std::result::Result<T, String>;

/// Script files or folders changed on disk (outside the app, or by its own saves). Paths are relative
/// to the scripts folder.
#[derive(Clone, Debug, Serialize, specta::Type, tauri_specta::Event)]
pub struct ScriptsChanged {
    pub paths: Vec<String>,
}

fn root(state: &AppState) -> Result<PathBuf> {
    let folder = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?
        .snapshot()
        .settings
        .editor
        .scripts_folder;
    if folder.is_empty() {
        return Err("no scripts folder is set; choose one in Settings → Editor".into());
    }
    Ok(PathBuf::from(folder))
}

/// (Re)starts watching the scripts folder; called at startup and when the folder setting changes.
pub fn watch(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(folder) = root(&state) else {
        return;
    };

    let handle = app.clone();
    let watcher = ScriptWatcher::start(&folder, move |paths| {
        let _ = ScriptsChanged { paths }.emit(&handle);
    });
    if let Ok(mut slot) = state.script_watcher.lock() {
        *slot = watcher.ok();
    }
}

#[tauri::command]
#[specta::specta]
pub fn script_tree(state: State<'_, AppState>) -> Result<Vec<ScriptNode>> {
    scripts::tree(&root(&state)?).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn read_script(state: State<'_, AppState>, path: String) -> Result<String> {
    scripts::read(&root(&state)?, &path).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn write_script(state: State<'_, AppState>, path: String, text: String) -> Result<()> {
    scripts::write(&root(&state)?, &path, &text).map_err(|e| e.to_string())
}

/// A new empty script in `dir` ("" for the top), named "untitled", numbered if taken.
#[tauri::command]
#[specta::specta]
pub fn create_script(state: State<'_, AppState>, dir: String) -> Result<String> {
    scripts::create_script(&root(&state)?, &dir, "untitled").map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn create_script_folder(
    state: State<'_, AppState>,
    dir: String,
    name: String,
) -> Result<String> {
    scripts::create_folder(&root(&state)?, &dir, &name).map_err(|e| e.to_string())
}

/// Renames or moves a script or folder; its saved settings move with it.
#[tauri::command]
#[specta::specta]
pub async fn rename_script(state: State<'_, AppState>, from: String, to: String) -> Result<()> {
    scripts::rename(&root(&state)?, &from, &to).map_err(|e| e.to_string())?;
    state
        .script_meta
        .moved(&from, &to)
        .await
        .map_err(|e| e.to_string())
}

/// Moves a script or folder to the OS trash and forgets its settings.
#[tauri::command]
#[specta::specta]
pub async fn delete_script(state: State<'_, AppState>, path: String) -> Result<()> {
    scripts::delete(&root(&state)?, &path).map_err(|e| e.to_string())?;
    state
        .script_meta
        .removed(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn script_meta(state: State<'_, AppState>, path: String) -> Result<ScriptMeta> {
    state
        .script_meta
        .get(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn set_script_connection(
    state: State<'_, AppState>,
    path: String,
    connection_id: Option<Uuid>,
) -> Result<()> {
    state
        .script_meta
        .set_connection(&path, connection_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn set_script_schema(
    state: State<'_, AppState>,
    path: String,
    schema: Option<String>,
) -> Result<()> {
    state
        .script_meta
        .set_schema(&path, schema.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn remember_script_params(
    state: State<'_, AppState>,
    path: String,
    values: ParamValues,
) -> Result<()> {
    state
        .script_meta
        .remember_params(&path, &values)
        .await
        .map_err(|e| e.to_string())
}
