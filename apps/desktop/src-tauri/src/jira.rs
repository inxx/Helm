use crate::models::{CommandError, CommandResult, JiraIssueSummary, JiraTransition};
use serde_json::{json, Value};

const KEYRING_SERVICE: &str = "helm-jira";

fn keyring_entry(project_id: &str) -> CommandResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, project_id).map_err(|err| {
        CommandError::with_details(
            "KeyringError",
            "키체인에 접근하지 못했습니다.",
            err.to_string(),
        )
    })
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
            CommandError::with_details(
                "KeyringError",
                "토큰을 저장하지 못했습니다.",
                err.to_string(),
            )
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

/// Resolved Jira credentials + a ready blocking HTTP client.
struct JiraConn {
    client: reqwest::blocking::Client,
    site: String,
    email: String,
    token: String,
}

fn connect(project_id: &str, config: &Option<Value>) -> CommandResult<JiraConn> {
    let site = config_string(config, "siteUrl")
        .trim_end_matches('/')
        .to_string();
    let email = config_string(config, "email");
    if site.is_empty() || email.is_empty() {
        return Err(CommandError::new(
            "JiraNotConfigured",
            "설정에서 Jira 사이트 URL과 이메일을 입력해주세요.",
        ));
    }
    let token = keyring_entry(project_id)?
        .get_password()
        .map_err(|err| match err {
            keyring::Error::NoEntry => CommandError::new(
                "JiraNotConfigured",
                "설정에서 Jira API 토큰을 저장해주세요.",
            ),
            other => CommandError::with_details(
                "KeyringError",
                "토큰을 읽지 못했습니다.",
                other.to_string(),
            ),
        })?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|err| {
            CommandError::with_details(
                "JiraRequestError",
                "HTTP 클라이언트 생성 실패.",
                err.to_string(),
            )
        })?;
    Ok(JiraConn {
        client,
        site,
        email,
        token,
    })
}

/// Available status transitions for an issue (Jira workflows allow only some moves).
pub fn list_transitions(
    project_id: &str,
    config: &Option<Value>,
    issue_key: &str,
) -> CommandResult<Vec<JiraTransition>> {
    let conn = connect(project_id, config)?;
    let url = format!("{}/rest/api/3/issue/{}/transitions", conn.site, issue_key);
    let response = conn
        .client
        .get(&url)
        .basic_auth(&conn.email, Some(&conn.token))
        .header("Accept", "application/json")
        .send()
        .map_err(|err| {
            CommandError::with_details(
                "JiraRequestError",
                "Jira 전환 목록 요청에 실패했습니다.",
                err.to_string(),
            )
        })?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(CommandError::with_details(
            "JiraRequestError",
            "Jira가 오류를 반환했습니다.",
            format!("{status}: {body}"),
        ));
    }
    let parsed: Value = serde_json::from_str(&body).map_err(|err| {
        CommandError::with_details("JiraRequestError", "Jira 응답 파싱 실패.", err.to_string())
    })?;
    Ok(parsed["transitions"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|t| {
            Some(JiraTransition {
                id: t["id"].as_str()?.to_string(),
                // Prefer the destination status name; fall back to the transition label.
                name: t["to"]["name"]
                    .as_str()
                    .or_else(|| t["name"].as_str())
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect())
}

/// Move an issue through the given transition id.
pub fn transition_issue(
    project_id: &str,
    config: &Option<Value>,
    issue_key: &str,
    transition_id: &str,
) -> CommandResult<()> {
    let conn = connect(project_id, config)?;
    let url = format!("{}/rest/api/3/issue/{}/transitions", conn.site, issue_key);
    let response = conn
        .client
        .post(&url)
        .basic_auth(&conn.email, Some(&conn.token))
        .header("Accept", "application/json")
        .json(&json!({ "transition": { "id": transition_id } }))
        .send()
        .map_err(|err| {
            CommandError::with_details(
                "JiraRequestError",
                "Jira 상태 변경 요청에 실패했습니다.",
                err.to_string(),
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(CommandError::with_details(
            "JiraRequestError",
            "Jira 상태를 변경하지 못했습니다.",
            format!("{status}: {body}"),
        ));
    }
    Ok(())
}

pub fn list_issues(
    project_id: &str,
    config: &Option<Value>,
) -> CommandResult<Vec<JiraIssueSummary>> {
    let site = config_string(config, "siteUrl")
        .trim_end_matches('/')
        .to_string();
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

    let token = keyring_entry(project_id)?
        .get_password()
        .map_err(|err| match err {
            keyring::Error::NoEntry => CommandError::new(
                "JiraNotConfigured",
                "설정에서 Jira API 토큰을 저장해주세요.",
            ),
            other => CommandError::with_details(
                "KeyringError",
                "토큰을 읽지 못했습니다.",
                other.to_string(),
            ),
        })?;

    // Issues the current user is involved in: assigned, reported, or watching.
    // (Jira JQL has no operator for @mentions, so watcher is the closest proxy.)
    let jql = format!(
        "project = \"{project_key}\" AND (assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) ORDER BY updated DESC"
    );
    // ponytail: `/search/jql` is the current Cloud endpoint; classic `/search` was removed.
    let url = format!("{site}/rest/api/3/search/jql");

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|err| {
            CommandError::with_details(
                "JiraRequestError",
                "HTTP 클라이언트 생성 실패.",
                err.to_string(),
            )
        })?;

    // Resolve the caller's accountId so we can flag assignee/reporter relations per issue.
    let my_account_id = fetch_my_account_id(&client, &site, &email, &token);

    let response = client
        .get(&url)
        .basic_auth(&email, Some(&token))
        .header("Accept", "application/json")
        .query(&[
            ("jql", jql.as_str()),
            ("maxResults", "100"),
            ("fields", "summary,status,updated,assignee,reporter,watches"),
        ])
        .send()
        .map_err(|err| {
            CommandError::with_details(
                "JiraRequestError",
                "Jira 요청에 실패했습니다.",
                err.to_string(),
            )
        })?;

    let status = response.status();
    let body = response.text().map_err(|err| {
        CommandError::with_details(
            "JiraRequestError",
            "Jira 응답을 읽지 못했습니다.",
            err.to_string(),
        )
    })?;

    if !status.is_success() {
        return Err(CommandError::with_details(
            "JiraRequestError",
            "Jira가 오류를 반환했습니다.",
            format!("{status}: {body}"),
        ));
    }

    let parsed: Value = serde_json::from_str(&body).map_err(|err| {
        CommandError::with_details("JiraRequestError", "Jira 응답 파싱 실패.", err.to_string())
    })?;

    let issues = parsed["issues"].as_array().cloned().unwrap_or_default();
    Ok(issues
        .iter()
        .map(|issue| issue_from_json(issue, &site, my_account_id.as_deref()))
        .collect())
}

fn fetch_my_account_id(
    client: &reqwest::blocking::Client,
    site: &str,
    email: &str,
    token: &str,
) -> Option<String> {
    let response = client
        .get(format!("{site}/rest/api/3/myself"))
        .basic_auth(email, Some(token))
        .header("Accept", "application/json")
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let parsed: Value = response.json().ok()?;
    parsed["accountId"].as_str().map(str::to_string)
}

fn issue_from_json(issue: &Value, site: &str, my_account_id: Option<&str>) -> JiraIssueSummary {
    let key = issue["key"].as_str().unwrap_or_default().to_string();
    let fields = &issue["fields"];

    let mut relations = Vec::new();
    if let Some(me) = my_account_id {
        if fields["assignee"]["accountId"].as_str() == Some(me) {
            relations.push("assignee".to_string());
        }
        if fields["reporter"]["accountId"].as_str() == Some(me) {
            relations.push("reporter".to_string());
        }
    }
    if fields["watches"]["isWatching"].as_bool() == Some(true) {
        relations.push("watcher".to_string());
    }

    JiraIssueSummary {
        summary: fields["summary"].as_str().unwrap_or_default().to_string(),
        status: fields["status"]["name"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        assignee: fields["assignee"]["displayName"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        assignee_avatar: fields["assignee"]["avatarUrls"]["48x48"]
            .as_str()
            .map(str::to_string),
        updated_at: fields["updated"].as_str().unwrap_or_default().to_string(),
        url: if key.is_empty() {
            String::new()
        } else {
            format!("{site}/browse/{key}")
        },
        relations,
        key,
    }
}
