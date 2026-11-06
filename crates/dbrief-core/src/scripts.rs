//! The scripts folder: plain `.sql` files on disk, chosen by the user.

use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum ScriptsError {
    #[error("the scripts folder must be an absolute path: {0}")]
    NotAbsolute(String),
    #[error("{0} exists but is not a folder")]
    NotAFolder(String),
    #[error("could not create {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
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
