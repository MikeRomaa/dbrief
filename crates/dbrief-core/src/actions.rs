//! What the app's commands do with connections, secrets and sessions together: saving a connection
//! with its secrets, testing and connecting with stored or prompted secrets, and removing items.
//!
//! Errors say which secret to ask for ([`ActionError::SecretRequired`]), so the UI can prompt and retry
//! with the answer in `prompted`.

use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::connections::{
    self, AccessLevel, Connection, ConnectionInput, ConnectionRepo, ConnectionsError, Engine,
    ItemRef, Removed, SshAuth,
};
use crate::secrets::{SecretKind, Secrets, SecretsError};
use crate::session::{
    self, ConnectTarget, Credentials, SessionError, SessionInfo, SessionManager, TestResult,
};
use crate::ssh::{SshEnv, SshError};

#[derive(Debug, PartialEq, Eq, thiserror::Error, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ActionError {
    /// Connecting needs this secret, or the one given was rejected.
    #[error("{message}")]
    SecretRequired { secret: SecretKind, message: String },
    #[error("{message}")]
    Failed { message: String },
}

impl ActionError {
    pub fn failed(message: impl fmt::Display) -> Self {
        Self::Failed {
            message: message.to_string(),
        }
    }
}

impl From<ConnectionsError> for ActionError {
    fn from(e: ConnectionsError) -> Self {
        Self::failed(e)
    }
}

impl From<SecretsError> for ActionError {
    fn from(e: SecretsError) -> Self {
        Self::failed(e)
    }
}

/// What to do with one secret when saving a connection.
#[derive(Clone, Default, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "action", content = "value", rename_all = "kebab-case")]
pub enum SecretChange {
    #[default]
    Keep,
    Set(String),
    Clear,
}

impl fmt::Debug for SecretChange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Keep => "Keep",
            Self::Set(_) => "Set(…)",
            Self::Clear => "Clear",
        })
    }
}

/// Secret changes from the Add connection modal. A secret the connection no longer uses (say, the
/// SSH password after switching to a key) is deleted whatever its change says.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SecretChanges {
    #[serde(default)]
    pub password: SecretChange,
    #[serde(default)]
    pub ssh_password: SecretChange,
    #[serde(default)]
    pub ssh_passphrase: SecretChange,
}

impl SecretChanges {
    fn get(&self, kind: SecretKind) -> &SecretChange {
        match kind {
            SecretKind::Password => &self.password,
            SecretKind::SshPassword => &self.ssh_password,
            SecretKind::SshPassphrase => &self.ssh_passphrase,
        }
    }
}

/// Which secrets are saved for a connection, so the modal can show them as filled without reading them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SavedSecrets {
    pub password: bool,
    pub ssh_password: bool,
    pub ssh_passphrase: bool,
}

/// A saved connection. `warning` is set when the connection was saved but its secrets weren't.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Saved {
    pub connection: Connection,
    pub warning: Option<String>,
}

/// An opened session. `warning` is set when the prompted secrets couldn't be remembered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Connected {
    pub session: SessionInfo,
    pub warning: Option<String>,
}

/// Whether the connection uses this kind of secret at all.
fn uses(input: &ConnectionInput, kind: SecretKind) -> bool {
    let ssh_auth = input
        .ssh
        .as_ref()
        .filter(|_| input.engine == Engine::Postgres)
        .map(|t| &t.auth);
    match kind {
        SecretKind::Password => input.engine == Engine::Postgres,
        SecretKind::SshPassword => matches!(ssh_auth, Some(SshAuth::Password)),
        SecretKind::SshPassphrase => matches!(ssh_auth, Some(SshAuth::PrivateKey { .. })),
    }
}

fn apply_secret_changes(
    secrets: &Secrets,
    id: Uuid,
    input: &ConnectionInput,
    changes: &SecretChanges,
) -> Result<(), SecretsError> {
    for kind in SecretKind::ALL {
        match changes.get(kind) {
            _ if !uses(input, kind) => secrets.delete(id, kind)?,
            SecretChange::Keep => {}
            SecretChange::Set(secret) => secrets.set(id, kind, secret)?,
            SecretChange::Clear => secrets.delete(id, kind)?,
        }
    }

    Ok(())
}

fn secret_warning(result: Result<(), SecretsError>) -> Option<String> {
    result
        .err()
        .map(|e| format!("the connection was saved, but its secrets were not: {e}"))
}

pub fn saved_secrets(secrets: &Secrets, id: Uuid) -> SavedSecrets {
    let has = |kind| matches!(secrets.get(id, kind), Ok(Some(_)));
    SavedSecrets {
        password: has(SecretKind::Password),
        ssh_password: has(SecretKind::SshPassword),
        ssh_passphrase: has(SecretKind::SshPassphrase),
    }
}

pub async fn create_connection(
    repo: &ConnectionRepo,
    secrets: &Secrets,
    input: ConnectionInput,
    changes: &SecretChanges,
) -> Result<Saved, ActionError> {
    let connection = repo.create_connection(input).await?;
    let warning = secret_warning(apply_secret_changes(
        secrets,
        connection.id,
        &connection.input,
        changes,
    ));
    Ok(Saved {
        connection,
        warning,
    })
}

/// Saves the edits. Open sessions keep the settings they were opened with until they reconnect.
pub async fn update_connection(
    repo: &ConnectionRepo,
    secrets: &Secrets,
    id: Uuid,
    input: ConnectionInput,
    changes: &SecretChanges,
) -> Result<Saved, ActionError> {
    let connection = repo.update_connection(id, input).await?;
    let warning = secret_warning(apply_secret_changes(
        secrets,
        id,
        &connection.input,
        changes,
    ));
    Ok(Saved {
        connection,
        warning,
    })
}

/// A copy named "<name> copy" at the end of the same folder, with the same secrets. Not pinned.
pub async fn duplicate_connection(
    repo: &ConnectionRepo,
    secrets: &Secrets,
    id: Uuid,
) -> Result<Saved, ActionError> {
    let original = repo.connection(id).await?;
    let mut input = original.input;
    input.name = format!("{} copy", input.name);
    let connection = repo.create_connection(input).await?;

    let copied = SecretKind::ALL
        .iter()
        .try_for_each(|&kind| match secrets.get(id, kind)? {
            Some(secret) => secrets.set(connection.id, kind, &secret),
            None => Ok(()),
        });
    Ok(Saved {
        connection,
        warning: secret_warning(copied),
    })
}

/// Prompted secrets win over stored ones. A credential store that fails to answer counts as having
/// nothing stored, so the user is asked instead of being stuck.
fn credentials(secrets: &Secrets, id: Option<Uuid>, prompted: &Credentials) -> Credentials {
    let stored = |kind| id.and_then(|id| secrets.get(id, kind).ok().flatten());
    Credentials {
        password: prompted
            .password
            .clone()
            .or_else(|| stored(SecretKind::Password)),
        ssh_password: prompted
            .ssh_password
            .clone()
            .or_else(|| stored(SecretKind::SshPassword)),
        ssh_passphrase: prompted
            .ssh_passphrase
            .clone()
            .or_else(|| stored(SecretKind::SshPassphrase)),
    }
}

/// Tests unsaved settings from the modal. `id` is set when editing a saved connection, so its stored
/// secrets fill in what wasn't typed.
pub async fn test_connection(
    secrets: &Secrets,
    ssh_env: &SshEnv,
    id: Option<Uuid>,
    input: &ConnectionInput,
    prompted: &Credentials,
) -> Result<TestResult, ActionError> {
    let credentials = credentials(secrets, id, prompted);
    let target = ConnectTarget::new(id.unwrap_or_default(), input, &credentials, ssh_env)
        .map_err(|e| session_error(e, input))?;
    session::test(&target)
        .await
        .map_err(|e| session_error(e, input))
}

/// Opens a session for a saved connection. Prompted secrets that worked are saved when `remember`
/// is set, and always kept for this app session when there is no credential store.
pub async fn connect(
    repo: &ConnectionRepo,
    secrets: &Secrets,
    sessions: &SessionManager,
    ssh_env: &SshEnv,
    id: Uuid,
    prompted: &Credentials,
    remember: bool,
) -> Result<Connected, ActionError> {
    let connection = repo.connection(id).await?;
    let input = &connection.input;
    let credentials = credentials(secrets, Some(id), prompted);
    let target = ConnectTarget::new(id, input, &credentials, ssh_env)
        .map_err(|e| session_error(e, input))?;
    let session = sessions
        .open(target)
        .await
        .map_err(|e| session_error(e, input))?;

    let mut warnings = Vec::new();
    if let Err(e) = repo.record_connected(id, &session.server_version).await {
        warnings.push(format!("could not record the connection as used: {e}"));
    }
    if let Err(e) = remember_prompted(secrets, id, input, prompted, remember) {
        warnings.push(format!("could not save the secrets: {e}"));
    }

    Ok(Connected {
        session,
        warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
    })
}

fn remember_prompted(
    secrets: &Secrets,
    id: Uuid,
    input: &ConnectionInput,
    prompted: &Credentials,
    remember: bool,
) -> Result<(), SecretsError> {
    if !remember && secrets.persistent() {
        return Ok(());
    }

    let given = [
        (SecretKind::Password, &prompted.password),
        (SecretKind::SshPassword, &prompted.ssh_password),
        (SecretKind::SshPassphrase, &prompted.ssh_passphrase),
    ];
    for (kind, secret) in given {
        if let Some(secret) = secret
            && uses(input, kind)
        {
            secrets.set(id, kind, secret)?;
        }
    }

    Ok(())
}

/// File extensions offered for SQLite files and registered for "Open with".
pub const SQLITE_EXTENSIONS: [&str; 5] = ["db", "sqlite", "sqlite3", "db3", "s3db"];

/// The connection for a SQLite file: an existing one with the same canonical path, or a new RW
/// connection at the root named after the file. `created` tells which.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct OpenedFile {
    pub connection: Connection,
    pub created: bool,
}

pub async fn open_sqlite_file(
    repo: &ConnectionRepo,
    path: &Path,
) -> Result<OpenedFile, ActionError> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| ActionError::failed(format!("could not open {}: {e}", path.display())))?;
    if !canonical.is_file() {
        return Err(ActionError::failed(format!(
            "{} is not a file",
            canonical.display()
        )));
    }
    let canonical_text = canonical.display().to_string();

    let existing = repo.connections().await?.into_iter().find(|c| {
        c.input.engine == Engine::Sqlite && c.input.file_path.as_deref() == Some(&canonical_text)
    });
    if let Some(connection) = existing {
        return Ok(OpenedFile {
            connection,
            created: false,
        });
    }

    let name = canonical.file_name().map_or_else(
        || canonical_text.clone(),
        |n| n.to_string_lossy().into_owned(),
    );
    let mut input = ConnectionInput::new(name, Engine::Sqlite, AccessLevel::Rw);
    input.file_path = Some(canonical_text);
    Ok(OpenedFile {
        connection: repo.create_connection(input).await?,
        created: true,
    })
}

/// Removes a folder or connection with its secrets, closing the sessions of every removed connection.
pub async fn remove_item(
    repo: &ConnectionRepo,
    secrets: &Secrets,
    sessions: &SessionManager,
    item: ItemRef,
) -> Result<Removed, ActionError> {
    let removed = connections::remove(repo, secrets, item).await?;
    for id in &removed.connections {
        sessions.close_connection(*id).await;
    }

    Ok(removed)
}

/// Turns a session error into what the UI acts on: a secret to ask for, or a message.
fn session_error(e: SessionError, input: &ConnectionInput) -> ActionError {
    let ssh_password_auth = matches!(input.ssh.as_ref().map(|t| &t.auth), Some(SshAuth::Password));
    let secret = match &e {
        SessionError::PasswordRejected(_) => Some(SecretKind::Password),
        SessionError::Ssh(SshError::PasswordRequired) => Some(SecretKind::SshPassword),
        SessionError::Ssh(SshError::AuthFailed(_)) if ssh_password_auth => {
            Some(SecretKind::SshPassword)
        }
        SessionError::Ssh(SshError::PassphraseRequired(_) | SshError::WrongPassphrase(_)) => {
            Some(SecretKind::SshPassphrase)
        }
        _ => None,
    };

    let message = e.to_string();
    match secret {
        Some(secret) => ActionError::SecretRequired { secret, message },
        None => ActionError::Failed { message },
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::Storage;
    use crate::connections::SshTunnel;
    use crate::secrets::MemoryStore;

    async fn repo() -> (tempfile::TempDir, ConnectionRepo) {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path()).await.unwrap();
        (dir, ConnectionRepo::new(storage.pool().clone()))
    }

    fn store(persistent: bool) -> Secrets {
        Secrets::new(Box::new(MemoryStore::default()), persistent)
    }

    fn pg(auth: Option<SshAuth>) -> ConnectionInput {
        let mut input = ConnectionInput::new("pg", Engine::Postgres, AccessLevel::Rw);
        input.host = Some("db.internal".into());
        input.ssh = auth.map(|auth| SshTunnel {
            host: "bastion".into(),
            port: None,
            user: None,
            auth,
        });
        input
    }

    fn set(secret: &str) -> SecretChange {
        SecretChange::Set(secret.into())
    }

    #[tokio::test]
    async fn saving_stores_only_secrets_the_connection_uses() {
        let (_dir, repo) = repo().await;
        let secrets = store(true);
        let all = SecretChanges {
            password: set("db"),
            ssh_password: set("ssh"),
            ssh_passphrase: set("key"),
        };

        let saved = create_connection(&repo, &secrets, pg(Some(SshAuth::Password)), &all)
            .await
            .unwrap();
        let id = saved.connection.id;
        assert_eq!(saved.warning, None);
        assert_eq!(
            saved_secrets(&secrets, id),
            SavedSecrets {
                password: true,
                ssh_password: true,
                ssh_passphrase: false,
            }
        );

        // Switching to a key drops the SSH password; Keep leaves the rest alone.
        let key = SshAuth::PrivateKey {
            key_path: "~/.ssh/id".into(),
        };
        let changes = SecretChanges {
            ssh_passphrase: set("key"),
            ..SecretChanges::default()
        };
        update_connection(&repo, &secrets, id, pg(Some(key)), &changes)
            .await
            .unwrap();
        assert_eq!(
            saved_secrets(&secrets, id),
            SavedSecrets {
                password: true,
                ssh_password: false,
                ssh_passphrase: true,
            }
        );

        // Clear removes; removing the tunnel drops its passphrase.
        let clear = SecretChanges {
            password: SecretChange::Clear,
            ..SecretChanges::default()
        };
        update_connection(&repo, &secrets, id, pg(None), &clear)
            .await
            .unwrap();
        assert_eq!(saved_secrets(&secrets, id), SavedSecrets::default());
    }

    #[tokio::test]
    async fn duplicate_copies_settings_and_secrets() {
        let (_dir, repo) = repo().await;
        let secrets = store(true);
        let changes = SecretChanges {
            password: set("db"),
            ..SecretChanges::default()
        };
        let original = create_connection(&repo, &secrets, pg(None), &changes)
            .await
            .unwrap()
            .connection;
        repo.set_pinned(original.id, true).await.unwrap();

        let copy = duplicate_connection(&repo, &secrets, original.id)
            .await
            .unwrap()
            .connection;
        assert_ne!(copy.id, original.id);
        assert_eq!(copy.input.name, "pg copy");
        assert_eq!(copy.input.host, original.input.host);
        assert!(!copy.pinned);
        assert_eq!(
            secrets
                .get(copy.id, SecretKind::Password)
                .unwrap()
                .as_deref(),
            Some("db")
        );
    }

    #[test]
    fn prompted_secrets_win_over_stored_ones() {
        let secrets = store(true);
        let id = Uuid::new_v4();
        secrets.set(id, SecretKind::Password, "stored").unwrap();
        secrets
            .set(id, SecretKind::SshPassword, "stored-ssh")
            .unwrap();

        let prompted = Credentials::password("typed");
        let creds = credentials(&secrets, Some(id), &prompted);
        assert_eq!(creds.password.as_deref(), Some("typed"));
        assert_eq!(creds.ssh_password.as_deref(), Some("stored-ssh"));

        assert_eq!(
            credentials(&secrets, None, &Credentials::default()),
            Credentials::default()
        );
    }

    #[test]
    fn prompted_secrets_are_kept_when_asked_or_when_there_is_no_store() {
        let id = Uuid::new_v4();
        let input = pg(None);
        let prompted = Credentials {
            password: Some("typed".into()),
            ssh_password: Some("unused".into()),
            ssh_passphrase: None,
        };

        let keychain = store(true);
        remember_prompted(&keychain, id, &input, &prompted, false).unwrap();
        assert_eq!(saved_secrets(&keychain, id), SavedSecrets::default());
        remember_prompted(&keychain, id, &input, &prompted, true).unwrap();
        assert_eq!(
            saved_secrets(&keychain, id),
            SavedSecrets {
                password: true,
                ..SavedSecrets::default()
            }
        );

        let memory = store(false);
        remember_prompted(&memory, id, &input, &prompted, false).unwrap();
        assert!(saved_secrets(&memory, id).password);
    }

    #[test]
    fn session_errors_name_the_secret_to_ask_for() {
        let secret = |e: SessionError, input: &ConnectionInput| match session_error(e, input) {
            ActionError::SecretRequired { secret, .. } => Some(secret),
            ActionError::Failed { .. } => None,
        };
        let plain = pg(None);
        let by_password = pg(Some(SshAuth::Password));
        let by_agent = pg(Some(SshAuth::Agent));

        assert_eq!(
            secret(SessionError::PasswordRejected("no".into()), &plain),
            Some(SecretKind::Password)
        );
        assert_eq!(
            secret(SshError::PasswordRequired.into(), &by_password),
            Some(SecretKind::SshPassword)
        );
        assert_eq!(
            secret(SshError::AuthFailed("no".into()).into(), &by_password),
            Some(SecretKind::SshPassword)
        );
        assert_eq!(
            secret(SshError::AuthFailed("no".into()).into(), &by_agent),
            None
        );
        assert_eq!(
            secret(SshError::WrongPassphrase("k".into()).into(), &plain),
            Some(SecretKind::SshPassphrase)
        );
        assert_eq!(
            secret(SessionError::Connect("refused".into()), &plain),
            None
        );
    }

    #[tokio::test]
    async fn connect_and_remove_manage_sessions_and_secrets() {
        let (dir, repo) = repo().await;
        let secrets = store(true);
        let sessions = SessionManager::default();
        let env = SshEnv::new(Path::new("unused"));

        let file = dir.path().join("app.db");
        std::fs::File::create(&file).unwrap();
        let mut input = ConnectionInput::new("file", Engine::Sqlite, AccessLevel::Rw);
        input.file_path = Some(file.display().to_string());
        let id = repo.create_connection(input).await.unwrap().id;
        secrets.set(id, SecretKind::Password, "stale").unwrap();

        let connected = connect(
            &repo,
            &secrets,
            &sessions,
            &env,
            id,
            &Credentials::default(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(connected.warning, None);
        assert_eq!(connected.session.connection_id, id);
        let used = repo.connection(id).await.unwrap();
        assert!(used.last_used_at.is_some());
        assert!(used.server_version.unwrap().starts_with("SQLite 3."));
        assert_eq!(sessions.list().await.len(), 1);

        let removed = remove_item(&repo, &secrets, &sessions, ItemRef::Connection(id))
            .await
            .unwrap();
        assert_eq!(removed.connections, vec![id]);
        assert!(sessions.list().await.is_empty());
        assert_eq!(secrets.get(id, SecretKind::Password).unwrap(), None);

        let missing = connect(
            &repo,
            &secrets,
            &sessions,
            &env,
            id,
            &Credentials::default(),
            false,
        )
        .await;
        assert!(matches!(missing, Err(ActionError::Failed { .. })));
    }

    #[tokio::test]
    async fn opening_a_sqlite_file_reuses_its_connection() {
        let (dir, repo) = repo().await;
        let file = dir.path().join("shop.sqlite3");
        std::fs::File::create(&file).unwrap();

        let first = open_sqlite_file(&repo, &file).await.unwrap();
        assert!(first.created);
        assert_eq!(first.connection.input.name, "shop.sqlite3");
        assert_eq!(first.connection.input.access_level, AccessLevel::Rw);
        assert_eq!(first.connection.input.folder_id, None);

        // A different spelling of the same path finds the same connection.
        let again = open_sqlite_file(&repo, &dir.path().join(".").join("shop.sqlite3"))
            .await
            .unwrap();
        assert!(!again.created);
        assert_eq!(again.connection.id, first.connection.id);

        assert!(
            open_sqlite_file(&repo, &dir.path().join("missing.db"))
                .await
                .is_err()
        );
        assert!(open_sqlite_file(&repo, dir.path()).await.is_err());
    }
}
