//! The scripts folder: plain `.sql` files on disk, chosen by the user. The folder is the source of
//! truth; the app database only keeps per-script settings (see [`meta`]).

mod files;
pub mod meta;
mod watch;

pub use files::{
    EXTENSION, ScriptNode, create_folder, create_script, delete, read, relative, rename, resolve,
    tree, write,
};
pub use watch::ScriptWatcher;

use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum ScriptsError {
    #[error("the scripts folder must be an absolute path: {0}")]
    NotAbsolute(String),
    #[error("{0} exists but is not a folder")]
    NotAFolder(String),
    #[error("{path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("{0} is outside the scripts folder")]
    OutsideFolder(String),
    #[error("{0} already exists")]
    Exists(String),
    #[error("{0}")]
    Invalid(String),
    #[error("could not move {path} to the trash: {reason}")]
    Trash { path: String, reason: String },
    #[error("could not watch the scripts folder: {0}")]
    Watch(String),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

/// Makes sure `path` is an existing folder, creating it (and any parents) if missing.
pub fn ensure_folder(path: &Path) -> Result<(), ScriptsError> {
    let display = path.display().to_string();
    if !path.is_absolute() {
        return Err(ScriptsError::NotAbsolute(display));
    }

    if path.exists() && !path.is_dir() {
        return Err(ScriptsError::NotAFolder(display));
    }

    std::fs::create_dir_all(path).map_err(|source| ScriptsError::Io {
        path: display,
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_missing_nested_folder() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a").join("b");
        ensure_folder(&target).unwrap();
        assert!(target.is_dir());
    }

    #[test]
    fn accepts_existing_folder() {
        let dir = tempfile::tempdir().unwrap();
        ensure_folder(dir.path()).unwrap();
    }

    #[test]
    fn rejects_relative_path() {
        assert!(matches!(
            ensure_folder(Path::new("scripts")),
            Err(ScriptsError::NotAbsolute(_))
        ));
    }

    #[test]
    fn rejects_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("scripts");
        std::fs::write(&file, "").unwrap();
        assert!(matches!(
            ensure_folder(&file),
            Err(ScriptsError::NotAFolder(_))
        ));
    }
}
