//! Core of dbrief: app storage, migrations, settings, connections, secrets, and the scripts folder. Has no
//! Tauri dependency.

pub mod connections;
pub mod scripts;
pub mod secrets;
pub mod settings;
pub mod storage;

pub use settings::{Settings, SettingsFile, SettingsLoad};
pub use storage::Storage;
