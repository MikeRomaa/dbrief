//! Saved connections and the folders that organize them.

mod model;
mod repo;
mod tree;

#[cfg(test)]
mod tests;

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
