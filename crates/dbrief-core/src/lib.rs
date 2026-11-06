//! Core of dbrief: app storage, migrations and settings. Has no Tauri dependency.

pub mod settings;
pub mod storage;

pub use settings::{Settings, SettingsFile, SettingsLoad};
pub use storage::Storage;
