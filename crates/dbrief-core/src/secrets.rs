//! Connection secrets (passwords, SSH passwords and passphrases). They live in the OS credential
//! store, never in the app database; without a store they are kept in memory for this app session.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Credential store service name. Each entry's account is `<connection-id>/<kind>`.
const SERVICE: &str = "dbrief";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum SecretKind {
    Password,
    SshPassword,
    SshPassphrase,
}

impl SecretKind {
    pub const ALL: [SecretKind; 3] = [Self::Password, Self::SshPassword, Self::SshPassphrase];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::SshPassword => "ssh-password",
            Self::SshPassphrase => "ssh-passphrase",
        }
    }
}

fn account(connection: Uuid, kind: SecretKind) -> String {
    format!("{connection}/{}", kind.as_str())
}

#[derive(Debug, thiserror::Error)]
pub enum SecretsError {
    #[error("credential store error: {0}")]
    Store(String),
}

/// A place to keep secrets. `get` returns `None` and `delete` succeeds when there is no entry.
pub trait SecretStore: Send + Sync {
    fn get(&self, connection: Uuid, kind: SecretKind) -> Result<Option<String>, SecretsError>;
    fn set(&self, connection: Uuid, kind: SecretKind, secret: &str) -> Result<(), SecretsError>;
    fn delete(&self, connection: Uuid, kind: SecretKind) -> Result<(), SecretsError>;
}

/// The OS credential store: macOS Keychain, Windows Credential Manager, or Linux Secret Service.
#[derive(Debug, Default)]
pub struct KeyringStore;

impl KeyringStore {
    /// Whether the platform credential store could be initialized.
    pub fn available() -> bool {
        keyring::Entry::store_status().is_ok()
    }

    fn entry(connection: Uuid, kind: SecretKind) -> Result<keyring::Entry, SecretsError> {
        keyring::Entry::new(SERVICE, &account(connection, kind)).map_err(store_error)
    }
}

fn store_error(e: keyring::Error) -> SecretsError {
    SecretsError::Store(e.to_string())
}

impl SecretStore for KeyringStore {
    fn get(&self, connection: Uuid, kind: SecretKind) -> Result<Option<String>, SecretsError> {
        match Self::entry(connection, kind)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(store_error(e)),
        }
    }

    fn set(&self, connection: Uuid, kind: SecretKind, secret: &str) -> Result<(), SecretsError> {
        Self::entry(connection, kind)?
            .set_password(secret)
            .map_err(store_error)
    }

    fn delete(&self, connection: Uuid, kind: SecretKind) -> Result<(), SecretsError> {
        match Self::entry(connection, kind)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(store_error(e)),
        }
    }
}

/// Secrets held in memory only, gone when the app quits. Used when no OS store is available, and in tests.
#[derive(Debug, Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<(Uuid, SecretKind), String>>,
}

impl MemoryStore {
    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<(Uuid, SecretKind), String>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl SecretStore for MemoryStore {
    fn get(&self, connection: Uuid, kind: SecretKind) -> Result<Option<String>, SecretsError> {
        Ok(self.entries().get(&(connection, kind)).cloned())
    }

    fn set(&self, connection: Uuid, kind: SecretKind, secret: &str) -> Result<(), SecretsError> {
        self.entries()
            .insert((connection, kind), secret.to_string());
        Ok(())
    }

    fn delete(&self, connection: Uuid, kind: SecretKind) -> Result<(), SecretsError> {
        self.entries().remove(&(connection, kind));
        Ok(())
    }
}

/// The app's secret store. `persistent` is false when falling back to memory, so the UI asks for
/// secrets on each connect instead of offering to save them.
pub struct Secrets {
    store: Box<dyn SecretStore>,
    persistent: bool,
}

impl Secrets {
    /// Uses the OS credential store when available, otherwise memory.
    pub fn detect() -> Self {
        if KeyringStore::available() {
            Self::new(Box::new(KeyringStore), true)
        } else {
            Self::new(Box::new(MemoryStore::default()), false)
        }
    }

    pub fn new(store: Box<dyn SecretStore>, persistent: bool) -> Self {
        Self { store, persistent }
    }

    pub fn persistent(&self) -> bool {
        self.persistent
    }

    pub fn get(&self, connection: Uuid, kind: SecretKind) -> Result<Option<String>, SecretsError> {
        self.store.get(connection, kind)
    }

    pub fn set(
        &self,
        connection: Uuid,
        kind: SecretKind,
        secret: &str,
    ) -> Result<(), SecretsError> {
        self.store.set(connection, kind, secret)
    }

    pub fn delete(&self, connection: Uuid, kind: SecretKind) -> Result<(), SecretsError> {
        self.store.delete(connection, kind)
    }

    /// Deletes every kind of secret for the connection. Tries all kinds even if one fails.
    pub fn delete_all(&self, connection: Uuid) -> Result<(), SecretsError> {
        let mut first_error = None;
        for kind in SecretKind::ALL {
            if let Err(e) = self.store.delete(connection, kind) {
                first_error.get_or_insert(e);
            }
        }

        first_error.map_or(Ok(()), Err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Secrets {
        Secrets::new(Box::new(MemoryStore::default()), false)
    }

    #[test]
    fn set_get_delete() {
        let secrets = memory();
        let id = Uuid::new_v4();

        assert_eq!(secrets.get(id, SecretKind::Password).unwrap(), None);
        secrets.set(id, SecretKind::Password, "hunter2").unwrap();
        assert_eq!(
            secrets.get(id, SecretKind::Password).unwrap().as_deref(),
            Some("hunter2")
        );
        assert_eq!(secrets.get(id, SecretKind::SshPassword).unwrap(), None);

        secrets.set(id, SecretKind::Password, "changed").unwrap();
        assert_eq!(
            secrets.get(id, SecretKind::Password).unwrap().as_deref(),
            Some("changed")
        );

        secrets.delete(id, SecretKind::Password).unwrap();
        assert_eq!(secrets.get(id, SecretKind::Password).unwrap(), None);
        secrets.delete(id, SecretKind::Password).unwrap();
    }

    #[test]
    fn delete_all_removes_every_kind_for_that_connection_only() {
        let secrets = memory();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        for kind in SecretKind::ALL {
            secrets.set(a, kind, "a").unwrap();
            secrets.set(b, kind, "b").unwrap();
        }

        secrets.delete_all(a).unwrap();

        for kind in SecretKind::ALL {
            assert_eq!(secrets.get(a, kind).unwrap(), None);
            assert_eq!(secrets.get(b, kind).unwrap().as_deref(), Some("b"));
        }
    }

    #[test]
    fn account_names() {
        let id = Uuid::nil();
        assert_eq!(
            account(id, SecretKind::SshPassphrase),
            "00000000-0000-0000-0000-000000000000/ssh-passphrase"
        );
    }

    /// Writes to the real OS credential store, so it only runs on request:
    /// `cargo test -p dbrief-core -- --ignored keyring`.
    #[test]
    #[ignore]
    fn keyring_round_trip() {
        assert!(KeyringStore::available(), "no OS credential store");
        let store = KeyringStore;
        let id = Uuid::new_v4();

        store.set(id, SecretKind::Password, "s3cret").unwrap();
        assert_eq!(
            store.get(id, SecretKind::Password).unwrap().as_deref(),
            Some("s3cret")
        );
        store.delete(id, SecretKind::Password).unwrap();
        assert_eq!(store.get(id, SecretKind::Password).unwrap(), None);
        store.delete(id, SecretKind::Password).unwrap();
    }
}
