//! Tauri commands. Each one is a thin wrapper over `dbrief-core`.

use dbrief_core::Settings;
use serde::Serialize;
use tauri::State;

use crate::AppState;

#[derive(Serialize, specta::Type)]
pub struct SettingsResponse {
    pub settings: Settings,
    pub warning: Option<String>,
}

impl From<dbrief_core::SettingsLoad> for SettingsResponse {
    fn from(load: dbrief_core::SettingsLoad) -> Self {
        Self {
            settings: load.settings,
            warning: load.warning,
        }
    }
}

fn lock_settings(
    state: &AppState,
) -> Result<std::sync::MutexGuard<'_, dbrief_core::SettingsFile>, String> {
    state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_settings(state: State<'_, AppState>) -> Result<SettingsResponse, String> {
    Ok(lock_settings(&state)?.snapshot().into())
}

#[tauri::command]
#[specta::specta]
pub fn update_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<SettingsResponse, String> {
    let mut file = lock_settings(&state)?;
    file.update(settings)
        .map(Into::into)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_ui_state(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    state
        .storage
        .get_ui_state(&key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn set_ui_state(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    state
        .storage
        .set_ui_state(&key, &value)
        .await
        .map_err(|e| e.to_string())
}
