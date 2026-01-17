use std::process::Command;

#[derive(Debug, Default, Clone)]
pub struct GitInfo {
    pub branch: String,
    pub last_commit: String,
}

impl GitInfo {
    pub fn fetch() -> Self {
        let branch = get_current_branch().unwrap_or_else(|| "unknown".to_string());
        let last_commit = get_last_commit_message().unwrap_or_else(|| "no commits".to_string());

        Self {
            branch,
            last_commit,
        }
    }

    pub fn display(&self) -> String {
        format!("{} | {}", self.branch, self.last_commit)
    }
}

fn get_current_branch() -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;

    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

fn get_last_commit_message() -> Option<String> {
    let output = Command::new("git")
        .args(["log", "-1", "--pretty=%s"])
        .output()
        .ok()?;

    if output.status.success() {
        let message = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if message.len() > 50 {
            Some(format!("{}...", &message[..47]))
        } else {
            Some(message)
        }
    } else {
        None
    }
}
