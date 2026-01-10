use serde::Deserialize;
use std::env;
use std::process::Command;
use std::time::Duration;

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const GITHUB_API_URL: &str = "https://api.github.com/repos/Devver-Inc/cli/releases/latest";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InstallMethod {
    Brew,
    Cargo,
    Unknown,
}

impl InstallMethod {
    pub fn detect() -> Self {
        if let Ok(exe) = env::current_exe() {
            let path = exe.to_string_lossy();
            if path.contains("/homebrew/") || path.contains("/linuxbrew/") {
                return Self::Brew;
            }
            if path.contains("/.cargo/") {
                return Self::Cargo;
            }
        }
        Self::Unknown
    }
}

pub struct UpdateResult {
    pub message: String,
}

pub fn check_and_update() -> UpdateResult {
    let method = InstallMethod::detect();

    if method == InstallMethod::Unknown {
        return UpdateResult {
            message: "Skipping auto-update (unknown install method)".to_string(),
        };
    }

    let latest = match fetch_latest_version() {
        Ok(v) => v,
        Err(_) => {
            return UpdateResult {
                message: "Could not check for updates".to_string(),
            };
        }
    };

    if latest == CURRENT_VERSION {
        return UpdateResult {
            message: format!("v{} (latest)", CURRENT_VERSION),
        };
    }

    match run_update(method) {
        Ok(_) => UpdateResult {
            message: format!("Updated to v{} (will apply on next launch)", latest),
        },
        Err(_) => UpdateResult {
            message: format!("Update to v{} failed", latest),
        },
    }
}

fn fetch_latest_version() -> Result<String, Box<dyn std::error::Error>> {
    let response: GithubRelease = reqwest::blocking::Client::builder()
        .user_agent("devver-cli")
        .timeout(REQUEST_TIMEOUT)
        .build()?
        .get(GITHUB_API_URL)
        .send()?
        .json()?;

    Ok(response.tag_name.trim_start_matches('v').to_string())
}

fn run_update(method: InstallMethod) -> Result<(), Box<dyn std::error::Error>> {
    match method {
        InstallMethod::Brew => {
            Command::new("brew")
                .args(["upgrade", "devver-cli"])
                .env("HOMEBREW_NO_AUTO_UPDATE", "1")
                .output()?;
        }
        InstallMethod::Cargo => {
            Command::new("cargo")
                .args(["install", "devver-cli", "--force", "--quiet"])
                .output()?;
        }
        InstallMethod::Unknown => {}
    }
    Ok(())
}
