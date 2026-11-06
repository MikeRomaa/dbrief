//! Host key checks against `~/.ssh/known_hosts` and the app's own known_hosts file.

use std::io::Write;
use std::path::Path;

use russh::keys::{PublicKey, check_known_hosts_path};

use super::{SshEnv, SshError};

/// Accepts a key recorded in either file, refuses a changed one, and records an unknown host in the
/// app's file (trust on first use).
pub(super) fn verify(host: &str, port: u16, key: &PublicKey, env: &SshEnv) -> Result<(), SshError> {
    let user_file = env.ssh_dir.as_ref().map(|dir| dir.join("known_hosts"));
    let files = user_file.iter().chain([&env.app_known_hosts]);

    for file in files {
        if is_known(host, port, key, file)? {
            return Ok(());
        }
    }

    remember(host, port, key, &env.app_known_hosts)
        .map_err(|e| SshError::HostKeyStore(format!("{}: {e}", env.app_known_hosts.display())))
}

/// Appends a known_hosts line in OpenSSH's format, without a comment.
fn remember(host: &str, port: u16, key: &PublicKey, file: &Path) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let existing = std::fs::read(file).unwrap_or_default();
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?;
    if !existing.is_empty() && !existing.ends_with(b"\n") {
        out.write_all(b"\n")?;
    }

    let mut key = key.clone();
    key.set_comment("");
    let key = key.to_openssh().map_err(std::io::Error::other)?;
    let host = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    writeln!(out, "{host} {}", key.trim_end())
}

fn is_known(host: &str, port: u16, key: &PublicKey, file: &Path) -> Result<bool, SshError> {
    match check_known_hosts_path(host, port, key, file) {
        Ok(known) => Ok(known),
        Err(russh::keys::Error::KeyChanged { line }) => Err(SshError::HostKeyChanged {
            host: host.to_string(),
            file: file.display().to_string(),
            line,
        }),
        Err(e) => Err(SshError::HostKeyStore(format!("{}: {e}", file.display()))),
    }
}

#[cfg(test)]
mod tests {
    use russh::keys::{Algorithm, PrivateKey};

    use super::*;

    fn key(seed: u8) -> PublicKey {
        let private = PrivateKey::from(russh::keys::ssh_key::private::Ed25519Keypair::from_seed(
            &[seed; 32],
        ));
        assert_eq!(private.algorithm(), Algorithm::Ed25519);
        private.public_key().clone()
    }

    fn env(dir: &Path) -> SshEnv {
        SshEnv {
            app_known_hosts: dir.join("app/known_hosts"),
            ssh_dir: Some(dir.join("ssh")),
            agent_socket: None,
        }
    }

    #[test]
    fn trusts_on_first_use_and_refuses_changed_keys() {
        let dir = tempfile::tempdir().unwrap();
        let env = env(dir.path());

        verify("bastion", 2222, &key(1), &env).unwrap();
        let recorded = std::fs::read_to_string(&env.app_known_hosts).unwrap();
        assert!(
            recorded.starts_with("[bastion]:2222 ssh-ed25519 "),
            "{recorded}"
        );

        verify("bastion", 2222, &key(1), &env).unwrap();
        assert_eq!(
            std::fs::read_to_string(&env.app_known_hosts).unwrap(),
            recorded
        );

        let err = verify("bastion", 2222, &key(2), &env).unwrap_err();
        assert!(
            matches!(err, SshError::HostKeyChanged { line: 1, .. }),
            "{err}"
        );
    }

    #[test]
    fn user_known_hosts_is_checked_first() {
        let dir = tempfile::tempdir().unwrap();
        let env = env(dir.path());
        let user_file = dir.path().join("ssh/known_hosts");
        remember("db.example.com", 22, &key(3), &user_file).unwrap();

        verify("db.example.com", 22, &key(3), &env).unwrap();
        assert!(!env.app_known_hosts.exists());

        assert!(matches!(
            verify("db.example.com", 22, &key(4), &env),
            Err(SshError::HostKeyChanged { .. })
        ));
    }
}
