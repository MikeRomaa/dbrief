//! Reads and writes folders and connections in the app database.

use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use super::ConnectionsError;
use super::model::{Connection, ConnectionInput, DeleteCounts, Folder, ItemRef, SshTunnel};
use super::tree::{ConnectionTree, build_tree};

/// Folder and connection storage. Sibling order is a single `sort_order` per parent, shared by
/// folders and connections; moves renumber the target parent's children from 0.
#[derive(Clone, Debug)]
pub struct ConnectionRepo {
    pool: SqlitePool,
}

/// A `connections` row as SQLite returns it, before parsing into [`Connection`].
struct ConnectionRow {
    id: String,
    folder_id: Option<String>,
    name: String,
    engine: String,
    access_level: String,
    color_tag: Option<String>,
    pinned: bool,
    sort_order: f64,
    host: Option<String>,
    port: Option<i64>,
    database: Option<String>,
    username: Option<String>,
    ssl_mode: Option<String>,
    ca_cert_path: Option<String>,
    file_path: Option<String>,
    ssh: Option<String>,
    connect_timeout_s: Option<i64>,
    query_timeout_s: Option<i64>,
    default_schema: Option<String>,
    startup_sql: Option<String>,
    confirm_before_commit: bool,
    manual_transactions: bool,
    created_at: String,
    last_used_at: Option<String>,
    server_version: Option<String>,
}

impl TryFrom<ConnectionRow> for Connection {
    type Error = ConnectionsError;

    fn try_from(row: ConnectionRow) -> Result<Self, Self::Error> {
        Ok(Connection {
            id: parse_id(&row.id)?,
            input: ConnectionInput {
                name: row.name,
                folder_id: row.folder_id.as_deref().map(parse_id).transpose()?,
                engine: row.engine.parse()?,
                access_level: row.access_level.parse()?,
                color_tag: row.color_tag,
                host: row.host,
                port: row.port.map(int_to).transpose()?,
                database: row.database,
                username: row.username,
                ssl_mode: row.ssl_mode.as_deref().map(str::parse).transpose()?,
                ca_cert_path: row.ca_cert_path,
                file_path: row.file_path,
                ssh: row
                    .ssh
                    .as_deref()
                    .map(serde_json::from_str::<SshTunnel>)
                    .transpose()
                    .map_err(|e| ConnectionsError::Corrupt(format!("ssh settings: {e}")))?,
                connect_timeout_s: row.connect_timeout_s.map(int_to).transpose()?,
                query_timeout_s: row.query_timeout_s.map(int_to).transpose()?,
                default_schema: row.default_schema,
                startup_sql: row.startup_sql,
                confirm_before_commit: row.confirm_before_commit,
                manual_transactions: row.manual_transactions,
            },
            pinned: row.pinned,
            sort_order: row.sort_order,
            created_at: row.created_at,
            last_used_at: row.last_used_at,
            server_version: row.server_version,
        })
    }
}

fn parse_id(text: &str) -> Result<Uuid, ConnectionsError> {
    Uuid::parse_str(text).map_err(|e| ConnectionsError::Corrupt(format!("id {text:?}: {e}")))
}

fn int_to<T: TryFrom<i64>>(value: i64) -> Result<T, ConnectionsError> {
    T::try_from(value)
        .map_err(|_| ConnectionsError::Corrupt(format!("number out of range: {value}")))
}

fn ssh_json(ssh: &Option<SshTunnel>) -> Option<String> {
    ssh.as_ref()
        .map(|s| serde_json::to_string(s).expect("SshTunnel always serializes"))
}

/// A child of some parent, for reordering.
struct Sibling {
    item: ItemRef,
    sort_order: f64,
    name: String,
}

impl ConnectionRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn tree(&self) -> Result<ConnectionTree, ConnectionsError> {
        Ok(build_tree(self.folders().await?, self.connections().await?))
    }

    pub async fn folders(&self) -> Result<Vec<Folder>, ConnectionsError> {
        let rows = sqlx::query!(
            r#"
            SELECT
                id,
                parent_id,
                name,
                sort_order
            FROM
                folders
            "#
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|r| {
                Ok(Folder {
                    id: parse_id(&r.id)?,
                    parent_id: r.parent_id.as_deref().map(parse_id).transpose()?,
                    name: r.name,
                    sort_order: r.sort_order,
                })
            })
            .collect()
    }

    pub async fn connections(&self) -> Result<Vec<Connection>, ConnectionsError> {
        let rows = sqlx::query_as!(
            ConnectionRow,
            r#"
            SELECT
                id,
                folder_id,
                name,
                engine,
                access_level,
                color_tag,
                pinned AS "pinned: bool",
                sort_order,
                host,
                port,
                database,
                username,
                ssl_mode,
                ca_cert_path,
                file_path,
                ssh,
                connect_timeout_s,
                query_timeout_s,
                default_schema,
                startup_sql,
                confirm_before_commit AS "confirm_before_commit: bool",
                manual_transactions AS "manual_transactions: bool",
                created_at,
                last_used_at,
                server_version
            FROM
                connections
            "#
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(Connection::try_from).collect()
    }

    pub async fn connection(&self, id: Uuid) -> Result<Connection, ConnectionsError> {
        let id_text = id.to_string();
        let row = sqlx::query_as!(
            ConnectionRow,
            r#"
            SELECT
                id,
                folder_id,
                name,
                engine,
                access_level,
                color_tag,
                pinned AS "pinned: bool",
                sort_order,
                host,
                port,
                database,
                username,
                ssl_mode,
                ca_cert_path,
                file_path,
                ssh,
                connect_timeout_s,
                query_timeout_s,
                default_schema,
                startup_sql,
                confirm_before_commit AS "confirm_before_commit: bool",
                manual_transactions AS "manual_transactions: bool",
                created_at,
                last_used_at,
                server_version
            FROM
                connections
            WHERE
                id = ?
            "#,
            id_text
        )
        .fetch_optional(&self.pool)
        .await?
        .ok_or(ConnectionsError::NotFound(ItemRef::Connection(id)))?;

        row.try_into()
    }

    pub async fn create_folder(
        &self,
        name: &str,
        parent_id: Option<Uuid>,
    ) -> Result<Folder, ConnectionsError> {
        let name = folder_name(name)?;
        let mut tx = self.pool.begin().await?;
        if let Some(parent) = parent_id {
            ensure_folder_exists(&mut tx, parent).await?;
        }

        let folder = Folder {
            id: Uuid::new_v4(),
            parent_id,
            name,
            sort_order: next_sort_order(&mut tx, parent_id).await?,
        };
        let id = folder.id.to_string();
        let parent = folder.parent_id.map(|p| p.to_string());
        sqlx::query!(
            r#"
            INSERT INTO
                folders (id, parent_id, name, sort_order)
            VALUES
                (?, ?, ?, ?)
            "#,
            id,
            parent,
            folder.name,
            folder.sort_order
        )
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(folder)
    }

    pub async fn rename_folder(&self, id: Uuid, name: &str) -> Result<(), ConnectionsError> {
        let name = folder_name(name)?;
        let id_text = id.to_string();
        let result = sqlx::query!(
            r#"
            UPDATE
                folders
            SET
                name = ?
            WHERE
                id = ?
            "#,
            name,
            id_text
        )
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(ConnectionsError::NotFound(ItemRef::Folder(id)));
        }

        Ok(())
    }

    /// Adds the connection at the end of its folder.
    pub async fn create_connection(
        &self,
        input: ConnectionInput,
    ) -> Result<Connection, ConnectionsError> {
        input.validate()?;

        let mut tx = self.pool.begin().await?;
        if let Some(folder) = input.folder_id {
            ensure_folder_exists(&mut tx, folder).await?;
        }

        let id = Uuid::new_v4();
        let sort_order = next_sort_order(&mut tx, input.folder_id).await?;
        let id_text = id.to_string();
        let folder_id = input.folder_id.map(|f| f.to_string());
        let engine = input.engine.as_str();
        let access_level = input.access_level.as_str();
        let ssl_mode = input.ssl_mode.map(|m| m.as_str());
        let ssh = ssh_json(&input.ssh);
        sqlx::query!(
            r#"
            INSERT INTO
                connections (
                    id,
                    folder_id,
                    name,
                    engine,
                    access_level,
                    color_tag,
                    sort_order,
                    host,
                    port,
                    database,
                    username,
                    ssl_mode,
                    ca_cert_path,
                    file_path,
                    ssh,
                    connect_timeout_s,
                    query_timeout_s,
                    default_schema,
                    startup_sql,
                    confirm_before_commit,
                    manual_transactions
                )
            VALUES
                (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            id_text,
            folder_id,
            input.name,
            engine,
            access_level,
            input.color_tag,
            sort_order,
            input.host,
            input.port,
            input.database,
            input.username,
            ssl_mode,
            input.ca_cert_path,
            input.file_path,
            ssh,
            input.connect_timeout_s,
            input.query_timeout_s,
            input.default_schema,
            input.startup_sql,
            input.confirm_before_commit,
            input.manual_transactions
        )
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        self.connection(id).await
    }

    /// Replaces the editable fields. A change of folder moves the connection to the end of the new folder.
    pub async fn update_connection(
        &self,
        id: Uuid,
        input: ConnectionInput,
    ) -> Result<Connection, ConnectionsError> {
        input.validate()?;

        let current = self.connection(id).await?;
        let mut tx = self.pool.begin().await?;
        let sort_order = if current.input.folder_id == input.folder_id {
            current.sort_order
        } else {
            if let Some(folder) = input.folder_id {
                ensure_folder_exists(&mut tx, folder).await?;
            }

            next_sort_order(&mut tx, input.folder_id).await?
        };

        let id_text = id.to_string();
        let folder_id = input.folder_id.map(|f| f.to_string());
        let engine = input.engine.as_str();
        let access_level = input.access_level.as_str();
        let ssl_mode = input.ssl_mode.map(|m| m.as_str());
        let ssh = ssh_json(&input.ssh);
        sqlx::query!(
            r#"
            UPDATE
                connections
            SET
                folder_id = ?,
                name = ?,
                engine = ?,
                access_level = ?,
                color_tag = ?,
                sort_order = ?,
                host = ?,
                port = ?,
                database = ?,
                username = ?,
                ssl_mode = ?,
                ca_cert_path = ?,
                file_path = ?,
                ssh = ?,
                connect_timeout_s = ?,
                query_timeout_s = ?,
                default_schema = ?,
                startup_sql = ?,
                confirm_before_commit = ?,
                manual_transactions = ?
            WHERE
                id = ?
            "#,
            folder_id,
            input.name,
            engine,
            access_level,
            input.color_tag,
            sort_order,
            input.host,
            input.port,
            input.database,
            input.username,
            ssl_mode,
            input.ca_cert_path,
            input.file_path,
            ssh,
            input.connect_timeout_s,
            input.query_timeout_s,
            input.default_schema,
            input.startup_sql,
            input.confirm_before_commit,
            input.manual_transactions,
            id_text
        )
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        self.connection(id).await
    }

    pub async fn set_pinned(&self, id: Uuid, pinned: bool) -> Result<(), ConnectionsError> {
        let id_text = id.to_string();
        let result = sqlx::query!(
            r#"
            UPDATE
                connections
            SET
                pinned = ?
            WHERE
                id = ?
            "#,
            pinned,
            id_text
        )
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(ConnectionsError::NotFound(ItemRef::Connection(id)));
        }

        Ok(())
    }

    /// Records a successful connect: the time, and the server version shown in the Connections view.
    pub async fn record_connected(
        &self,
        id: Uuid,
        server_version: &str,
    ) -> Result<(), ConnectionsError> {
        let id_text = id.to_string();
        let result = sqlx::query!(
            r#"
            UPDATE
                connections
            SET
                last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                server_version = ?
            WHERE
                id = ?
            "#,
            server_version,
            id_text
        )
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(ConnectionsError::NotFound(ItemRef::Connection(id)));
        }

        Ok(())
    }

    /// Moves `item` into `parent` (`None` = root), just before `before`, or at the end when `before`
    /// is `None`. A folder can't be moved into itself or one of its descendants.
    pub async fn move_item(
        &self,
        item: ItemRef,
        parent: Option<Uuid>,
        before: Option<ItemRef>,
    ) -> Result<(), ConnectionsError> {
        if before == Some(item) {
            return Err(ConnectionsError::Invalid(
                "an item can't be placed before itself".into(),
            ));
        }

        let mut tx = self.pool.begin().await?;
        if let Some(parent) = parent {
            ensure_folder_exists(&mut tx, parent).await?;
        }

        let parent_text = parent.map(|p| p.to_string());
        match item {
            ItemRef::Folder(id) => {
                if let Some(target) = parent
                    && subtree_folder_ids(&mut tx, id).await?.contains(&target)
                {
                    return Err(ConnectionsError::Invalid(
                        "a folder can't be moved into itself or one of its subfolders".into(),
                    ));
                }

                let id_text = id.to_string();
                let result = sqlx::query!(
                    r#"
                    UPDATE
                        folders
                    SET
                        parent_id = ?
                    WHERE
                        id = ?
                    "#,
                    parent_text,
                    id_text
                )
                .execute(&mut *tx)
                .await?;
                if result.rows_affected() == 0 {
                    return Err(ConnectionsError::NotFound(item));
                }
            }
            ItemRef::Connection(id) => {
                let id_text = id.to_string();
                let result = sqlx::query!(
                    r#"
                    UPDATE
                        connections
                    SET
                        folder_id = ?
                    WHERE
                        id = ?
                    "#,
                    parent_text,
                    id_text
                )
                .execute(&mut *tx)
                .await?;
                if result.rows_affected() == 0 {
                    return Err(ConnectionsError::NotFound(item));
                }
            }
        }

        let mut siblings = siblings(&mut tx, parent).await?;
        let moved = siblings
            .iter()
            .position(|s| s.item == item)
            .expect("moved item is a sibling now");
        let moved = siblings.remove(moved);

        let index = match before {
            Some(target) => siblings
                .iter()
                .position(|s| s.item == target)
                .ok_or_else(|| {
                    ConnectionsError::Invalid("the target item is not in that folder".into())
                })?,
            None => siblings.len(),
        };
        siblings.insert(index, moved);

        for (order, sibling) in siblings.iter().enumerate() {
            set_sort_order(&mut tx, sibling.item, order as f64).await?;
        }

        tx.commit().await?;
        Ok(())
    }

    /// What [`Self::delete`] would remove, for the confirm dialog.
    pub async fn delete_counts(&self, item: ItemRef) -> Result<DeleteCounts, ConnectionsError> {
        let mut tx = self.pool.begin().await?;
        let counts = match item {
            ItemRef::Connection(id) => {
                ensure_connection_exists(&mut tx, id).await?;
                DeleteCounts {
                    folders: 0,
                    connections: 1,
                }
            }
            ItemRef::Folder(id) => {
                let folders = subtree_folder_ids(&mut tx, id).await?;
                if folders.is_empty() {
                    return Err(ConnectionsError::NotFound(item));
                }

                DeleteCounts {
                    folders: folders.len() as u32,
                    connections: subtree_connection_ids(&mut tx, id).await?.len() as u32,
                }
            }
        };

        tx.commit().await?;
        Ok(counts)
    }

    /// Deletes the item; a folder takes its subfolders and their connections with it. Returns the
    /// ids of every removed connection so their secrets can be deleted too.
    pub async fn delete(&self, item: ItemRef) -> Result<Vec<Uuid>, ConnectionsError> {
        let mut tx = self.pool.begin().await?;
        let removed = match item {
            ItemRef::Connection(id) => {
                let id_text = id.to_string();
                let result = sqlx::query!(
                    r#"
                    DELETE FROM
                        connections
                    WHERE
                        id = ?
                    "#,
                    id_text
                )
                .execute(&mut *tx)
                .await?;
                if result.rows_affected() == 0 {
                    return Err(ConnectionsError::NotFound(item));
                }

                vec![id]
            }
            ItemRef::Folder(id) => {
                let removed = subtree_connection_ids(&mut tx, id).await?;
                let id_text = id.to_string();
                let result = sqlx::query!(
                    r#"
                    DELETE FROM
                        folders
                    WHERE
                        id = ?
                    "#,
                    id_text
                )
                .execute(&mut *tx)
                .await?;
                if result.rows_affected() == 0 {
                    return Err(ConnectionsError::NotFound(item));
                }

                removed
            }
        };

        tx.commit().await?;
        Ok(removed)
    }
}

fn folder_name(name: &str) -> Result<String, ConnectionsError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ConnectionsError::Invalid("folder name is required".into()));
    }

    Ok(name.to_string())
}

async fn ensure_folder_exists(
    tx: &mut Transaction<'_, Sqlite>,
    id: Uuid,
) -> Result<(), ConnectionsError> {
    let id_text = id.to_string();
    let found = sqlx::query_scalar!(
        r#"
        SELECT
            1 AS found
        FROM
            folders
        WHERE
            id = ?
        "#,
        id_text
    )
    .fetch_optional(&mut **tx)
    .await?;

    found
        .map(|_| ())
        .ok_or(ConnectionsError::NotFound(ItemRef::Folder(id)))
}

async fn ensure_connection_exists(
    tx: &mut Transaction<'_, Sqlite>,
    id: Uuid,
) -> Result<(), ConnectionsError> {
    let id_text = id.to_string();
    let found = sqlx::query_scalar!(
        r#"
        SELECT
            1 AS found
        FROM
            connections
        WHERE
            id = ?
        "#,
        id_text
    )
    .fetch_optional(&mut **tx)
    .await?;

    found
        .map(|_| ())
        .ok_or(ConnectionsError::NotFound(ItemRef::Connection(id)))
}

/// One past the largest `sort_order` among the parent's folders and connections.
async fn next_sort_order(
    tx: &mut Transaction<'_, Sqlite>,
    parent: Option<Uuid>,
) -> Result<f64, ConnectionsError> {
    let parent = parent.map(|p| p.to_string());
    let max = sqlx::query_scalar!(
        r#"
        SELECT
            MAX(sort_order) AS "max: f64"
        FROM
            (
                SELECT
                    sort_order
                FROM
                    folders
                WHERE
                    parent_id IS ?
                UNION ALL
                SELECT
                    sort_order
                FROM
                    connections
                WHERE
                    folder_id IS ?
            )
        "#,
        parent,
        parent
    )
    .fetch_one(&mut **tx)
    .await?;

    Ok(max.map_or(0.0, |m| m.floor() + 1.0))
}

/// The parent's folders and connections in display order (same tie-breaks as the tree).
async fn siblings(
    tx: &mut Transaction<'_, Sqlite>,
    parent: Option<Uuid>,
) -> Result<Vec<Sibling>, ConnectionsError> {
    let parent = parent.map(|p| p.to_string());
    let folders = sqlx::query!(
        r#"
        SELECT
            id,
            name,
            sort_order
        FROM
            folders
        WHERE
            parent_id IS ?
        "#,
        parent
    )
    .fetch_all(&mut **tx)
    .await?;
    let connections = sqlx::query!(
        r#"
        SELECT
            id,
            name,
            sort_order
        FROM
            connections
        WHERE
            folder_id IS ?
        "#,
        parent
    )
    .fetch_all(&mut **tx)
    .await?;

    let mut siblings = Vec::with_capacity(folders.len() + connections.len());
    for f in folders {
        siblings.push(Sibling {
            item: ItemRef::Folder(parse_id(&f.id)?),
            sort_order: f.sort_order,
            name: f.name,
        });
    }
    for c in connections {
        siblings.push(Sibling {
            item: ItemRef::Connection(parse_id(&c.id)?),
            sort_order: c.sort_order,
            name: c.name,
        });
    }

    siblings.sort_by(|a, b| {
        a.sort_order
            .total_cmp(&b.sort_order)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| item_id(a.item).cmp(&item_id(b.item)))
    });
    Ok(siblings)
}

fn item_id(item: ItemRef) -> Uuid {
    match item {
        ItemRef::Folder(id) | ItemRef::Connection(id) => id,
    }
}

async fn set_sort_order(
    tx: &mut Transaction<'_, Sqlite>,
    item: ItemRef,
    order: f64,
) -> Result<(), ConnectionsError> {
    let id = item_id(item).to_string();
    match item {
        ItemRef::Folder(_) => {
            sqlx::query!(
                r#"
                UPDATE
                    folders
                SET
                    sort_order = ?
                WHERE
                    id = ?
                "#,
                order,
                id
            )
            .execute(&mut **tx)
            .await?;
        }
        ItemRef::Connection(_) => {
            sqlx::query!(
                r#"
                UPDATE
                    connections
                SET
                    sort_order = ?
                WHERE
                    id = ?
                "#,
                order,
                id
            )
            .execute(&mut **tx)
            .await?;
        }
    }

    Ok(())
}

/// The folder and every folder below it. Empty when the folder doesn't exist.
async fn subtree_folder_ids(
    tx: &mut Transaction<'_, Sqlite>,
    root: Uuid,
) -> Result<Vec<Uuid>, ConnectionsError> {
    let root = root.to_string();
    let ids = sqlx::query_scalar!(
        r#"
        WITH RECURSIVE
            subtree (id) AS (
                SELECT
                    id
                FROM
                    folders
                WHERE
                    id = ?
                UNION ALL
                SELECT
                    f.id
                FROM
                    folders f
                    JOIN subtree s ON f.parent_id = s.id
            )
        SELECT
            id AS "id!: String"
        FROM
            subtree
        "#,
        root
    )
    .fetch_all(&mut **tx)
    .await?;

    ids.iter().map(|id| parse_id(id)).collect()
}

/// Every connection inside the folder or its subfolders.
async fn subtree_connection_ids(
    tx: &mut Transaction<'_, Sqlite>,
    root: Uuid,
) -> Result<Vec<Uuid>, ConnectionsError> {
    let root = root.to_string();
    let ids = sqlx::query_scalar!(
        r#"
        WITH RECURSIVE
            subtree (id) AS (
                SELECT
                    id
                FROM
                    folders
                WHERE
                    id = ?
                UNION ALL
                SELECT
                    f.id
                FROM
                    folders f
                    JOIN subtree s ON f.parent_id = s.id
            )
        SELECT
            c.id AS "id!: String"
        FROM
            connections c
        WHERE
            c.folder_id IN (
                SELECT
                    id
                FROM
                    subtree
            )
        "#,
        root
    )
    .fetch_all(&mut **tx)
    .await?;

    ids.iter().map(|id| parse_id(id)).collect()
}
