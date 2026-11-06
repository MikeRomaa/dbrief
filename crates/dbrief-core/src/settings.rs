//! `settings.toml`: typed settings with defaults, edited in place so the user's
//! comments, key order, formatting and unknown keys survive writes from the app.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use toml_edit::{DocumentMut, Item, Table, TableLike, Value};

/// File name of the settings file inside the app data directory.
pub const SETTINGS_FILE: &str = "settings.toml";

/// Written when `settings.toml` does not exist. Must parse to `Settings::default()`.
const DEFAULT_FILE: &str = r#"# dbrief settings.
# Changes made in the app are saved here automatically. Comments and unknown keys are kept.

[appearance]
# Color theme: "light", "dark" or "system" (follows the OS setting).
theme = "system"
"#;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(default)]
pub struct Appearance {
    pub theme: Theme,
}

/// All settings. Each field is a TOML table matching a section of the Settings view.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(default)]
pub struct Settings {
    pub appearance: Appearance,
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("could not read or write {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("could not serialize settings: {0}")]
    Serialize(#[from] toml_edit::ser::Error),
}

/// Result of loading the settings file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsLoad {
    pub settings: Settings,
    /// Set when the file could not be used; the app falls back to defaults and shows this.
    pub warning: Option<String>,
}

/// The settings file on disk plus its parsed, format-preserving document.
#[derive(Debug)]
pub struct SettingsFile {
    path: PathBuf,
    /// `None` when the file is not valid TOML. The file is then left untouched.
    doc: Option<DocumentMut>,
    settings: Settings,
    warning: Option<String>,
}

impl SettingsFile {
    /// Loads `settings.toml` from `data_dir`, creating it with defaults if missing.
    pub fn load(data_dir: &Path) -> Result<Self, SettingsError> {
        let path = data_dir.join(SETTINGS_FILE);
        let io_err = |source| SettingsError::Io {
            path: path.clone(),
            source,
        };

        if !path.exists() {
            std::fs::create_dir_all(data_dir).map_err(io_err)?;
            write_atomic(&path, DEFAULT_FILE).map_err(io_err)?;
        }
        let text = std::fs::read_to_string(&path).map_err(io_err)?;

        let (doc, settings, warning) = match text.parse::<DocumentMut>() {
            Err(e) => (
                None,
                Settings::default(),
                Some(format!(
                    "settings.toml is not valid TOML ({}). Using defaults; the file was not changed.",
                    first_line(&e.to_string())
                )),
            ),
            Ok(doc) => match toml_edit::de::from_document::<Settings>(doc.clone()) {
                Ok(settings) => (Some(doc), settings, None),
                Err(e) => (
                    Some(doc),
                    Settings::default(),
                    Some(format!(
                        "settings.toml has an invalid value ({}). Using defaults.",
                        first_line(&e.to_string())
                    )),
                ),
            },
        };

        Ok(Self {
            path,
            doc,
            settings,
            warning,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn snapshot(&self) -> SettingsLoad {
        SettingsLoad {
            settings: self.settings.clone(),
            warning: self.warning.clone(),
        }
    }

    /// Applies new settings and writes only the changed values back to the file.
    ///
    /// If the file is not valid TOML, the new settings are kept in memory only and the
    /// warning stays, so the user's file is never overwritten.
    pub fn update(&mut self, new: Settings) -> Result<SettingsLoad, SettingsError> {
        if let Some(doc) = self.doc.as_mut() {
            let new_doc = toml_edit::ser::to_document(&new)?;
            let existing: Vec<String> = doc.as_table().iter().map(|(k, _)| k.to_string()).collect();
            merge_table_like(doc.as_table_mut(), new_doc.as_table());
            keep_trailing_text_in_place(doc, &existing);
            write_atomic(&self.path, &doc.to_string()).map_err(|source| SettingsError::Io {
                path: self.path.clone(),
                source,
            })?;
            // The changed keys now hold valid values; other invalid keys (if any) are
            // still in the file, so re-check before clearing the warning.
            if toml_edit::de::from_document::<Settings>(doc.clone()).is_ok() {
                self.warning = None;
            }
        }
        self.settings = new;
        Ok(self.snapshot())
    }
}

/// Text after the last item of a document (e.g. a file holding only comments) is printed
/// after every table. When a section is added, move that text above the new section so it
/// stays where the user wrote it.
fn keep_trailing_text_in_place(doc: &mut DocumentMut, existing_keys: &[String]) {
    let trailing = doc.trailing().as_str().unwrap_or_default().to_string();
    if trailing.is_empty() {
        return;
    }
    let first_new = doc
        .as_table()
        .iter()
        .map(|(k, _)| k.to_string())
        .find(|k| !existing_keys.contains(k));
    let Some(key) = first_new else { return };
    if let Some(table) = doc.get_mut(&key).and_then(Item::as_table_mut) {
        table.decor_mut().set_prefix(trailing);
        doc.set_trailing("");
    }
}

/// Copies every leaf of `src` into `dst`, changing only values that differ.
/// Keys in `dst` that are not in `src` (unknown keys) are left alone. `dst` may be an
/// inline table (`appearance = { theme = "dark" }`).
fn merge_table_like(dst: &mut dyn TableLike, src: &dyn TableLike) {
    for (key, src_item) in src.iter() {
        // Serialized settings come back as inline tables; treat any table-like item as a section.
        if let Some(src_table) = src_item.as_table_like() {
            if !dst.get(key).is_some_and(Item::is_table_like) {
                let mut table = Table::new();
                table.set_implicit(false);
                dst.insert(key, Item::Table(table));
            }
            if let Some(dst_table) = dst.get_mut(key).and_then(Item::as_table_like_mut) {
                merge_table_like(dst_table, src_table);
            }
        } else if let Some(src_value) = src_item.as_value() {
            match dst.get_mut(key).and_then(Item::as_value_mut) {
                Some(dst_value) => replace_value(dst_value, src_value),
                None => {
                    let mut value = src_value.clone();
                    value.decor_mut().clear();
                    dst.insert(key, Item::Value(value));
                }
            }
        }
    }
}

/// Replaces `dst` with `src` if they differ, keeping `dst`'s surrounding whitespace and comments.
fn replace_value(dst: &mut Value, src: &Value) {
    if same_value(dst, src) {
        return;
    }
    let decor = dst.decor().clone();
    *dst = src.clone();
    *dst.decor_mut() = decor;
}

/// Compares values by meaning, so `'dark'` equals `"dark"` and `0x10` equals `16`.
fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::String(a), Value::String(b)) => a.value() == b.value(),
        (Value::Integer(a), Value::Integer(b)) => a.value() == b.value(),
        (Value::Float(a), Value::Float(b)) => a.value() == b.value(),
        (Value::Boolean(a), Value::Boolean(b)) => a.value() == b.value(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b.iter()).all(|(a, b)| same_value(a, b))
        }
        _ => {
            let (mut a, mut b) = (a.clone(), b.clone());
            a.decor_mut().clear();
            b.decor_mut().clear();
            a.to_string() == b.to_string()
        }
    }
}

fn first_line(s: &str) -> String {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("unknown error")
        .to_string()
}

/// Writes via a temp file and rename so a crash never leaves a half-written file.
fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dark() -> Settings {
        Settings {
            appearance: Appearance { theme: Theme::Dark },
        }
    }

    fn read(dir: &Path) -> String {
        std::fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap()
    }

    #[test]
    fn default_file_matches_default_settings() {
        let doc: DocumentMut = DEFAULT_FILE.parse().unwrap();
        let parsed: Settings = toml_edit::de::from_document(doc).unwrap();
        assert_eq!(parsed, Settings::default());
    }

    #[test]
    fn creates_file_with_defaults_and_comments() {
        let dir = tempfile::tempdir().unwrap();
        let file = SettingsFile::load(dir.path()).unwrap();
        assert_eq!(file.settings(), &Settings::default());
        assert_eq!(file.snapshot().warning, None);
        let text = read(dir.path());
        assert!(text.contains("[appearance]"));
        assert!(text.contains("# Color theme"));
        assert!(text.contains("theme = \"system\""));
    }

    #[test]
    fn missing_keys_use_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), "# empty\n").unwrap();
        let file = SettingsFile::load(dir.path()).unwrap();
        assert_eq!(file.settings(), &Settings::default());
        assert_eq!(file.snapshot().warning, None);
    }

    #[test]
    fn update_preserves_comments_order_formatting_and_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let original = r#"# My settings

[editor]
# not known yet
future_flag = true

[appearance]
# I like it dark
theme   =   "light"   # trailing note
custom_key = 42
"#;
        std::fs::write(dir.path().join(SETTINGS_FILE), original).unwrap();
        let mut file = SettingsFile::load(dir.path()).unwrap();
        assert_eq!(file.settings().appearance.theme, Theme::Light);

        file.update(dark()).unwrap();

        let expected = original.replace(r#"theme   =   "light""#, r#"theme   =   "dark""#);
        assert_eq!(read(dir.path()), expected);

        let reloaded = SettingsFile::load(dir.path()).unwrap();
        assert_eq!(reloaded.settings(), &dark());
    }

    #[test]
    fn update_without_change_leaves_file_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let original = "[appearance]\ntheme='dark' # single quotes\n";
        std::fs::write(dir.path().join(SETTINGS_FILE), original).unwrap();
        let mut file = SettingsFile::load(dir.path()).unwrap();
        file.update(dark()).unwrap();
        assert_eq!(read(dir.path()), original);
    }

    #[test]
    fn update_adds_missing_section() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), "# only a comment\n").unwrap();
        let mut file = SettingsFile::load(dir.path()).unwrap();
        file.update(dark()).unwrap();
        let text = read(dir.path());
        assert!(text.starts_with("# only a comment\n"));
        let reloaded = SettingsFile::load(dir.path()).unwrap();
        assert_eq!(reloaded.settings(), &dark());
    }

    #[test]
    fn update_works_with_inline_table() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            "appearance = { theme = \"light\", x = 1 }\n",
        )
        .unwrap();
        let mut file = SettingsFile::load(dir.path()).unwrap();
        file.update(dark()).unwrap();
        assert_eq!(
            read(dir.path()),
            "appearance = { theme = \"dark\", x = 1 }\n"
        );
    }

    #[test]
    fn invalid_toml_keeps_file_and_warns() {
        let dir = tempfile::tempdir().unwrap();
        let broken = "[appearance\ntheme = \"dark\"\n";
        std::fs::write(dir.path().join(SETTINGS_FILE), broken).unwrap();

        let mut file = SettingsFile::load(dir.path()).unwrap();
        assert_eq!(file.settings(), &Settings::default());
        assert!(file.snapshot().warning.unwrap().contains("not valid TOML"));

        let after = file.update(dark()).unwrap();
        assert_eq!(after.settings, dark());
        assert!(after.warning.is_some());
        assert_eq!(read(dir.path()), broken);
    }

    #[test]
    fn invalid_value_warns_and_update_fixes_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            "[appearance]\ntheme = \"purple\"\n",
        )
        .unwrap();
        let mut file = SettingsFile::load(dir.path()).unwrap();
        assert_eq!(file.settings(), &Settings::default());
        assert!(file.snapshot().warning.unwrap().contains("invalid value"));

        let after = file.update(dark()).unwrap();
        assert_eq!(after.warning, None);
        assert_eq!(read(dir.path()), "[appearance]\ntheme = \"dark\"\n");
    }
}
