//! The parts of `~/.ssh/config` a tunnel needs: HostName, User, Port, and IdentityFile for a host alias.
//!
//! Follows OpenSSH: `Host` patterns with `*`, `?` and `!` negation, the first value of each option wins
//! (IdentityFile accumulates), and `Include` with `*` / `?` in the file name. `Match` blocks are skipped.
//! ProxyJump and ProxyCommand are read only so the tunnel can say they aren't supported.

use std::path::{Path, PathBuf};

use super::SshError;

/// How deep `Include` may nest, as in OpenSSH.
const MAX_INCLUDE_DEPTH: usize = 16;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct HostConfig {
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_files: Vec<PathBuf>,
    pub proxy: Option<String>,
}

/// Settings for `alias` from `<ssh_dir>/config`. A missing file means no settings.
pub(super) fn resolve(alias: &str, ssh_dir: &Path) -> Result<HostConfig, SshError> {
    let mut config = HostConfig::default();
    let path = ssh_dir.join("config");
    if path.is_file() {
        Parser { alias, ssh_dir }.file(&path, 0, &mut config)?;
    }

    Ok(config)
}

struct Parser<'a> {
    alias: &'a str,
    ssh_dir: &'a Path,
}

impl Parser<'_> {
    fn file(&self, path: &Path, depth: usize, config: &mut HostConfig) -> Result<(), SshError> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| SshError::Config(format!("could not read {}: {e}", path.display())))?;
        self.text(&text, path, depth, config)
    }

    fn text(
        &self,
        text: &str,
        path: &Path,
        depth: usize,
        config: &mut HostConfig,
    ) -> Result<(), SshError> {
        // Lines before the first Host apply to every host.
        let mut active = true;

        for (number, line) in text.lines().enumerate() {
            let Some((keyword, args)) = split_line(line) else {
                continue;
            };
            let at = || format!("{} line {}", path.display(), number + 1);

            match keyword.as_str() {
                "host" => active = host_matches(&args, self.alias),
                "match" => active = false,
                _ if !active => {}
                "include" => {
                    if depth >= MAX_INCLUDE_DEPTH {
                        return Err(SshError::Config(format!(
                            "{}: Include nests too deep",
                            at()
                        )));
                    }

                    for pattern in &args {
                        for file in self.include_files(pattern) {
                            self.file(&file, depth + 1, config)?;
                        }
                    }
                }
                "hostname" => {
                    if config.hostname.is_none() {
                        config.hostname = args.first().map(|h| self.expand(h));
                    }
                }
                "user" => {
                    if config.user.is_none() {
                        config.user = args.first().cloned();
                    }
                }
                "port" => {
                    if config.port.is_none()
                        && let Some(port) = args.first()
                    {
                        let port = port.parse().map_err(|_| {
                            SshError::Config(format!("{}: invalid Port {port:?}", at()))
                        })?;
                        config.port = Some(port);
                    }
                }
                "identityfile" => {
                    if let Some(file) = args.first()
                        && !file.eq_ignore_ascii_case("none")
                    {
                        config.identity_files.push(self.path(file));
                    }
                }
                "proxyjump" | "proxycommand" => {
                    if config.proxy.is_none()
                        && let Some(first) = args.first()
                        && !first.eq_ignore_ascii_case("none")
                    {
                        config.proxy = Some(keyword);
                    }
                }
                _ => {}
            }
        }

        Ok(())
    }

    /// Files named by an Include pattern, sorted like OpenSSH's glob. Relative paths are in `~/.ssh`.
    fn include_files(&self, pattern: &str) -> Vec<PathBuf> {
        let path = self.path(pattern);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !name.contains(['*', '?']) {
            return vec![path].into_iter().filter(|p| p.is_file()).collect();
        }

        let Some(dir) = path.parent() else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };

        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|e| wildcard_match(&name, &e.file_name().to_string_lossy()))
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .collect();
        files.sort();
        files
    }

    /// A file path with `~` and tokens expanded; relative paths are relative to `~/.ssh`.
    fn path(&self, text: &str) -> PathBuf {
        let path = PathBuf::from(self.expand(text));
        if path.is_absolute() {
            path
        } else {
            self.ssh_dir.join(path)
        }
    }

    /// Expands `~`, `%h` (the alias), `%d` (home directory) and `%%`.
    fn expand(&self, text: &str) -> String {
        let home = super::home_dir()
            .map(|h| h.display().to_string())
            .unwrap_or_default();

        let text = match text.strip_prefix('~') {
            Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
                format!("{home}{rest}")
            }
            _ => text.to_string(),
        };

        let mut out = String::with_capacity(text.len());
        let mut chars = text.chars();
        while let Some(c) = chars.next() {
            if c != '%' {
                out.push(c);
                continue;
            }

            match chars.next() {
                Some('h') => out.push_str(self.alias),
                Some('d') => out.push_str(&home),
                Some('%') => out.push('%'),
                Some(other) => {
                    out.push('%');
                    out.push(other);
                }
                None => out.push('%'),
            }
        }

        out
    }
}

/// The lowercase keyword and its arguments, or `None` for blank and comment lines.
/// Accepts `Keyword value` and `Keyword=value`; arguments may be in double quotes.
fn split_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }

    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let keyword = line[..end].to_ascii_lowercase();
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest);

    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut has_arg = false;
    for c in rest.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has_arg = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has_arg {
                    args.push(std::mem::take(&mut current));
                    has_arg = false;
                }
            }
            c => {
                current.push(c);
                has_arg = true;
            }
        }
    }
    if has_arg {
        args.push(current);
    }

    Some((keyword, args))
}

/// Whether a `Host` line applies: some pattern matches and no negated pattern does.
fn host_matches(patterns: &[String], alias: &str) -> bool {
    let mut matched = false;
    for pattern in patterns {
        if let Some(negated) = pattern.strip_prefix('!') {
            if wildcard_match(negated, alias) {
                return false;
            }
        } else if wildcard_match(pattern, alias) {
            matched = true;
        }
    }

    matched
}

/// `*` matches any run of characters, `?` one character. Case-insensitive, as host names are.
fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.to_lowercase().chars().collect();
    let text: Vec<char> = text.to_lowercase().chars().collect();

    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some((p, t));
            p += 1;
        } else if let Some((sp, st)) = star {
            p = sp + 1;
            t = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }

    pattern[p..].iter().all(|&c| c == '*')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve_text(text: &str, alias: &str, dir: &Path) -> HostConfig {
        let mut config = HostConfig::default();
        Parser {
            alias,
            ssh_dir: dir,
        }
        .text(text, Path::new("config"), 0, &mut config)
        .unwrap();
        config
    }

    #[test]
    fn wildcards() {
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("db-*.prod", "DB-1.prod"));
        assert!(wildcard_match("h?st", "host"));
        assert!(!wildcard_match("h?st", "hoost"));
        assert!(wildcard_match("*.example.*", "a.example.com"));
        assert!(!wildcard_match("*.example.com", "example.com"));
    }

    #[test]
    fn splits_lines() {
        assert_eq!(split_line("  # comment"), None);
        assert_eq!(split_line(""), None);
        assert_eq!(
            split_line("HostName=db.example.com"),
            Some(("hostname".into(), vec!["db.example.com".into()]))
        );
        assert_eq!(
            split_line(r#"IdentityFile "~/My Keys/id""#),
            Some(("identityfile".into(), vec!["~/My Keys/id".into()]))
        );
        assert_eq!(
            split_line("Host a b  !c"),
            Some(("host".into(), vec!["a".into(), "b".into(), "!c".into()]))
        );
    }

    #[test]
    fn first_value_wins_and_identity_files_accumulate() {
        let dir = Path::new("/home/me/.ssh");
        let text = r#"
            Host bastion
                HostName 10.0.0.1
                User deploy
                IdentityFile keys/bastion
            Host bastion other
                HostName ignored
                Port 2200
            Host *
                User ignored
                Port 22
                IdentityFile /abs/id_ed25519
        "#;

        let config = resolve_text(text, "bastion", dir);
        assert_eq!(config.hostname.as_deref(), Some("10.0.0.1"));
        assert_eq!(config.user.as_deref(), Some("deploy"));
        assert_eq!(config.port, Some(2200));
        assert_eq!(
            config.identity_files,
            vec![dir.join("keys/bastion"), PathBuf::from("/abs/id_ed25519")]
        );

        let other = resolve_text(text, "other", dir);
        assert_eq!(other.hostname.as_deref(), Some("ignored"));
        assert_eq!(other.user.as_deref(), Some("ignored"));
    }

    #[test]
    fn negation_match_blocks_and_tokens() {
        let dir = Path::new("/s");
        let text = r#"
            Host *.corp !build.corp
                HostName %h.internal
                ProxyJump jump
            Match host foo
                User nope
        "#;

        let config = resolve_text(text, "db.corp", dir);
        assert_eq!(config.hostname.as_deref(), Some("db.corp.internal"));
        assert_eq!(config.proxy.as_deref(), Some("proxyjump"));
        assert_eq!(config.user, None);

        assert_eq!(resolve_text(text, "build.corp", dir), HostConfig::default());
    }

    #[test]
    fn invalid_port_is_an_error() {
        let mut config = HostConfig::default();
        let parser = Parser {
            alias: "x",
            ssh_dir: Path::new("/s"),
        };
        let err = parser
            .text("Port many", Path::new("cfg"), 0, &mut config)
            .unwrap_err();
        assert!(err.to_string().contains("cfg line 1"), "{err}");
    }

    #[test]
    fn includes_files_by_glob() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = dir.path();
        std::fs::create_dir(ssh.join("conf.d")).unwrap();
        std::fs::write(
            ssh.join("config"),
            "Include conf.d/*.conf\nHost db\n  User fallback\n",
        )
        .unwrap();
        std::fs::write(ssh.join("conf.d/b.conf"), "Host db\n  Port 2201\n").unwrap();
        std::fs::write(
            ssh.join("conf.d/a.conf"),
            "Host db\n  HostName first\n  Port 2200\n",
        )
        .unwrap();
        std::fs::write(ssh.join("conf.d/skip.txt"), "Host db\n  User skipped\n").unwrap();

        let config = resolve("db", ssh).unwrap();
        assert_eq!(config.hostname.as_deref(), Some("first"));
        assert_eq!(config.port, Some(2200));
        assert_eq!(config.user.as_deref(), Some("fallback"));

        assert_eq!(
            resolve("db", &ssh.join("missing")).unwrap(),
            HostConfig::default()
        );
    }
}
