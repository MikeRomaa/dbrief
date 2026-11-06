//! Core of dbrief: app storage, migrations, settings, connections, database engines, secrets, sessions, and
//! the scripts folder. Has no Tauri dependency.

pub mod connections;
pub mod engine;
pub mod scripts;
pub mod secrets;
pub mod session;
pub mod settings;
pub mod storage;

pub use settings::{Settings, SettingsFile, SettingsLoad};
pub use storage::Storage;
