use crate::models::{
    CommandError, CommandResult, GitBranchSummary, GitCommitSummary, GitFileDiff, GitFileStatus,
    GitGraphCell, GitRepositoryState, PullRequestComment, PullRequestDetail, PullRequestFile,
    PullRequestSummary,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git_output(root: &Path, args: &[&str]) -> CommandResult<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|err| CommandError::io("Git 명령을 실행하지 못했습니다.", err))?;

    if !output.status.success() {
        return Err(CommandError::with_details(
            "GitCommandFailed",
            "Git 명령 실행에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn git_output_allow_fail(root: &Path, args: &[&str]) -> Option<String> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn resolve_git_root(path: &Path) -> CommandResult<PathBuf> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|err| CommandError::io("Git 저장소를 확인하지 못했습니다.", err))?;

    if !output.status.success() {
        return Err(CommandError::new(
            "NotGitRepository",
            "Git 저장소를 선택해주세요.",
        ));
    }

    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err(CommandError::new(
            "NotGitRepository",
            "Git 저장소를 선택해주세요.",
        ));
    }

    let bare = git_output(Path::new(&root), &["rev-parse", "--is-bare-repository"])?;
    if bare.trim() == "true" {
        return Err(CommandError::new(
            "BareRepositoryUnsupported",
            "Bare repository는 아직 지원하지 않습니다.",
        ));
    }

    Ok(PathBuf::from(root))
}

pub fn pull_requests(root: &Path) -> CommandResult<Vec<PullRequestSummary>> {
    // ponytail: reuse the already-authed `gh` CLI instead of an in-app GitHub client.
    let output = Command::new("gh")
        .current_dir(root)
        .args([
            "pr", "list", "--state", "all", "--limit", "50", "--json",
            "number,title,author,headRefName,baseRefName,state,isDraft,reviewDecision,statusCheckRollup,url,updatedAt",
        ])
        .output();

    // No gh, no GitHub remote, or not authed -> empty list; the screen renders its empty state.
    let output = match output {
        Ok(output) if output.status.success() => output,
        _ => return Ok(Vec::new()),
    };

    let parsed: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap_or_default();
    Ok(parsed.iter().map(pr_from_json).collect())
}

pub fn pull_request_detail(root: &Path, number: i64) -> CommandResult<PullRequestDetail> {
    // ponytail: one `gh pr view` for the heavy fields the list query skips.
    let output = Command::new("gh")
        .current_dir(root)
        .args([
            "pr",
            "view",
            &number.to_string(),
            "--json",
            "body,additions,deletions,changedFiles,commits,comments,reviews,labels,files",
        ])
        .output()
        .map_err(|err| CommandError::io("PR 상세를 불러오지 못했습니다.", err))?;
    if !output.status.success() {
        return Err(CommandError::with_details(
            "GhCommandFailed",
            "PR 상세를 불러오지 못했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    Ok(PullRequestDetail {
        body: value["body"].as_str().unwrap_or_default().to_string(),
        additions: value["additions"].as_i64().unwrap_or(0),
        deletions: value["deletions"].as_i64().unwrap_or(0),
        changed_files: value["changedFiles"].as_i64().unwrap_or(0),
        commits: value["commits"]
            .as_array()
            .map(|a| a.len() as i64)
            .unwrap_or(0),
        labels: value["labels"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|l| l["name"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        files: value["files"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|f| PullRequestFile {
                        path: f["path"].as_str().unwrap_or_default().to_string(),
                        additions: f["additions"].as_i64().unwrap_or(0),
                        deletions: f["deletions"].as_i64().unwrap_or(0),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        comments: pr_comment_timeline(&value),
    })
}

pub fn pull_request_diff(root: &Path, number: i64) -> CommandResult<String> {
    // ponytail: `gh pr diff` returns the whole unified diff; the screen splits it per file.
    let output = Command::new("gh")
        .current_dir(root)
        .args(["pr", "diff", &number.to_string()])
        .output()
        .map_err(|err| CommandError::io("PR diff를 불러오지 못했습니다.", err))?;
    if !output.status.success() {
        return Err(CommandError::with_details(
            "GhCommandFailed",
            "PR diff를 불러오지 못했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// Merge issue comments and reviews into one chronological thread.
fn pr_comment_timeline(value: &Value) -> Vec<PullRequestComment> {
    let mut items = Vec::new();
    if let Some(comments) = value["comments"].as_array() {
        for c in comments {
            items.push(PullRequestComment {
                author: c["author"]["login"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                body: c["body"].as_str().unwrap_or_default().to_string(),
                created_at: c["createdAt"].as_str().unwrap_or_default().to_string(),
                kind: "comment".to_string(),
            });
        }
    }
    if let Some(reviews) = value["reviews"].as_array() {
        for r in reviews {
            let body = r["body"].as_str().unwrap_or_default().to_string();
            let state = r["state"].as_str().unwrap_or_default();
            // A bare COMMENTED review with no body carries no information — skip it.
            if body.trim().is_empty() && state == "COMMENTED" {
                continue;
            }
            items.push(PullRequestComment {
                author: r["author"]["login"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                body,
                created_at: r["submittedAt"].as_str().unwrap_or_default().to_string(),
                kind: state.to_string(),
            });
        }
    }
    items.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    items
}

pub fn approve_pull_request(root: &Path, number: i64) -> CommandResult<()> {
    gh_pr_action(
        root,
        &["pr", "review", &number.to_string(), "--approve"],
        "PR 승인에 실패했습니다.",
        None,
    )
}

pub fn merge_pull_request(root: &Path, number: i64) -> CommandResult<()> {
    gh_pr_action(
        root,
        &["pr", "merge", &number.to_string(), "--merge"],
        "PR 머지에 실패했습니다.",
        None,
    )
}

/// 외부(GitHub 웹/CLI)에서 머지된 PR 번호 목록. gh가 없거나 인증 안 됐으면 빈 목록.
/// ponytail: 단일 `gh pr list --state merged` 호출로 전부 커버. PR별 view는 안 한다.
pub fn merged_pr_numbers(root: &Path) -> Vec<i64> {
    let output = Command::new("gh")
        .current_dir(root)
        .args(["pr", "list", "--state", "merged", "--limit", "50", "--json", "number"])
        .output();
    let output = match output {
        Ok(output) if output.status.success() => output,
        _ => return Vec::new(),
    };
    let parsed: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap_or_default();
    parsed.iter().filter_map(|v| v["number"].as_i64()).collect()
}

/// Open a PR from `head` into `base`. Returns the PR URL printed on stdout.
/// `--head` is explicit so the PR never originates from `base` (e.g. main).
/// 저장소의 PR 템플릿을 표준 위치에서 찾아 본문을 반환한다. 없으면 None.
/// ponytail: GitHub이 인식하는 단일 파일 경로만 검사. `.github/PULL_REQUEST_TEMPLATE/`
/// 복수 템플릿 디렉터리가 필요해지면 그때 추가한다.
pub fn find_pr_template(root: &Path) -> Option<String> {
    const CANDIDATES: [&str; 6] = [
        ".github/PULL_REQUEST_TEMPLATE.md",
        ".github/pull_request_template.md",
        "docs/PULL_REQUEST_TEMPLATE.md",
        "docs/pull_request_template.md",
        "PULL_REQUEST_TEMPLATE.md",
        "pull_request_template.md",
    ];
    for candidate in CANDIDATES {
        if let Ok(content) = std::fs::read_to_string(root.join(candidate)) {
            if !content.trim().is_empty() {
                return Some(content);
            }
        }
    }
    None
}

pub fn create_pull_request(
    root: &Path,
    base: &str,
    head: &str,
    title: &str,
    body: &str,
) -> CommandResult<String> {
    let output = Command::new("gh")
        .current_dir(root)
        .args([
            "pr",
            "create",
            "--base",
            base,
            "--head",
            head,
            "--title",
            title,
            "--body",
            body,
            // PR을 gh 인증 사용자(=실행한 사용자)에게 할당한다. @me는 username 조회 없이 안전하게 해석된다.
            "--assignee",
            "@me",
        ])
        .output()
        .map_err(|err| CommandError::io("PR 생성에 실패했습니다.", err))?;
    if !output.status.success() {
        return Err(CommandError::with_details(
            "GhCommandFailed",
            "PR 생성에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Post a PR comment. When `token` is `Some`, it is injected as `GH_TOKEN` so the
/// comment is authored by that identity (e.g. a GitHub App installation token)
/// instead of the default `gh` account.
pub fn comment_pull_request(
    root: &Path,
    number: i64,
    body: &str,
    token: Option<&str>,
) -> CommandResult<()> {
    gh_pr_action(
        root,
        &["pr", "comment", &number.to_string(), "--body", body],
        "PR 코멘트 작성에 실패했습니다.",
        token,
    )
}

fn gh_pr_action(
    root: &Path,
    args: &[&str],
    failure: &str,
    token: Option<&str>,
) -> CommandResult<()> {
    let mut command = Command::new("gh");
    command.current_dir(root).args(args);
    if let Some(token) = token {
        command.env("GH_TOKEN", token);
    }
    let output = command
        .output()
        .map_err(|err| CommandError::io(failure, err))?;
    if !output.status.success() {
        return Err(CommandError::with_details(
            "GhCommandFailed",
            failure,
            String::from_utf8_lossy(&output.stderr),
        ));
    }
    Ok(())
}

fn pr_from_json(value: &Value) -> PullRequestSummary {
    PullRequestSummary {
        project_id: String::new(),
        project_name: String::new(),
        number: value["number"].as_i64().unwrap_or(0),
        title: value["title"].as_str().unwrap_or_default().to_string(),
        author: value["author"]["login"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        branch: value["headRefName"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        base: value["baseRefName"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        state: value["state"].as_str().unwrap_or("OPEN").to_string(),
        is_draft: value["isDraft"].as_bool().unwrap_or(false),
        review_decision: value["reviewDecision"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        checks: check_rollup_state(&value["statusCheckRollup"]),
        url: value["url"].as_str().unwrap_or_default().to_string(),
        updated_at: value["updatedAt"].as_str().unwrap_or_default().to_string(),
    }
}

fn check_rollup_state(value: &Value) -> String {
    let Some(items) = value.as_array() else {
        return "none".to_string();
    };
    if items.is_empty() {
        return "none".to_string();
    }
    let mut pending = false;
    for item in items {
        let conclusion = item["conclusion"].as_str().unwrap_or_default();
        let status = item["status"].as_str().unwrap_or_default();
        let state = item["state"].as_str().unwrap_or_default(); // legacy commit-status checks
        if matches!(
            conclusion,
            "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ERROR" | "STARTUP_FAILURE"
        ) || matches!(state, "FAILURE" | "ERROR")
        {
            return "failing".to_string();
        }
        if (!status.is_empty() && status != "COMPLETED") || state == "PENDING" {
            pending = true;
        }
    }
    if pending {
        "pending".to_string()
    } else {
        "passing".to_string()
    }
}

pub fn repository_state(root: &Path) -> CommandResult<GitRepositoryState> {
    let current_branch =
        git_output_allow_fail(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let head = git_output_allow_fail(root, &["rev-parse", "--verify", "HEAD"]);
    let files = changed_files(root)?;
    let staged_count = files.iter().filter(|file| file.staged).count();
    let untracked_count = files
        .iter()
        .filter(|file| file.status == "untracked")
        .count();
    let unstaged_count = files
        .iter()
        .filter(|file| !file.staged && file.status != "untracked")
        .count();

    Ok(GitRepositoryState {
        current_branch: current_branch.clone(),
        head,
        is_detached: current_branch.is_none(),
        dirty_count: files.len(),
        staged_count,
        unstaged_count,
        untracked_count,
        user_name: git_output_allow_fail(root, &["config", "--get", "user.name"]),
        user_email: git_output_allow_fail(root, &["config", "--get", "user.email"]),
    })
}

pub fn current_branch(root: &Path) -> Option<String> {
    git_output_allow_fail(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
}

pub fn head_hash(root: &Path) -> Option<String> {
    git_output_allow_fail(root, &["rev-parse", "--verify", "HEAD"])
}

pub fn stage_all(root: &Path) -> CommandResult<()> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["add", "-A"])
        .output()
        .map_err(|err| CommandError::io("Git stage에 실패했습니다.", err))?;

    if !output.status.success() {
        return Err(CommandError::with_details(
            "GitCommandFailed",
            "Git stage에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    Ok(())
}

pub fn commit_staged(root: &Path, message: &str) -> CommandResult<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["commit", "-m", message])
        .output()
        .map_err(|err| CommandError::io("Git commit에 실패했습니다.", err))?;

    if !output.status.success() {
        return Err(CommandError::with_details(
            "GitCommandFailed",
            "Git commit에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    head_hash(root).ok_or_else(|| {
        CommandError::new(
            "GitCommandFailed",
            "커밋은 생성됐지만 HEAD commit hash를 확인하지 못했습니다.",
        )
    })
}

pub fn push_branch(root: &Path, branch_name: &str) -> CommandResult<()> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["push", "-u", "origin", branch_name])
        .output()
        .map_err(|err| CommandError::io("Git push에 실패했습니다.", err))?;

    if !output.status.success() {
        return Err(CommandError::with_details(
            "GitCommandFailed",
            "Git push에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    Ok(())
}

pub fn branch_exists(root: &Path, branch_name: &str) -> CommandResult<bool> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch_name}"))
        .output()
        .map_err(|err| CommandError::io("Git branch 확인에 실패했습니다.", err))?;
    Ok(output.status.success())
}

pub fn switch_branch(root: &Path, branch_name: &str) -> CommandResult<()> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["switch", branch_name])
        .output()
        .map_err(|err| CommandError::io("Git branch 전환에 실패했습니다.", err))?;

    if !output.status.success() {
        return Err(CommandError::with_details(
            "GitCommandFailed",
            "Git branch 전환에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    Ok(())
}

pub fn add_worktree(
    root: &Path,
    worktree_path: &Path,
    branch_name: &str,
    base_ref: &str,
) -> CommandResult<()> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["worktree", "add", "-b"])
        .arg(branch_name)
        .arg(worktree_path)
        .arg(base_ref)
        .output()
        .map_err(|err| CommandError::io("Git worktree를 만들지 못했습니다.", err))?;

    if !output.status.success() {
        return Err(CommandError::with_details(
            "GitCommandFailed",
            "Git worktree 생성에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    Ok(())
}

// 현재 root에서 HEAD를 기준으로 새 브랜치를 만들고 체크아웃한다(in-place 모드 전용).
// 보호 브랜치(main 등)에서 in-place 작업을 시작할 때 그 브랜치를 직접 건드리지 않으려고 쓴다.
pub fn create_and_checkout_branch(root: &Path, branch_name: &str) -> CommandResult<()> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["checkout", "-b"])
        .arg(branch_name)
        .output()
        .map_err(|err| CommandError::io("Git 브랜치를 만들지 못했습니다.", err))?;

    if !output.status.success() {
        return Err(CommandError::with_details(
            "GitCommandFailed",
            "Git 브랜치 생성/체크아웃에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    Ok(())
}

// (path, branch) for every git worktree of this repo, main worktree included.
// best-effort: a non-git dir just yields an empty list instead of failing the caller.
pub fn list_worktrees(root: &Path) -> Vec<(String, Option<String>)> {
    match git_output_allow_fail(root, &["worktree", "list", "--porcelain"]) {
        Some(output) => parse_worktree_porcelain(&output),
        None => Vec::new(),
    }
}

fn parse_worktree_porcelain(output: &str) -> Vec<(String, Option<String>)> {
    let mut worktrees = Vec::new();
    let mut path: Option<String> = None;
    let mut branch: Option<String> = None;
    for line in output.lines().chain(std::iter::once("")) {
        if let Some(rest) = line.strip_prefix("worktree ") {
            path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = Some(rest.trim_start_matches("refs/heads/").to_string());
        } else if line.is_empty() {
            if let Some(path) = path.take() {
                worktrees.push((path, branch.take()));
            }
            branch = None;
        }
    }
    worktrees
}

// 디스크에서 사라진 worktree의 admin 엔트리(.git/worktrees/*)를 정리한다. stale 엔트리가
// 남으면 같은 경로의 worktree add나 branch -D가 실패하므로 cleanup 경로에서 best-effort로 호출한다.
pub fn prune_worktrees(root: &Path) {
    let _ = git_output_allow_fail(root, &["worktree", "prune"]);
}

// 새 worktree에는 git-lfs/husky 등 훅이 post-checkout 시점에 .husky/_/* 같은 캐시 파일을
// 만들어 둔다. 메인 레포는 이를 gitignore하지만 worktree엔 그 ignore 파일이 따라오지 않아
// untracked로 남고, coder diff 정합성 게이트와 merge 커밋을 오염시킨다. worktree 생성 직후의
// untracked(= coder가 건드리기 전의 baseline 노이즈)를 공용 info/exclude에 등록해 이후
// git status/diff/add에서 빠지게 한다. best-effort.
pub fn exclude_baseline_untracked(worktree_path: &Path) {
    let Some(status) = git_output_allow_fail(
        worktree_path,
        &["status", "--porcelain", "--untracked-files=all"],
    ) else {
        return;
    };
    let paths: Vec<String> = status
        .lines()
        .filter_map(|line| line.strip_prefix("?? "))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if paths.is_empty() {
        return;
    }
    let Some(exclude_raw) =
        git_output_allow_fail(worktree_path, &["rev-parse", "--git-path", "info/exclude"])
    else {
        return;
    };
    let exclude_rel = Path::new(exclude_raw.trim());
    let exclude_abs = if exclude_rel.is_absolute() {
        exclude_rel.to_path_buf()
    } else {
        worktree_path.join(exclude_rel)
    };
    let existing = std::fs::read_to_string(&exclude_abs).unwrap_or_default();
    let mut have: HashSet<&str> = existing.lines().map(str::trim).collect();
    let mut additions = String::new();
    for path in &paths {
        if have.insert(path.as_str()) {
            additions.push_str(path);
            additions.push('\n');
        }
    }
    if additions.is_empty() {
        return;
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&additions);
    let _ = std::fs::write(&exclude_abs, content);
}

pub fn remove_worktree(root: &Path, worktree_path: &Path) -> CommandResult<()> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["worktree", "remove", "--force"])
        .arg(worktree_path)
        .output()
        .map_err(|err| CommandError::io("Git worktree 제거에 실패했습니다.", err))?;

    if !output.status.success() {
        return Err(CommandError::with_details(
            "GitCommandFailed",
            "Git worktree 제거에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    Ok(())
}

pub fn changed_files(root: &Path) -> CommandResult<Vec<GitFileStatus>> {
    let output = git_output(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let parts: Vec<&str> = output.split('\0').filter(|part| !part.is_empty()).collect();
    let mut files = Vec::new();
    let mut index = 0;

    while index < parts.len() {
        let entry = parts[index];
        if entry.len() < 4 {
            index += 1;
            continue;
        }

        let status_code = &entry[0..2];
        let path = entry[3..].to_string();
        let mut renamed_from = None;

        if status_code.contains('R') || status_code.contains('C') {
            if let Some(next) = parts.get(index + 1) {
                renamed_from = Some((*next).to_string());
                index += 1;
            }
        }

        if is_helm_path(&path) || renamed_from.as_deref().is_some_and(is_helm_path) {
            index += 1;
            continue;
        }

        let staged = status_code
            .chars()
            .next()
            .is_some_and(|ch| ch != ' ' && ch != '?');
        let status = if status_code == "??" {
            "untracked".to_string()
        } else if status_code.contains('R') {
            "renamed".to_string()
        } else if status_code.contains('A') {
            "added".to_string()
        } else if status_code.contains('D') {
            "deleted".to_string()
        } else {
            "modified".to_string()
        };

        files.push(GitFileStatus {
            path,
            status,
            staged,
            renamed_from,
        });
        index += 1;
    }

    Ok(files)
}

pub fn ignored_files(root: &Path, limit: usize) -> CommandResult<Vec<GitFileStatus>> {
    let output = git_output(
        root,
        &["status", "--porcelain=v1", "-z", "--ignored=matching"],
    )?;
    let mut files = Vec::new();

    for entry in output.split('\0').filter(|part| !part.is_empty()) {
        if files.len() >= limit {
            break;
        }
        if entry.len() < 4 || &entry[0..2] != "!!" {
            continue;
        }

        files.push(GitFileStatus {
            path: entry[3..].to_string(),
            status: "ignored".to_string(),
            staged: false,
            renamed_from: None,
        });
    }

    Ok(files)
}

pub fn commit_changed_files(root: &Path, commit_hash: &str) -> CommandResult<Vec<GitFileStatus>> {
    let commit_hash = resolve_commit_hash(root, commit_hash)?;
    let output = git_output(
        root,
        &[
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-status",
            "-r",
            "-M",
            &commit_hash,
        ],
    )?;

    Ok(output.lines().filter_map(parse_name_status_line).collect())
}

pub fn commit_file_diff(root: &Path, commit_hash: &str, path: &str) -> CommandResult<GitFileDiff> {
    let commit_hash = resolve_commit_hash(root, commit_hash)?;
    let path = validated_repo_relative_path(path)?;
    let parent_hash = first_parent_or_empty_tree(root, &commit_hash)?;

    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["diff", "--no-color", "-M"])
        .arg(parent_hash)
        .arg(&commit_hash)
        .arg("--")
        .arg(path)
        .output()
        .map_err(|err| CommandError::io("Git diff를 만들지 못했습니다.", err))?;

    if !(output.status.success() || output.status.code() == Some(1)) {
        return Err(CommandError::with_details(
            "GitCommandFailed",
            "Git diff 실행에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    Ok(GitFileDiff {
        path: path.to_string(),
        mode: "commit".to_string(),
        diff: String::from_utf8_lossy(&output.stdout).to_string(),
    })
}

pub fn file_diff(root: &Path, path: &str, mode: &str) -> CommandResult<GitFileDiff> {
    let path = validated_repo_relative_path(path)?;

    let mode = match mode {
        "staged" => "staged",
        "worktree" | "" => "worktree",
        _ => return Err(CommandError::validation("지원하지 않는 diff 모드입니다.")),
    };

    let mut command = Command::new("git");
    command.arg("-C").arg(root);
    if mode == "staged" {
        command
            .args(["diff", "--no-color", "--cached", "--"])
            .arg(path);
    } else if !root.join(path).exists() {
        command.args(["diff", "--no-color", "--"]).arg(path);
    } else {
        let status = changed_files(root)?
            .into_iter()
            .find(|file| file.path == path)
            .map(|file| file.status)
            .unwrap_or_else(|| "modified".to_string());
        if status == "untracked" {
            command
                .args(["diff", "--no-color", "--no-index", "--"])
                .arg("/dev/null")
                .arg(path);
        } else {
            command.args(["diff", "--no-color", "--"]).arg(path);
        }
    }

    let output = command
        .output()
        .map_err(|err| CommandError::io("Git diff를 만들지 못했습니다.", err))?;

    let acceptable_status = if mode == "worktree" {
        output.status.success() || output.status.code() == Some(1)
    } else {
        output.status.success()
    };
    if !acceptable_status {
        return Err(CommandError::with_details(
            "GitCommandFailed",
            "Git diff 실행에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    Ok(GitFileDiff {
        path: path.to_string(),
        mode: mode.to_string(),
        diff: String::from_utf8_lossy(&output.stdout).to_string(),
    })
}

fn resolve_commit_hash(root: &Path, commit_hash: &str) -> CommandResult<String> {
    let commit_hash = commit_hash.trim();
    if commit_hash.is_empty()
        || commit_hash.starts_with('-')
        || !commit_hash
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() || ch == '/' || ch == '-' || ch == '_' || ch == '.')
    {
        return Err(CommandError::validation("커밋을 선택해주세요."));
    }

    let revision = format!("{commit_hash}^{{commit}}");
    Ok(git_output(root, &["rev-parse", "--verify", &revision])?
        .trim()
        .to_string())
}

fn first_parent_or_empty_tree(root: &Path, commit_hash: &str) -> CommandResult<String> {
    let output = git_output(root, &["rev-list", "--parents", "-n", "1", commit_hash])?;
    let parts: Vec<&str> = output.split_whitespace().collect();
    Ok(parts
        .get(1)
        .copied()
        .unwrap_or("4b825dc642cb6eb9a060e54bf8d69288fbee4904")
        .to_string())
}

fn validated_repo_relative_path(path: &str) -> CommandResult<&str> {
    let path = path.trim();
    if path.is_empty() {
        return Err(CommandError::validation("diff를 볼 파일을 선택해주세요."));
    }
    if path.starts_with('/') || path.split('/').any(|part| part == "..") {
        return Err(CommandError::validation(
            "저장소 내부 파일만 diff를 볼 수 있습니다.",
        ));
    }
    Ok(path)
}

fn parse_name_status_line(line: &str) -> Option<GitFileStatus> {
    let fields: Vec<&str> = line.split('\t').collect();
    let raw_status = fields.first()?.trim();
    let status_code = raw_status.chars().next()?;

    let (path, renamed_from) = if status_code == 'R' || status_code == 'C' {
        (
            fields.get(2)?.to_string(),
            fields.get(1).map(|value| (*value).to_string()),
        )
    } else {
        (fields.get(1)?.to_string(), None)
    };

    let status = match status_code {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        _ => "modified",
    };

    Some(GitFileStatus {
        path,
        status: status.to_string(),
        staged: false,
        renamed_from,
    })
}

pub fn local_branches(root: &Path) -> CommandResult<Vec<GitBranchSummary>> {
    let current = git_output_allow_fail(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let output = git_output(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(authorname)%00%(committerdate:iso-strict)",
            "refs/heads",
        ],
    )?;

    Ok(output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\0').collect();
            if fields.len() < 6 || fields[0].is_empty() {
                return None;
            }
            let (ahead, behind) = parse_track(fields[3]);
            Some(GitBranchSummary {
                branch_name: fields[0].to_string(),
                head_hash: fields[1].to_string(),
                upstream: (!fields[2].is_empty()).then(|| fields[2].to_string()),
                ahead,
                behind,
                is_current: current.as_deref() == Some(fields[0]),
                author_name: fields[4].to_string(),
                committed_at: fields[5].to_string(),
            })
        })
        .collect())
}

pub fn delete_branch(root: &Path, branch_name: &str, delete_remote: bool) -> CommandResult<()> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["branch", "-D", branch_name])
        .output()
        .map_err(|err| CommandError::io("Git branch 삭제에 실패했습니다.", err))?;

    if !output.status.success() {
        return Err(CommandError::with_details(
            "GitCommandFailed",
            "로컬 branch 삭제에 실패했습니다.",
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    if delete_remote {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["push", "origin", "--delete", branch_name])
            .output()
            .map_err(|err| CommandError::io("원격 branch 삭제에 실패했습니다.", err))?;

        if !output.status.success() {
            return Err(CommandError::with_details(
                "GitCommandFailed",
                "원격 branch 삭제에 실패했습니다. (로컬 branch는 이미 삭제됨)",
                String::from_utf8_lossy(&output.stderr),
            ));
        }
    }

    Ok(())
}

pub fn recent_commits(root: &Path, limit: i64) -> CommandResult<Vec<GitCommitSummary>> {
    let user_email = git_output_allow_fail(root, &["config", "--get", "user.email"]);
    let head = head_hash(root);
    let limit_arg = format!("-n{}", limit.clamp(1, 100));
    let output = match git_output(
        root,
        &[
            "log",
            "--all",
            "--topo-order",
            "--decorate=short",
            &limit_arg,
            "--date=iso-strict",
            "--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%ad%x00%D%x00%s%x1e",
        ],
    ) {
        Ok(output) => output,
        Err(err) if err.code == "GitCommandFailed" => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };

    let records = parse_commit_records(&output);
    let graph_rows = build_commit_graph(&records);

    Ok(records
        .into_iter()
        .zip(graph_rows)
        .map(|(record, graph)| {
            let is_head = head.as_deref() == Some(record.hash.as_str());
            let is_mine = user_email.as_deref() == Some(record.author_email.as_str());

            GitCommitSummary {
                hash: record.hash,
                short_hash: record.short_hash,
                graph_cells: cells_to_dtos(&graph.cells),
                graph_connector_rows: graph
                    .connector_rows
                    .iter()
                    .map(|row| cells_to_dtos(row))
                    .collect(),
                graph_lane: graph.lane,
                graph_color_index: graph.color_index,
                author_name: record.author_name,
                author_email: record.author_email,
                committed_at: record.committed_at,
                refs: record.refs,
                subject: record.subject,
                is_mine,
                is_head,
            }
        })
        .collect())
}

#[derive(Clone, Debug)]
struct GitCommitRecord {
    hash: String,
    short_hash: String,
    parent_hashes: Vec<String>,
    author_name: String,
    author_email: String,
    committed_at: String,
    refs: Vec<String>,
    subject: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GraphCell {
    Empty,
    Pipe(usize),
    Commit(usize),
    BranchRight(usize),
    BranchLeft(usize),
    MergeRight(usize),
    MergeLeft(usize),
    Horizontal(usize),
    HorizontalPipe(usize, usize),
    TeeRight(usize),
    TeeLeft(usize),
    TeeUp(usize),
}

#[derive(Clone, Debug)]
struct RenderedCommitGraph {
    connector_rows: Vec<Vec<GraphCell>>,
    cells: Vec<GraphCell>,
    lane: usize,
    color_index: usize,
}

#[derive(Clone, Debug)]
struct ParentLane {
    lane: usize,
    was_existing: bool,
    color_index: usize,
    already_shown: bool,
}

const GRAPH_COLOR_COUNT: usize = 8;
const MAIN_GRAPH_COLOR_INDEX: usize = 0;

fn parse_commit_records(output: &str) -> Vec<GitCommitRecord> {
    output
        .split('\u{1e}')
        .filter_map(|raw_entry| {
            let entry = raw_entry.trim_matches('\n');
            if entry.is_empty() {
                return None;
            }

            let fields: Vec<&str> = entry.split('\0').collect();
            if fields.len() < 8 {
                return None;
            }

            let refs = fields[6]
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect();

            Some(GitCommitRecord {
                hash: fields[0].to_string(),
                short_hash: fields[1].to_string(),
                parent_hashes: fields[2].split_whitespace().map(str::to_string).collect(),
                author_name: fields[3].to_string(),
                author_email: fields[4].to_string(),
                committed_at: fields[5].to_string(),
                refs,
                subject: fields[7].to_string(),
            })
        })
        .collect()
}

fn build_commit_graph(records: &[GitCommitRecord]) -> Vec<RenderedCommitGraph> {
    if records.is_empty() {
        return Vec::new();
    }

    let hash_to_row: HashMap<String, usize> = records
        .iter()
        .enumerate()
        .map(|(index, commit)| (commit.hash.clone(), index))
        .collect();

    let mut parent_children: HashMap<String, Vec<String>> = HashMap::new();
    for commit in records {
        for parent_hash in &commit.parent_hashes {
            if hash_to_row.contains_key(parent_hash) {
                parent_children
                    .entry(parent_hash.clone())
                    .or_default()
                    .push(commit.hash.clone());
            }
        }
    }
    let fork_points: HashSet<String> = parent_children
        .iter()
        .filter(|(_, children)| children.len() >= 2)
        .map(|(parent_hash, _)| parent_hash.clone())
        .collect();

    let mut lanes: Vec<Option<String>> = Vec::new();
    let mut rendered = Vec::with_capacity(records.len());
    let mut max_lane = 0;
    let mut shown_hashes: HashSet<String> = HashSet::new();
    let mut color_assigner = GraphColorAssigner::new();
    let mut hash_color_index: HashMap<String, usize> = HashMap::new();
    let mut lane_color_index: HashMap<usize, usize> = HashMap::new();

    for commit in records {
        color_assigner.advance_row();
        let mut connector_rows = Vec::new();

        let commit_lane_opt = lanes
            .iter()
            .position(|lane_hash| lane_hash.as_deref() == Some(commit.hash.as_str()));
        let lane = commit_lane_opt.unwrap_or_else(|| find_or_create_lane(&mut lanes));

        let fork_lanes: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter(|(_, lane_hash)| lane_hash.as_deref() == Some(commit.hash.as_str()))
            .map(|(index, _)| index)
            .collect();

        if fork_lanes.len() >= 2 {
            let main_lane = *fork_lanes.iter().min().unwrap_or(&lane);
            let merging_lanes: Vec<(usize, usize)> = fork_lanes
                .iter()
                .copied()
                .filter(|candidate| *candidate != main_lane)
                .map(|merge_lane| {
                    let color = lane_color_index
                        .get(&merge_lane)
                        .copied()
                        .or_else(|| hash_color_index.get(&commit.hash).copied())
                        .unwrap_or(merge_lane % GRAPH_COLOR_COUNT);
                    (merge_lane, color)
                })
                .collect();

            max_lane = max_lane.max(main_lane);
            for (merge_lane, _) in &merging_lanes {
                max_lane = max_lane.max(*merge_lane);
            }

            let main_color = lane_color_index
                .get(&main_lane)
                .copied()
                .or_else(|| hash_color_index.get(&commit.hash).copied())
                .unwrap_or(MAIN_GRAPH_COLOR_INDEX);
            connector_rows.push(build_fork_connector_cells(
                main_lane,
                main_color,
                &merging_lanes,
                &lanes,
                &hash_color_index,
                &lane_color_index,
                max_lane,
            ));

            for (merge_lane, _) in merging_lanes {
                if merge_lane < lanes.len() {
                    lanes[merge_lane] = None;
                    color_assigner.release_lane(merge_lane);
                    lane_color_index.remove(&merge_lane);
                }
            }
        }

        let commit_color_index = if commit_lane_opt.is_some() {
            color_assigner.continue_lane(lane)
        } else if rendered.is_empty() {
            color_assigner.assign_main_color(lane)
        } else {
            color_assigner.assign_color(lane)
        };
        hash_color_index.insert(commit.hash.clone(), commit_color_index);
        lane_color_index.insert(lane, commit_color_index);

        if lane < lanes.len() {
            lanes[lane] = None;
        }

        let valid_parents = commit.parent_hashes.clone();
        if valid_parents.len() >= 2 {
            color_assigner.begin_fork();
        }

        let mut parent_lanes = Vec::with_capacity(valid_parents.len());
        let mut fork_sibling_color: Option<usize> = None;

        for (parent_index, parent_hash) in valid_parents.iter().enumerate() {
            let existing_parent_lane = lanes
                .iter()
                .position(|lane_hash| lane_hash.as_deref() == Some(parent_hash.as_str()));
            let parent_already_shown = shown_hashes.contains(parent_hash);

            let (parent_lane, was_existing, parent_color) =
                if let Some(existing_lane) = existing_parent_lane {
                    if parent_index == 0 && fork_points.contains(parent_hash) {
                        lanes[lane] = Some(parent_hash.clone());
                        let color = if color_assigner.is_main_lane(lane) {
                            MAIN_GRAPH_COLOR_INDEX
                        } else {
                            commit_color_index
                        };
                        fork_sibling_color = Some(color);
                        lane_color_index.insert(lane, color);
                        (lane, false, color)
                    } else {
                        let color = lane_color_index
                            .get(&existing_lane)
                            .copied()
                            .or_else(|| hash_color_index.get(parent_hash).copied())
                            .unwrap_or(existing_lane % GRAPH_COLOR_COUNT);
                        (existing_lane, true, color)
                    }
                } else if parent_index == 0 {
                    lanes[lane] = Some(parent_hash.clone());
                    hash_color_index.insert(parent_hash.clone(), commit_color_index);
                    (lane, false, commit_color_index)
                } else {
                    let new_lane = find_or_create_lane(&mut lanes);
                    lanes[new_lane] = Some(parent_hash.clone());
                    let new_color = color_assigner.assign_fork_sibling_color(new_lane);
                    hash_color_index.insert(parent_hash.clone(), new_color);
                    lane_color_index.insert(new_lane, new_color);
                    (new_lane, false, new_color)
                };

            parent_lanes.push(ParentLane {
                lane: parent_lane,
                was_existing,
                color_index: parent_color,
                already_shown: parent_already_shown,
            });
        }

        let final_color_index = fork_sibling_color.unwrap_or(commit_color_index);
        max_lane = max_lane.max(lane);
        for parent_lane in &parent_lanes {
            max_lane = max_lane.max(parent_lane.lane);
        }

        let lane_merge = parent_lanes
            .iter()
            .find(|parent_lane| parent_lane.was_existing && parent_lane.lane != lane)
            .map(|parent_lane| (parent_lane.lane, parent_lane.color_index));

        let cells = build_row_cells_with_colors(
            lane,
            final_color_index,
            &parent_lanes,
            &lanes,
            &hash_color_index,
            &lane_color_index,
            max_lane,
        );

        rendered.push(RenderedCommitGraph {
            connector_rows,
            cells,
            lane,
            color_index: final_color_index,
        });
        shown_hashes.insert(commit.hash.clone());

        if let Some((parent_lane, _)) = lane_merge {
            release_merged_lane(
                lane,
                parent_lane,
                &parent_lanes,
                &mut lanes,
                &mut color_assigner,
                &mut lane_color_index,
                &shown_hashes,
            );
        }
    }

    let required_cells = (max_lane + 1) * 2;
    for row in &mut rendered {
        pad_cells(&mut row.cells, required_cells);
        for connector_row in &mut row.connector_rows {
            pad_cells(connector_row, required_cells);
        }
    }

    rendered
}

fn find_or_create_lane(lanes: &mut Vec<Option<String>>) -> usize {
    if let Some(index) = lanes.iter().position(Option::is_none) {
        index
    } else {
        lanes.push(None);
        lanes.len() - 1
    }
}

fn release_merged_lane(
    commit_lane: usize,
    parent_lane: usize,
    parent_lanes: &[ParentLane],
    lanes: &mut [Option<String>],
    color_assigner: &mut GraphColorAssigner,
    lane_color_index: &mut HashMap<usize, usize>,
    shown_hashes: &HashSet<String>,
) {
    let (main_lane, ending_lane) = if parent_lane < commit_lane {
        (parent_lane, commit_lane)
    } else {
        (commit_lane, parent_lane)
    };
    let ending_hash_already_shown = lanes
        .get(ending_lane)
        .and_then(|hash| hash.as_ref())
        .map(|hash| shown_hashes.contains(hash))
        .unwrap_or(true);
    let first_parent_on_ending_lane = parent_lanes
        .first()
        .map(|parent_lane| parent_lane.lane == ending_lane)
        .unwrap_or(false);

    if !first_parent_on_ending_lane && ending_hash_already_shown && ending_lane < lanes.len() {
        if let Some(hash) = lanes[ending_lane].take() {
            if lanes.get(main_lane).is_some_and(|lane| lane.is_none()) {
                lanes[main_lane] = Some(hash);
            }
        }
        color_assigner.release_lane(ending_lane);
        lane_color_index.remove(&ending_lane);
    }
}

fn build_row_cells_with_colors(
    commit_lane: usize,
    commit_color: usize,
    parent_lanes: &[ParentLane],
    active_lanes: &[Option<String>],
    hash_color_index: &HashMap<String, usize>,
    lane_color_index: &HashMap<usize, usize>,
    max_lane: usize,
) -> Vec<GraphCell> {
    let mut cells = vec![GraphCell::Empty; (max_lane + 1) * 2];

    for (lane_index, lane_hash) in active_lanes.iter().enumerate() {
        if let Some(hash) = lane_hash {
            if lane_index != commit_lane {
                let cell_index = lane_index * 2;
                if cell_index < cells.len() {
                    let color = lane_color_index
                        .get(&lane_index)
                        .copied()
                        .or_else(|| hash_color_index.get(hash).copied())
                        .unwrap_or(lane_index % GRAPH_COLOR_COUNT);
                    cells[cell_index] = GraphCell::Pipe(color);
                }
            }
        }
    }

    let commit_cell_index = commit_lane * 2;
    if commit_cell_index < cells.len() {
        cells[commit_cell_index] = GraphCell::Commit(commit_color);
    }

    for parent_lane in parent_lanes {
        if parent_lane.lane == commit_lane {
            continue;
        }

        if parent_lane.lane > commit_lane {
            for column in (commit_lane * 2 + 1)..(parent_lane.lane * 2) {
                if column < cells.len() {
                    cells[column] = merge_horizontal_cell(cells[column], parent_lane.color_index);
                }
            }
            let end_index = parent_lane.lane * 2;
            if end_index < cells.len() {
                cells[end_index] = if parent_lane.was_existing && parent_lane.already_shown {
                    GraphCell::MergeLeft(parent_lane.color_index)
                } else if parent_lane.was_existing {
                    GraphCell::TeeLeft(parent_lane.color_index)
                } else {
                    GraphCell::BranchLeft(parent_lane.color_index)
                };
            }
        } else {
            for column in (parent_lane.lane * 2 + 1)..(commit_lane * 2) {
                if column < cells.len() {
                    cells[column] = merge_horizontal_cell(cells[column], parent_lane.color_index);
                }
            }
            let start_index = parent_lane.lane * 2;
            if start_index < cells.len() {
                cells[start_index] = if parent_lane.was_existing && parent_lane.already_shown {
                    GraphCell::MergeRight(parent_lane.color_index)
                } else if parent_lane.was_existing {
                    GraphCell::TeeRight(parent_lane.color_index)
                } else {
                    GraphCell::BranchRight(parent_lane.color_index)
                };
            }
        }
    }

    cells
}

fn build_fork_connector_cells(
    main_lane: usize,
    main_color: usize,
    merging_lanes: &[(usize, usize)],
    active_lanes: &[Option<String>],
    hash_color_index: &HashMap<String, usize>,
    lane_color_index: &HashMap<usize, usize>,
    max_lane: usize,
) -> Vec<GraphCell> {
    let mut cells = vec![GraphCell::Empty; (max_lane + 1) * 2];
    let mut merging_lane_numbers: Vec<usize> =
        merging_lanes.iter().map(|(lane, _)| *lane).collect();
    merging_lane_numbers.sort_unstable();

    let main_cell_index = main_lane * 2;
    if main_cell_index < cells.len() {
        cells[main_cell_index] = GraphCell::TeeRight(main_color);
    }

    for (lane_index, lane_hash) in active_lanes.iter().enumerate() {
        if let Some(hash) = lane_hash {
            if lane_index != main_lane && !merging_lane_numbers.contains(&lane_index) {
                let cell_index = lane_index * 2;
                if cell_index < cells.len() {
                    let color = lane_color_index
                        .get(&lane_index)
                        .copied()
                        .or_else(|| hash_color_index.get(hash).copied())
                        .unwrap_or(lane_index % GRAPH_COLOR_COUNT);
                    cells[cell_index] = GraphCell::Pipe(color);
                }
            }
        }
    }

    let rightmost_lane = *merging_lane_numbers.last().unwrap_or(&main_lane);
    for &(merge_lane, merge_color) in merging_lanes {
        for column in (main_lane * 2 + 1)..(merge_lane * 2) {
            if column < cells.len() {
                cells[column] = merge_horizontal_cell(cells[column], merge_color);
            }
        }

        let end_index = merge_lane * 2;
        if end_index < cells.len() {
            cells[end_index] = if merge_lane == rightmost_lane {
                GraphCell::MergeLeft(merge_color)
            } else {
                GraphCell::TeeUp(merge_color)
            };
        }
    }

    cells
}

fn merge_horizontal_cell(existing: GraphCell, color_index: usize) -> GraphCell {
    match existing {
        GraphCell::Pipe(pipe_color) => GraphCell::HorizontalPipe(color_index, pipe_color),
        GraphCell::Empty | GraphCell::Horizontal(_) => GraphCell::Horizontal(color_index),
        other => other,
    }
}

fn pad_cells(cells: &mut Vec<GraphCell>, required_cells: usize) {
    while cells.len() < required_cells {
        cells.push(GraphCell::Empty);
    }
}

fn cells_to_dtos(cells: &[GraphCell]) -> Vec<GitGraphCell> {
    cells
        .iter()
        .map(|cell| match *cell {
            GraphCell::Empty => graph_cell("empty", None, None),
            GraphCell::Pipe(color) => graph_cell("pipe", Some(color), None),
            GraphCell::Commit(color) => graph_cell("commit", Some(color), None),
            GraphCell::BranchRight(color) => graph_cell("branch-right", Some(color), None),
            GraphCell::BranchLeft(color) => graph_cell("branch-left", Some(color), None),
            GraphCell::MergeRight(color) => graph_cell("merge-right", Some(color), None),
            GraphCell::MergeLeft(color) => graph_cell("merge-left", Some(color), None),
            GraphCell::Horizontal(color) => graph_cell("horizontal", Some(color), None),
            GraphCell::HorizontalPipe(horizontal, pipe) => {
                graph_cell("horizontal-pipe", Some(horizontal), Some(pipe))
            }
            GraphCell::TeeRight(color) => graph_cell("tee-right", Some(color), None),
            GraphCell::TeeLeft(color) => graph_cell("tee-left", Some(color), None),
            GraphCell::TeeUp(color) => graph_cell("tee-up", Some(color), None),
        })
        .collect()
}

fn graph_cell(
    kind: &str,
    color_index: Option<usize>,
    secondary_color_index: Option<usize>,
) -> GitGraphCell {
    GitGraphCell {
        kind: kind.to_string(),
        color_index,
        secondary_color_index,
    }
}

#[derive(Debug)]
struct GraphColorAssigner {
    lane_colors: Vec<Option<usize>>,
    lane_last_color: Vec<usize>,
    next_color_index: usize,
    recent_assignments: VecDeque<(usize, usize, usize)>,
    current_row: usize,
    current_fork_colors: HashSet<usize>,
    color_usage_count: [usize; GRAPH_COLOR_COUNT],
    main_lane: Option<usize>,
}

impl GraphColorAssigner {
    fn new() -> Self {
        Self {
            lane_colors: Vec::new(),
            lane_last_color: Vec::new(),
            next_color_index: 1,
            recent_assignments: VecDeque::new(),
            current_row: 0,
            current_fork_colors: HashSet::new(),
            color_usage_count: [0; GRAPH_COLOR_COUNT],
            main_lane: None,
        }
    }

    fn advance_row(&mut self) {
        self.current_row += 1;
        self.current_fork_colors.clear();
    }

    fn begin_fork(&mut self) {
        self.current_fork_colors.clear();
    }

    fn is_main_lane(&self, lane: usize) -> bool {
        self.main_lane == Some(lane)
    }

    fn assign_main_color(&mut self, lane: usize) -> usize {
        self.ensure_capacity(lane);
        self.main_lane = Some(lane);
        self.lane_colors[lane] = Some(MAIN_GRAPH_COLOR_INDEX);
        self.lane_last_color[lane] = MAIN_GRAPH_COLOR_INDEX;
        self.record_assignment(lane, MAIN_GRAPH_COLOR_INDEX);
        MAIN_GRAPH_COLOR_INDEX
    }

    fn continue_lane(&mut self, lane: usize) -> usize {
        self.ensure_capacity(lane);
        if let Some(color) = self.lane_colors[lane] {
            return color;
        }
        if self.is_main_lane(lane) {
            self.assign_main_color(lane)
        } else {
            self.assign_color(lane)
        }
    }

    fn assign_color(&mut self, lane: usize) -> usize {
        self.assign_color_advanced(lane, false)
    }

    fn assign_fork_sibling_color(&mut self, lane: usize) -> usize {
        self.assign_color_advanced(lane, true)
    }

    fn release_lane(&mut self, lane: usize) {
        self.ensure_capacity(lane);
        self.lane_colors[lane] = None;
    }

    fn assign_color_advanced(&mut self, lane: usize, is_fork_sibling: bool) -> usize {
        self.ensure_capacity(lane);

        let mut penalties = [0.0; GRAPH_COLOR_COUNT];
        penalties[MAIN_GRAPH_COLOR_INDEX] += 1000.0;
        penalties[self.lane_last_color[lane]] += 10.0;

        for (other_lane, color) in self.lane_colors.iter().enumerate() {
            if let Some(color) = color {
                let distance = lane.abs_diff(other_lane) as f64;
                penalties[*color] += 8.0 / (distance + 1.0);
            }
        }

        for &(row, history_lane, color) in &self.recent_assignments {
            let row_distance = self.current_row.saturating_sub(row) as f64;
            let lane_distance = lane.abs_diff(history_lane) as f64;
            penalties[color] += (4.0 / (row_distance + 1.0)) * (2.0 / (lane_distance + 1.0));
        }

        if is_fork_sibling {
            for &color in &self.current_fork_colors {
                penalties[color] += 100.0;
            }
        }

        let max_usage = *self.color_usage_count.iter().max().unwrap_or(&0) as f64;
        if max_usage > 0.0 {
            for (color, usage_count) in self.color_usage_count.iter().enumerate() {
                penalties[color] += (*usage_count as f64 / max_usage) * 2.0;
            }
        }

        let mut best_color = 1;
        let mut best_penalty = f64::MAX;
        for offset in 0..GRAPH_COLOR_COUNT {
            let candidate = (self.next_color_index + offset) % GRAPH_COLOR_COUNT;
            if candidate == MAIN_GRAPH_COLOR_INDEX {
                continue;
            }
            if penalties[candidate] < best_penalty {
                best_color = candidate;
                best_penalty = penalties[candidate];
            }
        }

        self.lane_colors[lane] = Some(best_color);
        self.lane_last_color[lane] = best_color;
        self.next_color_index = (best_color + 1) % GRAPH_COLOR_COUNT;
        self.record_assignment(lane, best_color);
        if is_fork_sibling {
            self.current_fork_colors.insert(best_color);
        }

        best_color
    }

    fn ensure_capacity(&mut self, lane: usize) {
        while self.lane_colors.len() <= lane {
            self.lane_colors.push(None);
            self.lane_last_color.push(0);
        }
    }

    fn record_assignment(&mut self, lane: usize, color: usize) {
        self.recent_assignments
            .push_back((self.current_row, lane, color));
        while self.recent_assignments.len() > 6 {
            self.recent_assignments.pop_front();
        }
        self.color_usage_count[color] += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_pr_template_by_priority_else_none() {
        let root = std::env::temp_dir().join("helm_pr_tpl_test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".github")).unwrap();

        assert_eq!(find_pr_template(&root), None);

        std::fs::write(root.join("PULL_REQUEST_TEMPLATE.md"), "root tpl").unwrap();
        std::fs::write(root.join(".github/PULL_REQUEST_TEMPLATE.md"), "github tpl").unwrap();
        // .github가 root보다 우선순위가 높다.
        assert_eq!(find_pr_template(&root).as_deref(), Some("github tpl"));

        std::fs::write(root.join(".github/PULL_REQUEST_TEMPLATE.md"), "   \n").unwrap();
        // 비어있는 후보는 건너뛰고 다음 후보(root)를 쓴다.
        assert_eq!(find_pr_template(&root).as_deref(), Some("root tpl"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parses_worktree_porcelain_with_and_without_branch() {
        let output = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/.helm/worktrees/feat\nHEAD def\nbranch refs/heads/feature/x\n\nworktree /repo/detached\nHEAD 123\ndetached\n";
        let parsed = parse_worktree_porcelain(output);
        assert_eq!(
            parsed,
            vec![
                ("/repo".to_string(), Some("main".to_string())),
                (
                    "/repo/.helm/worktrees/feat".to_string(),
                    Some("feature/x".to_string())
                ),
                ("/repo/detached".to_string(), None),
            ]
        );
    }

    #[test]
    fn truncated_parent_keeps_lane_open_for_next_branch() {
        let records = vec![
            commit_record("branch-a", &["unseen-a"]),
            commit_record("branch-b", &["unseen-b"]),
        ];

        let graph = build_commit_graph(&records);

        assert_eq!(graph[0].lane, 0);
        assert_eq!(graph[1].lane, 1);
        assert!(matches!(graph[1].cells[0], GraphCell::Pipe(_)));
        assert!(matches!(graph[1].cells[2], GraphCell::Commit(_)));
    }

    #[test]
    fn shared_truncated_parent_connects_to_existing_open_lane() {
        let records = vec![
            commit_record("branch-a", &["shared-base"]),
            commit_record("branch-b", &["shared-base"]),
        ];

        let graph = build_commit_graph(&records);

        assert_eq!(graph[0].lane, 0);
        assert_eq!(graph[1].lane, 1);
        assert!(matches!(graph[1].cells[0], GraphCell::TeeRight(_)));
        assert!(matches!(graph[1].cells[1], GraphCell::Horizontal(_)));
        assert!(matches!(graph[1].cells[2], GraphCell::Commit(_)));
    }

    fn commit_record(hash: &str, parents: &[&str]) -> GitCommitRecord {
        GitCommitRecord {
            hash: hash.to_string(),
            short_hash: hash.to_string(),
            parent_hashes: parents.iter().map(|parent| (*parent).to_string()).collect(),
            author_name: "Test".to_string(),
            author_email: "test@example.com".to_string(),
            committed_at: "2026-05-19T00:00:00+09:00".to_string(),
            refs: Vec::new(),
            subject: hash.to_string(),
        }
    }
}

fn parse_track(value: &str) -> (Option<i64>, Option<i64>) {
    let mut ahead = None;
    let mut behind = None;
    for part in value.trim_matches(['[', ']']).split(',') {
        let trimmed = part.trim();
        if let Some(rest) = trimmed.strip_prefix("ahead ") {
            ahead = rest.parse().ok();
        }
        if let Some(rest) = trimmed.strip_prefix("behind ") {
            behind = rest.parse().ok();
        }
    }
    (ahead, behind)
}

fn is_helm_path(path: &str) -> bool {
    path == ".helm" || path.starts_with(".helm/")
}
