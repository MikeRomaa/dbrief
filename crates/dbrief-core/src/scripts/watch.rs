//! Reports changes made to the scripts folder outside the app (git pull, another editor).

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};

use super::{ScriptsError, relative};

/// Changes within this time are reported together, so a `git pull` is one update.
const SETTLE: Duration = Duration::from_millis(200);

/// Watches the scripts folder and calls back with the changed paths (relative, `/` separators),
/// grouped and without duplicates. Hidden files, including the app's own temporary files from
/// autosave, are left out. Stops when dropped.
pub struct ScriptWatcher {
    _watcher: RecommendedWatcher,
}

impl ScriptWatcher {
    pub fn start(
        root: &Path,
        on_change: impl Fn(Vec<String>) + Send + 'static,
    ) -> Result<Self, ScriptsError> {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    for path in event.paths {
                        let _ = tx.send(path);
                    }
                }
            })
            .map_err(|e| ScriptsError::Watch(e.to_string()))?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|e| ScriptsError::Watch(e.to_string()))?;

        // Paths are compared after resolving symlinks (macOS reports /private/var for /var).
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        std::thread::spawn(move || {
            // Ends when the watcher, and with it the sender, is dropped.
            while let Ok(first) = rx.recv() {
                let mut paths = vec![first];
                while let Ok(path) = rx.recv_timeout(SETTLE) {
                    paths.push(path);
                }

                let mut changed: Vec<String> = paths
                    .iter()
                    .filter_map(|p| {
                        relative(&root, &p.canonicalize().unwrap_or_else(|_| p.clone()))
                            .or_else(|| relative(&root, p))
                    })
                    .filter(|r| !r.is_empty() && !r.split('/').any(|part| part.starts_with('.')))
                    .collect();
                changed.sort();
                changed.dedup();
                if !changed.is_empty() {
                    on_change(changed);
                }
            }
        });

        Ok(Self { _watcher: watcher })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn reports_outside_changes_grouped_and_skips_hidden_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let _watcher =
            ScriptWatcher::start(&root, move |paths| sink.lock().unwrap().push(paths)).unwrap();

        std::fs::write(root.join("a.sql"), "select 1").unwrap();
        std::fs::write(root.join(".a.sql.123.tmp"), "x").unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/b.sql"), "select 2").unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let all: Vec<String> = seen.lock().unwrap().iter().flatten().cloned().collect();
            if all.contains(&"a.sql".to_owned()) && all.contains(&"sub/b.sql".to_owned()) {
                assert!(all.iter().all(|p| !p.contains(".tmp")), "{all:?}");
                break;
            }
            assert!(std::time::Instant::now() < deadline, "no events: {all:?}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
