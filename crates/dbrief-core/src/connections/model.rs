//! Folders and connections as stored in the app database.

use std::str::FromStr;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::ConnectionsError;

macro_rules! text_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[cfg_attr(feature = "specta", derive(specta::Type))]
        #[serde(rename_all = "kebab-case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }
        }

        impl FromStr for $name {
            type Err = ConnectionsError;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($text => Ok(Self::$variant),)+
                    _ => Err(ConnectionsError::Corrupt(format!(
                        "unknown {} {s:?}",
                        stringify!($name)
                    ))),
                }
            }
        }
    };
}

text_enum!(
    /// Database engine of a connection.
    Engine {
        Postgres => "postgres",
        Sqlite => "sqlite",
    }
);

text_enum!(
    /// What a connection's sessions may do: read only, read and write data, or also change the schema.
    AccessLevel {
        Ro => "ro",
        Rw => "rw",
        Ddl => "ddl",
    }
);

text_enum!(
    /// PostgreSQL `sslmode`.
    SslMode {
        Disable => "disable",
        Allow => "allow",
        Prefer => "prefer",
        Require => "require",
        VerifyCa => "verify-ca",
        VerifyFull => "verify-full",
    }
);

impl AccessLevel {
    /// RO connections auto-commit; RW and DDL connections default to manual transactions.
    pub fn default_manual_transactions(self) -> bool {
        !matches!(self, Self::Ro)
    }
}

/// How the SSH tunnel authenticates. Passwords and key passphrases live in the credential store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "kebab-case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum SshAuth {
    Password,
    PrivateKey { key_path: String },
    Agent,
}

/// SSH tunnel through a bastion host. `host` is either a hostname or a `~/.ssh/config` alias;
/// `port` and `user` are optional when the alias provides them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SshTunnel {
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub auth: SshAuth,
}

/// The editable part of a connection: what the Add connection modal fills in.
/// Server fields apply to PostgreSQL; `file_path` (canonical absolute path) to SQLite.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ConnectionInput {
    pub name: String,
    pub folder_id: Option<Uuid>,
    pub engine: Engine,
    pub access_level: AccessLevel,
    pub color_tag: Option<String>,

    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub ssl_mode: Option<SslMode>,
    pub ca_cert_path: Option<String>,

    pub file_path: Option<String>,

    pub ssh: Option<SshTunnel>,

    pub connect_timeout_s: Option<u32>,
    pub query_timeout_s: Option<u32>,
    pub default_schema: Option<String>,
    pub startup_sql: Option<String>,

    pub confirm_before_commit: bool,
    pub manual_transactions: bool,
}

impl ConnectionInput {
    /// A connection with defaults for `engine` and `access_level`.
    pub fn new(name: impl Into<String>, engine: Engine, access_level: AccessLevel) -> Self {
        Self {
            name: name.into(),
            folder_id: None,
            engine,
            access_level,
            color_tag: None,
            host: None,
            port: None,
            database: None,
            username: None,
            ssl_mode: None,
            ca_cert_path: None,
            file_path: None,
            ssh: None,
            connect_timeout_s: None,
            query_timeout_s: None,
            default_schema: None,
            startup_sql: None,
            confirm_before_commit: false,
            manual_transactions: access_level.default_manual_transactions(),
        }
    }

    pub fn validate(&self) -> Result<(), ConnectionsError> {
        if self.name.trim().is_empty() {
            return Err(ConnectionsError::Invalid("name is required".into()));
        }

        match self.engine {
            Engine::Postgres if blank(&self.host) => {
                Err(ConnectionsError::Invalid("host is required".into()))
            }
            Engine::Sqlite if blank(&self.file_path) => {
                Err(ConnectionsError::Invalid("file path is required".into()))
            }
            _ => Ok(()),
        }
    }
}

fn blank(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(|v| v.trim().is_empty())
}

/// A saved connection. Timestamps are ISO 8601 UTC strings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Connection {
    pub id: Uuid,
    #[serde(flatten)]
    pub input: ConnectionInput,
    pub pinned: bool,
    pub sort_order: f64,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Folder {
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub sort_order: f64,
}

/// A folder or a connection, e.g. the item being moved or deleted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "kebab-case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum ItemRef {
    Folder(Uuid),
    Connection(Uuid),
}

/// What deleting an item removes. Counts for history, diagrams, and schema cache are added by the
/// milestones that introduce those tables.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct DeleteCounts {
    pub folders: u32,
    pub connections: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enums_round_trip_through_text() {
        for level in [AccessLevel::Ro, AccessLevel::Rw, AccessLevel::Ddl] {
            assert_eq!(level.as_str().parse::<AccessLevel>().unwrap(), level);
        }
        assert_eq!(
            "verify-full".parse::<SslMode>().unwrap(),
            SslMode::VerifyFull
        );
        assert!("mysql".parse::<Engine>().is_err());
    }

    #[test]
    fn manual_transactions_default_by_access_level() {
        assert!(!ConnectionInput::new("a", Engine::Sqlite, AccessLevel::Ro).manual_transactions);
        assert!(ConnectionInput::new("a", Engine::Sqlite, AccessLevel::Rw).manual_transactions);
        assert!(ConnectionInput::new("a", Engine::Sqlite, AccessLevel::Ddl).manual_transactions);
    }

    #[test]
    fn validation_requires_name_and_engine_fields() {
        let mut pg = ConnectionInput::new("db", Engine::Postgres, AccessLevel::Rw);
        assert!(pg.validate().is_err());
        pg.host = Some("localhost".into());
        assert!(pg.validate().is_ok());
        pg.name = "  ".into();
        assert!(pg.validate().is_err());

        let mut lite = ConnectionInput::new("file", Engine::Sqlite, AccessLevel::Rw);
        assert!(lite.validate().is_err());
        lite.file_path = Some("/tmp/a.db".into());
        assert!(lite.validate().is_ok());
    }

    #[test]
    fn ssh_tunnel_json_shape() {
        let tunnel = SshTunnel {
            host: "bastion".into(),
            port: None,
            user: Some("me".into()),
            auth: SshAuth::PrivateKey {
                key_path: "~/.ssh/id_ed25519".into(),
            },
        };
        let json = serde_json::to_string(&tunnel).unwrap();
        assert_eq!(
            json,
            r#"{"host":"bastion","port":null,"user":"me","auth":{"method":"private-key","key_path":"~/.ssh/id_ed25519"}}"#
        );
        assert_eq!(serde_json::from_str::<SshTunnel>(&json).unwrap(), tunnel);
    }
}
