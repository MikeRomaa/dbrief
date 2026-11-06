//! Repository tests against a migrated database in a temp directory.

use uuid::Uuid;

use super::*;
use crate::Storage;

async fn repo() -> (tempfile::TempDir, ConnectionRepo) {
    let dir = tempfile::tempdir().unwrap();
    let storage = Storage::open(dir.path()).await.unwrap();
    (dir, ConnectionRepo::new(storage.pool().clone()))
}

fn sqlite(name: &str, folder: Option<Uuid>) -> ConnectionInput {
    let mut input = ConnectionInput::new(name, Engine::Sqlite, AccessLevel::Rw);
    input.folder_id = folder;
    input.file_path = Some(format!("/data/{name}.db"));
    input
}

fn root_names(tree: &ConnectionTree) -> Vec<String> {
    tree.root
        .iter()
        .map(|n| match n {
            TreeNode::Folder(f) => format!("[{}]", f.folder.name),
            TreeNode::Connection(c) => c.input.name.clone(),
        })
        .collect()
}

#[tokio::test]
async fn create_and_read_back_every_field() {
    let (_dir, repo) = repo().await;

    let mut input = ConnectionInput::new("billing", Engine::Postgres, AccessLevel::Ro);
    input.color_tag = Some("red".into());
    input.host = Some("db.internal".into());
    input.port = Some(5433);
    input.database = Some("billing".into());
    input.username = Some("reader".into());
    input.ssl_mode = Some(SslMode::VerifyFull);
    input.ca_cert_path = Some("/certs/ca.pem".into());
    input.ssh = Some(SshTunnel {
        host: "bastion".into(),
        port: Some(2222),
        user: None,
        auth: SshAuth::Agent,
    });
    input.connect_timeout_s = Some(10);
    input.query_timeout_s = Some(60);
    input.default_schema = Some("app".into());
    input.startup_sql = Some("SET TIME ZONE 'UTC'".into());
    input.confirm_before_commit = true;

    let created = repo.create_connection(input.clone()).await.unwrap();
    assert_eq!(created.input, input);
    assert!(!created.pinned);
    assert!(!created.created_at.is_empty());
    assert_eq!(created.last_used_at, None);
    assert_eq!(repo.connection(created.id).await.unwrap(), created);
}

#[tokio::test]
async fn rejects_invalid_input_and_unknown_folders() {
    let (_dir, repo) = repo().await;

    let no_host = ConnectionInput::new("pg", Engine::Postgres, AccessLevel::Rw);
    assert!(matches!(
        repo.create_connection(no_host).await,
        Err(ConnectionsError::Invalid(_))
    ));

    let missing = Uuid::new_v4();
    assert!(matches!(
        repo.create_connection(sqlite("a", Some(missing))).await,
        Err(ConnectionsError::NotFound(ItemRef::Folder(id))) if id == missing
    ));
    assert!(repo.create_folder("  ", None).await.is_err());
}

#[tokio::test]
async fn new_items_go_to_the_end_of_their_parent() {
    let (_dir, repo) = repo().await;

    repo.create_connection(sqlite("first", None)).await.unwrap();
    repo.create_folder("folder", None).await.unwrap();
    repo.create_connection(sqlite("last", None)).await.unwrap();

    assert_eq!(
        root_names(&repo.tree().await.unwrap()),
        ["first", "[folder]", "last"]
    );
}

#[tokio::test]
async fn update_keeps_position_unless_folder_changes() {
    let (_dir, repo) = repo().await;

    let a = repo.create_connection(sqlite("a", None)).await.unwrap();
    repo.create_connection(sqlite("b", None)).await.unwrap();

    let mut renamed = a.input.clone();
    renamed.name = "a2".into();
    let updated = repo.update_connection(a.id, renamed).await.unwrap();
    assert_eq!(updated.sort_order, a.sort_order);
    assert_eq!(root_names(&repo.tree().await.unwrap()), ["a2", "b"]);

    let folder = repo.create_folder("f", None).await.unwrap();
    repo.create_connection(sqlite("already-there", Some(folder.id)))
        .await
        .unwrap();
    let mut moved = updated.input.clone();
    moved.folder_id = Some(folder.id);
    repo.update_connection(a.id, moved).await.unwrap();

    let tree = repo.tree().await.unwrap();
    let TreeNode::Folder(f) = &tree.root[1] else {
        panic!("expected folder");
    };
    let children: Vec<&str> = f
        .children
        .iter()
        .map(|n| match n {
            TreeNode::Connection(c) => c.input.name.as_str(),
            TreeNode::Folder(_) => "folder",
        })
        .collect();
    assert_eq!(children, ["already-there", "a2"]);
}

#[tokio::test]
async fn move_reorders_within_and_across_parents() {
    let (_dir, repo) = repo().await;

    let a = repo.create_connection(sqlite("a", None)).await.unwrap();
    let b = repo.create_connection(sqlite("b", None)).await.unwrap();
    let c = repo.create_connection(sqlite("c", None)).await.unwrap();

    repo.move_item(
        ItemRef::Connection(c.id),
        None,
        Some(ItemRef::Connection(a.id)),
    )
    .await
    .unwrap();
    assert_eq!(root_names(&repo.tree().await.unwrap()), ["c", "a", "b"]);

    repo.move_item(ItemRef::Connection(c.id), None, None)
        .await
        .unwrap();
    assert_eq!(root_names(&repo.tree().await.unwrap()), ["a", "b", "c"]);

    let folder = repo.create_folder("f", None).await.unwrap();
    repo.move_item(
        ItemRef::Folder(folder.id),
        None,
        Some(ItemRef::Connection(b.id)),
    )
    .await
    .unwrap();
    assert_eq!(
        root_names(&repo.tree().await.unwrap()),
        ["a", "[f]", "b", "c"]
    );

    repo.move_item(ItemRef::Connection(a.id), Some(folder.id), None)
        .await
        .unwrap();
    let tree = repo.tree().await.unwrap();
    assert_eq!(root_names(&tree), ["[f]", "b", "c"]);
    assert_eq!(
        repo.connection(a.id).await.unwrap().input.folder_id,
        Some(folder.id)
    );
}

#[tokio::test]
async fn move_rejects_cycles_and_bad_targets() {
    let (_dir, repo) = repo().await;

    let outer = repo.create_folder("outer", None).await.unwrap();
    let inner = repo.create_folder("inner", Some(outer.id)).await.unwrap();

    for target in [outer.id, inner.id] {
        assert!(matches!(
            repo.move_item(ItemRef::Folder(outer.id), Some(target), None)
                .await,
            Err(ConnectionsError::Invalid(_))
        ));
    }

    let a = repo.create_connection(sqlite("a", None)).await.unwrap();
    let elsewhere = repo
        .create_connection(sqlite("x", Some(outer.id)))
        .await
        .unwrap();
    assert!(matches!(
        repo.move_item(
            ItemRef::Connection(a.id),
            None,
            Some(ItemRef::Connection(elsewhere.id))
        )
        .await,
        Err(ConnectionsError::Invalid(_))
    ));
    assert!(matches!(
        repo.move_item(ItemRef::Connection(Uuid::new_v4()), None, None)
            .await,
        Err(ConnectionsError::NotFound(_))
    ));

    // A failed move leaves everything where it was.
    assert_eq!(repo.connection(a.id).await.unwrap().input.folder_id, None);
}

#[tokio::test]
async fn pin_and_last_used() {
    let (_dir, repo) = repo().await;

    let a = repo.create_connection(sqlite("a", None)).await.unwrap();
    repo.set_pinned(a.id, true).await.unwrap();
    repo.touch_last_used(a.id).await.unwrap();

    let tree = repo.tree().await.unwrap();
    assert_eq!(tree.pinned.len(), 1);
    assert!(tree.pinned[0].last_used_at.is_some());
    assert!(repo.set_pinned(Uuid::new_v4(), true).await.is_err());
}

#[tokio::test]
async fn deleting_a_folder_cascades_and_reports_counts() {
    let (_dir, repo) = repo().await;

    let outer = repo.create_folder("outer", None).await.unwrap();
    let inner = repo.create_folder("inner", Some(outer.id)).await.unwrap();
    let a = repo
        .create_connection(sqlite("a", Some(outer.id)))
        .await
        .unwrap();
    let b = repo
        .create_connection(sqlite("b", Some(inner.id)))
        .await
        .unwrap();
    let keep = repo.create_connection(sqlite("keep", None)).await.unwrap();

    let counts = repo.delete_counts(ItemRef::Folder(outer.id)).await.unwrap();
    assert_eq!(
        counts,
        DeleteCounts {
            folders: 2,
            connections: 2
        }
    );

    let mut removed = repo.delete(ItemRef::Folder(outer.id)).await.unwrap();
    removed.sort();
    let mut expected = vec![a.id, b.id];
    expected.sort();
    assert_eq!(removed, expected);

    assert!(repo.folders().await.unwrap().is_empty());
    let left: Vec<Uuid> = repo
        .connections()
        .await
        .unwrap()
        .iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(left, [keep.id]);
}

#[tokio::test]
async fn deleting_a_connection() {
    let (_dir, repo) = repo().await;

    let a = repo.create_connection(sqlite("a", None)).await.unwrap();
    assert_eq!(
        repo.delete_counts(ItemRef::Connection(a.id)).await.unwrap(),
        DeleteCounts {
            folders: 0,
            connections: 1
        }
    );
    assert_eq!(
        repo.delete(ItemRef::Connection(a.id)).await.unwrap(),
        [a.id]
    );
    assert!(matches!(
        repo.delete(ItemRef::Connection(a.id)).await,
        Err(ConnectionsError::NotFound(_))
    ));
    assert!(
        repo.delete_counts(ItemRef::Folder(Uuid::new_v4()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn rename_folder() {
    let (_dir, repo) = repo().await;

    let folder = repo.create_folder("old", None).await.unwrap();
    repo.rename_folder(folder.id, "  new  ").await.unwrap();
    assert_eq!(repo.folders().await.unwrap()[0].name, "new");
    assert!(repo.rename_folder(Uuid::new_v4(), "x").await.is_err());
}
