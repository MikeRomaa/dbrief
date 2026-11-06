//! Script files and folders inside the scripts folder. Paths are relative to the scripts folder with
//! `/` separators (the same on every OS), and never leave it.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use super::ScriptsError;

/// The extension of script files.
pub const EXTENSION: &str = "sql";

/// A script folder or file in the side panel tree. Folders come first, then scripts, each by name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ScriptNode {
    Folder {
        path: String,
        name: String,
        children: Vec<ScriptNode>,
    },
    Script {
        path: String,
        name: String,
    },
}

fn io(path: &Path) -> impl FnOnce(std::io::Error) -> ScriptsError + '_ {
    move |source| ScriptsError::Io {
        path: path.display().to_string(),
        source,
    }
}

/// The absolute path of `relative` inside `root`, refusing anything that would leave it.
pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf, ScriptsError> {
    let mut path = root.to_path_buf();
    for part in relative.split('/').filter(|p| !p.is_empty()) {
        let component = Path::new(part).components().next();
        if part.contains('\\') || !matches!(component, Some(Component::Normal(_))) {
            return Err(ScriptsError::OutsideFolder(relative.to_owned()));
        }
        path.push(part);
    }
    Ok(path)
}

/// `path` relative to `root`, with `/` separators.
pub fn relative(root: &Path, path: &Path) -> Option<String> {
    let rest = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = rest
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn is_script(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION))
}

/// The scripts folder as a tree. Hidden entries (`.git`, …) and non-`.sql` files are left out.
pub fn tree(root: &Path) -> Result<Vec<ScriptNode>, ScriptsError> {
    fn walk(root: &Path, dir: &Path) -> Result<Vec<ScriptNode>, ScriptsError> {
        let mut folders = Vec::new();
        let mut scripts = Vec::new();

        for entry in std::fs::read_dir(dir).map_err(io(dir))? {
            let entry = entry.map_err(io(dir))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if is_hidden(&name) {
                continue;
            }
            let Some(rel) = relative(root, &path) else {
                continue;
            };

            if path.is_dir() {
                folders.push(ScriptNode::Folder {
                    path: rel,
                    name,
                    children: walk(root, &path)?,
                });
            } else if is_script(&path) {
                scripts.push(ScriptNode::Script { path: rel, name });
            }
        }

        let by_name = |n: &ScriptNode| match n {
            ScriptNode::Folder { name, .. } | ScriptNode::Script { name, .. } => {
                name.to_lowercase()
            }
        };
        folders.sort_by_key(by_name);
        scripts.sort_by_key(by_name);
        folders.extend(scripts);
        Ok(folders)
    }

    walk(root, root)
}

pub fn read(root: &Path, relative: &str) -> Result<String, ScriptsError> {
    let path = resolve(root, relative)?;
    std::fs::read_to_string(&path).map_err(io(&path))
}

/// Writes the whole file through a temporary file and a rename, so a crash never leaves half a
/// script behind.
pub fn write(root: &Path, relative: &str, text: &str) -> Result<(), ScriptsError> {
    let path = resolve(root, relative)?;
    let dir = path
        .parent()
        .ok_or_else(|| ScriptsError::OutsideFolder(relative.to_owned()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = dir.join(format!(".{name}.{}.tmp", std::process::id()));

    std::fs::write(&temp, text).map_err(io(&temp))?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        io(&path)(e)
    })
}

/// The first free name in `dir_relative` from `stem` (`untitled.sql`, `untitled 2.sql`, …).
fn free_name(
    root: &Path,
    dir_relative: &str,
    stem: &str,
    extension: Option<&str>,
) -> Result<String, ScriptsError> {
    let dir = resolve(root, dir_relative)?;
    for n in 1.. {
        let base = if n == 1 {
            stem.to_owned()
        } else {
            format!("{stem} {n}")
        };
        let name = match extension {
            Some(ext) => format!("{base}.{ext}"),
            None => base,
        };
        if !dir.join(&name).exists() {
            return Ok(join(dir_relative, &name));
        }
    }
    unreachable!("some name is always free")
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

/// Creates an empty script in `dir` named after `stem`, numbered if taken. Returns its path.
pub fn create_script(root: &Path, dir: &str, stem: &str) -> Result<String, ScriptsError> {
    let relative = free_name(root, dir, stem, Some(EXTENSION))?;
    let path = resolve(root, &relative)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(io(&path))?;
    Ok(relative)
}

/// Creates a folder in `dir`, numbered if the name is taken. Returns its path.
pub fn create_folder(root: &Path, dir: &str, name: &str) -> Result<String, ScriptsError> {
    let relative = free_name(root, dir, name, None)?;
    let path = resolve(root, &relative)?;
    std::fs::create_dir(&path).map_err(io(&path))?;
    Ok(relative)
}

/// Renames or moves a script or folder. Refuses to overwrite, and to move a folder into itself.
pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), ScriptsError> {
    let source = resolve(root, from)?;
    let target = resolve(root, to)?;
    if target.starts_with(&source) && target != source {
        return Err(ScriptsError::Invalid(format!(
            "can't move {from} into itself"
        )));
    }
    if target.exists() && !same_file_ignoring_case(&source, &target) {
        return Err(ScriptsError::Exists(to.to_owned()));
    }
    std::fs::rename(&source, &target).map_err(io(&source))
}

/// On case-insensitive file systems renaming `a.sql` to `A.sql` finds the target "existing".
fn same_file_ignoring_case(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}

/// Moves a script or folder to the OS trash (Trash, Recycle Bin).
pub fn delete(root: &Path, relative: &str) -> Result<(), ScriptsError> {
    if relative.trim_matches('/').is_empty() {
        return Err(ScriptsError::Invalid(
            "can't delete the scripts folder itself".into(),
        ));
    }
    let path = resolve(root, relative)?;
    trash::delete(&path).map_err(|e| ScriptsError::Trash {
        path: relative.to_owned(),
        reason: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(nodes: &[ScriptNode]) -> Vec<String> {
        nodes
            .iter()
            .map(|n| match n {
                ScriptNode::Folder { path, children, .. } => {
                    format!("{path}/[{}]", names(children).join(","))
                }
                ScriptNode::Script { path, .. } => path.clone(),
            })
            .collect()
    }

    #[test]
    fn lists_folders_first_and_only_scripts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("billing/old")).unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        for f in [
            "b.sql",
            "A.SQL",
            "notes.txt",
            "billing/revenue.sql",
            ".hidden.sql",
        ] {
            std::fs::write(root.join(f), "").unwrap();
        }

        assert_eq!(
            names(&tree(root).unwrap()),
            [
                "billing/[billing/old/[],billing/revenue.sql]",
                "A.SQL",
                "b.sql"
            ]
        );
    }

    #[test]
    fn refuses_paths_outside_the_folder() {
        let root = Path::new("/scripts");
        assert_eq!(
            resolve(root, "a/b.sql").unwrap(),
            Path::new("/scripts/a/b.sql")
        );
        assert_eq!(resolve(root, "").unwrap(), Path::new("/scripts"));
        for bad in ["../x.sql", "a/../../x", "a\\..\\x"] {
            assert!(resolve(root, bad).is_err(), "{bad}");
        }
        // A leading slash is only an empty first part, so it stays inside.
        assert_eq!(
            resolve(root, "/etc/passwd").unwrap(),
            Path::new("/scripts/etc/passwd")
        );
    }

    #[test]
    fn creates_writes_renames_and_moves() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        assert_eq!(create_script(root, "", "untitled").unwrap(), "untitled.sql");
        assert_eq!(
            create_script(root, "", "untitled").unwrap(),
            "untitled 2.sql"
        );
        assert_eq!(create_folder(root, "", "Billing").unwrap(), "Billing");

        write(root, "untitled.sql", "select 1;").unwrap();
        assert_eq!(read(root, "untitled.sql").unwrap(), "select 1;");
        // No temp file is left behind.
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 3);

        rename(root, "untitled.sql", "Billing/revenue.sql").unwrap();
        assert_eq!(read(root, "Billing/revenue.sql").unwrap(), "select 1;");
        assert!(matches!(
            rename(root, "untitled 2.sql", "Billing/revenue.sql"),
            Err(ScriptsError::Exists(_))
        ));
        assert!(rename(root, "Billing", "Billing/inner").is_err());
        rename(root, "Billing/revenue.sql", "Billing/Revenue.sql").unwrap();
    }
}
