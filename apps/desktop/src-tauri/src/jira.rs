use crate::models::{CommandError, CommandResult, JiraIssueSummary};
use serde_json::Value;

const KEYRING_SERVICE: &str = "helm-jira";

fn keyring_entry(project_id: &str) -> CommandResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, project_id)
        .map_err(|err| CommandError::with_details("KeyringError", "키체인에 접근하지 못했습니다.", err.to_string()))
}

pub fn set_token(project_id: &str, token: &str) -> CommandResult<()> {
    let entry = keyring_entry(project_id)?;
    let token = token.trim();
    if token.is_empty() {
        // Empty token clears the stored secret.
        match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(CommandError::with_details(
                "KeyringError",
                "토큰을 삭제하지 못했습니다.",
                err.to_string(),
            )),
        }
    } else {
        entry.set_password(token).map_err(|err| {
            CommandError::with_details("KeyringError", "토큰을 저장하지 못했습니다.", err.to_string())
        })
    }
}

pub fn token_status(project_id: &str) -> CommandResult<bool> {
    let entry = keyring_entry(project_id)?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(err) => Err(CommandError::with_details(
            "KeyringError",
            "토큰 상태를 확인하지 못했습니다.",
            err.to_string(),
        )),
    }
}

fn config_string(config: &Option<Value>, key: &str) -> String {
    config
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub fn list_issues(project_id: &str, config: &Option<Value>) -> CommandResult<Vec<JiraIssueSummary>> {
    let site = config_string(config, "siteUrl").trim_end_matches('/').to_string();
    let email = config_string(config, "email");
    let project_key = config_string(config, "projectKey");

    if site.is_empty() || email.is_empty() {
        return Err(CommandError::new(
            "JiraNotConfigured",
            "설정에서 Jira 사이트 URL과 이메일을 입력해주세요.",
        ));
    }
    if project_key.is_empty() {
        return Err(CommandError::new(
            "JiraNotConfigured",
            "설정에서 Jira 프로젝트 키를 입력해주세요.",
        ));
    }

    let token = keyring_entry(project_id)?.get_password().map_err(|err| match err {
        keyring::Error::NoEntry => {
            CommandError::new("JiraNotConfigured", "설정에서 Jira API 토큰을 저장해주세요.")
        }
        other => CommandError::with_details("KeyringError", "토큰을 읽지 못했습니다.", other.to_string()),
    })?;

    let jql = format!("project = \"{project_key}\" AND statusCategory != Done ORDER BY updated DESC");
    // ponytail: `/search/jql` is the current Cloud endpoint; classic `/search` was removed.
    let url = format!("{site}/rest/api/3/search/jql");

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|err| CommandError::with_details("JiraRequestError", "HTTP 클라이언트 생성 실패.", err.to_string()))?;

    let response = client
        .get(&url)
        .basic_auth(&email, Some(&token))
        .header("Accept", "application/json")
        .query(&[
            ("jql", jql.as_str()),
            ("maxResults", "50"),
            ("fields", "summary,status,updated,assignee"),
        ])
        .send()
        .map_err(|err| CommandError::with_details("JiraRequestError", "Jira 요청에 실패했습니다.", err.to_string()))?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|err| CommandError::with_details("JiraRequestError", "Jira 응답을 읽지 못했습니다.", err.to_string()))?;

    if !status.is_success() {
        return Err(CommandError::with_details(
            "JiraRequestError",
            "Jira가 오류를 반환했습니다.",
            format!("{status}: {body}"),
        ));
    }

    let parsed: Value = serde_json::from_str(&body)
        .map_err(|err| CommandError::with_details("JiraRequestError", "Jira 응답 파싱 실패.", err.to_string()))?;

    let issues = parsed["issues"].as_array().cloned().unwrap_or_default();
    Ok(issues
        .iter()
        .map(|issue| issue_from_json(issue, &site))
        .collect())
}

fn issue_from_json(issue: &Value, site: &str) -> JiraIssueSummary {
    let key = issue["key"].as_str().unwrap_or_default().to_string();
    let fields = &issue["fields"];
    JiraIssueSummary {
        summary: fields["summary"].as_str().unwrap_or_default().to_string(),
        status: fields["status"]["name"].as_str().unwrap_or_default().to_string(),
        assignee: fields["assignee"]["displayName"].as_str().unwrap_or("").to_string(),
        updated_at: fields["updated"].as_str().unwrap_or_default().to_string(),
        url: if key.is_empty() {
            String::new()
        } else {
            format!("{site}/browse/{key}")
        },
        key,
    }
}
