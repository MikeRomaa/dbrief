//! Saved connections and the folders that organize them.

mod model;
mod repo;
mod tree;

#[cfg(test)]
mod tests;

use uuid::Uuid;

use crate::secrets::Secrets;

pub use model::{
    AccessLevel, Connection, ConnectionInput, DeleteCounts, Engine, Folder, ItemRef, SshAuth,
    SshTunnel, SslMode,
};
pub use repo::ConnectionRepo;
pub use tree::{ConnectionTree, FolderNode, TreeNode, build_tree};

#[derive(Debug, thiserror::Error)]
pub enum ConnectionsError {
    #[error("{0:?} was not found")]
    NotFound(ItemRef),
    #[error("{0}")]
    Invalid(String),
    #[error("stored data is invalid: {0}")]
    Corrupt(String),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

/// What [`remove`] deleted. `secret_errors` lists credential store failures; the rows are deleted
/// regardless, so a broken credential store never keeps a connection around.
#[derive(Debug, Default)]
pub struct Removed {
    pub connections: Vec<Uuid>,
    pub secret_errors: Vec<String>,
}

/// Deletes a folder or connection and the secrets of every connection it removed.
pub async fn remove(
    repo: &ConnectionRepo,
    secrets: &Secrets,
    item: ItemRef,
) -> Result<Removed, ConnectionsError> {
    let connections = repo.delete(item).await?;
    let secret_errors = connections
        .iter()
        .filter_map(|id| secrets.delete_all(*id).err().map(|e| format!("{id}: {e}")))
        .collect();

    Ok(Removed {
        connections,
        secret_errors,
    })
}
