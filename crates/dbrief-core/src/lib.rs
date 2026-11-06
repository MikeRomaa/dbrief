//! Core of dbrief: app storage, migrations, settings, and the scripts folder. Has no Tauri dependency.

pub mod scripts;
pub mod settings;
pub mod storage;

pub use settings::{Settings, SettingsFile, SettingsLoad};
pub use storage::Storage;
