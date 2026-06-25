//! GitHub App auth for posting review comments under the App's bot identity
//! instead of the user's personal `gh` account.
//!
//! Flow: sign an RS256 JWT with the App private key -> exchange it for a repo
//! installation access token -> hand that token to `gh` via `GH_TOKEN`. The
//! credentials (App ID + private key PEM) live per-project in the OS keychain,
//! mirroring `jira.rs`.

use crate::models::{CommandError, CommandResult};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const KEYRING_SERVICE: &str = "helm-github-app";

#[derive(Serialize, Deserialize)]
struct Credentials {
    #[serde(rename = "appId")]
    app_id: String,
    #[serde(rename = "privateKey")]
    private_key: String,
}

fn keyring_entry(project_id: &str) -> CommandResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, project_id).map_err(|err| {
        CommandError::with_details("KeyringError", "키체인에 접근하지 못했습니다.", err.to_string())
    })
}

/// Store App ID + private key as one JSON entry. Empty App ID clears the secret.
pub fn set_credentials(project_id: &str, app_id: &str, private_key: &str) -> CommandResult<()> {
    let entry = keyring_entry(project_id)?;
    let app_id = app_id.trim();
    let private_key = private_key.trim();
    if app_id.is_empty() {
        return match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(CommandError::with_details(
                "KeyringError",
                "GitHub App 자격증명을 삭제하지 못했습니다.",
                err.to_string(),
            )),
        };
    }
    let payload = serde_json::to_string(&Credentials {
        app_id: app_id.to_string(),
        private_key: private_key.to_string(),
    })
    .map_err(|err| {
        CommandError::with_details("GithubAppError", "자격증명 직렬화 실패.", err.to_string())
    })?;
    entry.set_password(&payload).map_err(|err| {
        CommandError::with_details(
            "KeyringError",
            "GitHub App 자격증명을 저장하지 못했습니다.",
            err.to_string(),
        )
    })
}

pub fn credentials_status(project_id: &str) -> CommandResult<bool> {
    let entry = keyring_entry(project_id)?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(err) => Err(CommandError::with_details(
            "KeyringError",
            "GitHub App 자격증명 상태를 확인하지 못했습니다.",
            err.to_string(),
        )),
    }
}

fn load_credentials(project_id: &str) -> CommandResult<Option<Credentials>> {
    let entry = keyring_entry(project_id)?;
    match entry.get_password() {
        Ok(raw) => serde_json::from_str(&raw).map(Some).map_err(|err| {
            CommandError::with_details(
                "GithubAppError",
                "저장된 GitHub App 자격증명을 읽지 못했습니다.",
                err.to_string(),
            )
        }),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(CommandError::with_details(
            "KeyringError",
            "GitHub App 자격증명을 읽지 못했습니다.",
            err.to_string(),
        )),
    }
}

/// Mint a repo installation access token for `root`'s GitHub repo.
/// Returns `Ok(None)` when the project has no App credentials configured, so
/// callers can fall back to the default `gh` auth.
pub fn installation_token(root: &Path, project_id: &str) -> CommandResult<Option<String>> {
    let creds = match load_credentials(project_id)? {
        Some(creds) => creds,
        None => return Ok(None),
    };
    let repo = name_with_owner(root)?;
    let jwt = app_jwt(&creds)?;
    let client = http_client()?;

    let installation = get_json(
        &client,
        &format!("https://api.github.com/repos/{repo}/installation"),
        &jwt,
    )?;
    let installation_id = installation
        .get("id")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| {
            CommandError::new(
                "GithubAppError",
                "이 저장소에 GitHub App이 설치되어 있지 않습니다.",
            )
        })?;

    let token_url =
        format!("https://api.github.com/app/installations/{installation_id}/access_tokens");
    let response = client
        .post(&token_url)
        .bearer_auth(&jwt)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "helm")
        .send()
        .map_err(|err| {
            CommandError::with_details(
                "GithubAppError",
                "installation 토큰 발급 요청에 실패했습니다.",
                err.to_string(),
            )
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(CommandError::with_details(
            "GithubAppError",
            "installation 토큰 발급에 실패했습니다.",
            format!("{status}: {body}"),
        ));
    }
    let body: serde_json::Value = response.json().map_err(|err| {
        CommandError::with_details(
            "GithubAppError",
            "installation 토큰 응답 파싱 실패.",
            err.to_string(),
        )
    })?;
    body.get("token")
        .and_then(serde_json::Value::as_str)
        .map(|token| Some(token.to_string()))
        .ok_or_else(|| CommandError::new("GithubAppError", "installation 토큰이 응답에 없습니다."))
}

/// Sign a short-lived (10 min) RS256 JWT proving the App's identity.
fn app_jwt(creds: &Credentials) -> CommandResult<String> {
    #[derive(Serialize)]
    struct Claims {
        iat: u64,
        exp: u64,
        iss: String,
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let claims = Claims {
        iat: now.saturating_sub(60), // tolerate minor clock drift
        exp: now + 600,
        iss: creds.app_id.clone(),
    };
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(creds.private_key.as_bytes()).map_err(|err| {
        CommandError::with_details(
            "GithubAppError",
            "GitHub App private key(PEM)를 읽지 못했습니다.",
            err.to_string(),
        )
    })?;
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &key,
    )
    .map_err(|err| {
        CommandError::with_details("GithubAppError", "JWT 서명에 실패했습니다.", err.to_string())
    })
}

fn http_client() -> CommandResult<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|err| {
            CommandError::with_details("GithubAppError", "HTTP 클라이언트 생성 실패.", err.to_string())
        })
}

fn get_json(
    client: &reqwest::blocking::Client,
    url: &str,
    jwt: &str,
) -> CommandResult<serde_json::Value> {
    let response = client
        .get(url)
        .bearer_auth(jwt)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "helm")
        .send()
        .map_err(|err| {
            CommandError::with_details("GithubAppError", "GitHub API 요청에 실패했습니다.", err.to_string())
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(CommandError::with_details(
            "GithubAppError",
            "GitHub API 요청이 실패했습니다.",
            format!("{status}: {body}"),
        ));
    }
    response.json().map_err(|err| {
        CommandError::with_details("GithubAppError", "GitHub API 응답 파싱 실패.", err.to_string())
    })
}

/// `owner/repo` for the repo at `root`, via the user's already-authed `gh`.
fn name_with_owner(root: &Path) -> CommandResult<String> {
    let output = Command::new("gh")
        .current_dir(root)
        .args(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
        .output()
        .map_err(|err| CommandError::io("저장소 정보를 읽지 못했습니다.", err))?;
    if !output.status.success() {
        return Err(CommandError::with_details(
            "GithubAppError",
            "저장소 정보를 읽지 못했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }
    let repo = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if repo.is_empty() {
        return Err(CommandError::new(
            "GithubAppError",
            "GitHub 저장소(owner/repo)를 확인하지 못했습니다.",
        ));
    }
    Ok(repo)
}
