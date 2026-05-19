use crate::models::{
    CommandError, CommandResult, GitBranchSummary, GitCommitSummary, GitFileStatus,
    GitRepositoryState,
};
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

pub fn changed_files(root: &Path) -> CommandResult<Vec<GitFileStatus>> {
    let output = git_output(root, &["status", "--porcelain=v1", "-z"])?;
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

pub fn local_branches(root: &Path) -> CommandResult<Vec<GitBranchSummary>> {
    let current = git_output_allow_fail(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let output = git_output(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)",
            "refs/heads",
        ],
    )?;

    Ok(output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\0').collect();
            if fields.len() < 4 || fields[0].is_empty() {
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
            })
        })
        .collect())
}

pub fn recent_commits(root: &Path, limit: i64) -> CommandResult<Vec<GitCommitSummary>> {
    let user_email = git_output_allow_fail(root, &["config", "--get", "user.email"]);
    let limit_arg = format!("-n{}", limit.clamp(1, 100));
    let output = match git_output(
        root,
        &[
            "log",
            &limit_arg,
            "--date=iso-strict",
            "--format=%H%x00%h%x00%an%x00%ae%x00%ad%x00%D%x00%s%x1e",
        ],
    ) {
        Ok(output) => output,
        Err(err) if err.code == "GitCommandFailed" => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };

    Ok(output
        .split('\u{1e}')
        .filter_map(|record| {
            let trimmed = record.trim_matches('\n');
            if trimmed.is_empty() {
                return None;
            }
            let fields: Vec<&str> = trimmed.split('\0').collect();
            if fields.len() < 7 {
                return None;
            }
            let refs = fields[5]
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect();
            Some(GitCommitSummary {
                hash: fields[0].to_string(),
                short_hash: fields[1].to_string(),
                author_name: fields[2].to_string(),
                author_email: fields[3].to_string(),
                committed_at: fields[4].to_string(),
                refs,
                subject: fields[6].to_string(),
                is_mine: user_email.as_deref() == Some(fields[3]),
            })
        })
        .collect())
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
