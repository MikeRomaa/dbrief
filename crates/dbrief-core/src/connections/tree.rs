//! Builds the Connections view tree from flat folder and connection rows.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::model::{Connection, Folder};

/// The Connections view: pinned connections (also listed in their folders) and the folder tree.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ConnectionTree {
    pub pinned: Vec<Connection>,
    pub root: Vec<TreeNode>,
}

/// Siblings are ordered by `sort_order`; folders and connections share one order per parent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum TreeNode {
    Folder(FolderNode),
    Connection(Box<Connection>),
}

/// A folder with its children. `connection_count` includes connections in nested folders.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct FolderNode {
    #[serde(flatten)]
    pub folder: Folder,
    pub connection_count: u32,
    pub children: Vec<TreeNode>,
}

impl TreeNode {
    fn sort_key(&self) -> (f64, String, Uuid) {
        match self {
            Self::Folder(f) => (
                f.folder.sort_order,
                f.folder.name.to_lowercase(),
                f.folder.id,
            ),
            Self::Connection(c) => (c.sort_order, c.input.name.to_lowercase(), c.id),
        }
    }

    fn connection_count(&self) -> u32 {
        match self {
            Self::Folder(f) => f.connection_count,
            Self::Connection(_) => 1,
        }
    }
}

fn by_sort_key(a: &TreeNode, b: &TreeNode) -> Ordering {
    let (ao, an, ai) = a.sort_key();
    let (bo, bn, bi) = b.sort_key();
    ao.total_cmp(&bo)
        .then_with(|| an.cmp(&bn))
        .then_with(|| ai.cmp(&bi))
}

/// Items whose parent folder is missing are placed at the root rather than dropped.
pub fn build_tree(folders: Vec<Folder>, connections: Vec<Connection>) -> ConnectionTree {
    let folder_ids: HashSet<Uuid> = folders.iter().map(|f| f.id).collect();
    let parent_of = |id: Option<Uuid>| id.filter(|p| folder_ids.contains(p));

    let mut pinned: Vec<Connection> = connections.iter().filter(|c| c.pinned).cloned().collect();
    pinned.sort_by(|a, b| {
        a.input
            .name
            .to_lowercase()
            .cmp(&b.input.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut folders_by_parent: HashMap<Option<Uuid>, Vec<Folder>> = HashMap::new();
    for folder in folders {
        folders_by_parent
            .entry(parent_of(folder.parent_id))
            .or_default()
            .push(folder);
    }

    let mut connections_by_parent: HashMap<Option<Uuid>, Vec<Connection>> = HashMap::new();
    for connection in connections {
        connections_by_parent
            .entry(parent_of(connection.input.folder_id))
            .or_default()
            .push(connection);
    }

    let root = build_level(None, &mut folders_by_parent, &mut connections_by_parent);

    ConnectionTree { pinned, root }
}

fn build_level(
    parent: Option<Uuid>,
    folders: &mut HashMap<Option<Uuid>, Vec<Folder>>,
    connections: &mut HashMap<Option<Uuid>, Vec<Connection>>,
) -> Vec<TreeNode> {
    let mut nodes: Vec<TreeNode> = connections
        .remove(&parent)
        .unwrap_or_default()
        .into_iter()
        .map(|c| TreeNode::Connection(Box::new(c)))
        .collect();

    for folder in folders.remove(&parent).unwrap_or_default() {
        let children = build_level(Some(folder.id), folders, connections);
        let connection_count = children.iter().map(TreeNode::connection_count).sum();
        nodes.push(TreeNode::Folder(FolderNode {
            folder,
            connection_count,
            children,
        }));
    }

    nodes.sort_by(by_sort_key);
    nodes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::model::{AccessLevel, ConnectionInput, Engine};

    fn folder(name: &str, parent: Option<Uuid>, order: f64) -> Folder {
        Folder {
            id: Uuid::new_v4(),
            parent_id: parent,
            name: name.into(),
            sort_order: order,
        }
    }

    fn conn(name: &str, folder: Option<Uuid>, order: f64, pinned: bool) -> Connection {
        let mut input = ConnectionInput::new(name, Engine::Sqlite, AccessLevel::Rw);
        input.folder_id = folder;
        Connection {
            id: Uuid::new_v4(),
            input,
            pinned,
            sort_order: order,
            created_at: String::new(),
            last_used_at: None,
        }
    }

    fn names(nodes: &[TreeNode]) -> Vec<&str> {
        nodes
            .iter()
            .map(|n| match n {
                TreeNode::Folder(f) => f.folder.name.as_str(),
                TreeNode::Connection(c) => c.input.name.as_str(),
            })
            .collect()
    }

    #[test]
    fn nests_folders_and_orders_siblings_together() {
        let prod = folder("prod", None, 1.0);
        let eu = folder("eu", Some(prod.id), 0.0);
        let tree = build_tree(
            vec![prod.clone(), eu.clone()],
            vec![
                conn("local", None, 0.0, false),
                conn("scratch", None, 2.0, false),
                conn("billing", Some(prod.id), 1.0, false),
                conn("eu-main", Some(eu.id), 0.0, false),
            ],
        );

        assert_eq!(names(&tree.root), ["local", "prod", "scratch"]);

        let TreeNode::Folder(prod_node) = &tree.root[1] else {
            panic!("expected folder");
        };
        assert_eq!(names(&prod_node.children), ["eu", "billing"]);
        assert_eq!(prod_node.connection_count, 2);
    }

    #[test]
    fn ties_break_by_name_case_insensitively() {
        let tree = build_tree(
            vec![],
            vec![
                conn("beta", None, 0.0, false),
                conn("Alpha", None, 0.0, false),
            ],
        );
        assert_eq!(names(&tree.root), ["Alpha", "beta"]);
    }

    #[test]
    fn pinned_connections_are_listed_by_name_and_stay_in_their_folder() {
        let team = folder("team", None, 0.0);
        let tree = build_tree(
            vec![team.clone()],
            vec![
                conn("zeta", Some(team.id), 0.0, true),
                conn("alpha", None, 1.0, true),
                conn("other", None, 2.0, false),
            ],
        );

        let pinned: Vec<&str> = tree.pinned.iter().map(|c| c.input.name.as_str()).collect();
        assert_eq!(pinned, ["alpha", "zeta"]);

        let TreeNode::Folder(team_node) = &tree.root[0] else {
            panic!("expected folder");
        };
        assert_eq!(names(&team_node.children), ["zeta"]);
    }

    #[test]
    fn orphans_go_to_the_root() {
        let tree = build_tree(vec![], vec![conn("lost", Some(Uuid::new_v4()), 0.0, false)]);
        assert_eq!(names(&tree.root), ["lost"]);
    }

    #[test]
    fn empty_folders_count_zero() {
        let tree = build_tree(vec![folder("empty", None, 0.0)], vec![]);
        let TreeNode::Folder(node) = &tree.root[0] else {
            panic!("expected folder");
        };
        assert_eq!(node.connection_count, 0);
        assert!(node.children.is_empty());
    }
}
