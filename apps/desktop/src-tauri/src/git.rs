use crate::models::{
    CommandError, CommandResult, GitBranchSummary, GitCommitSummary, GitFileStatus, GitGraphCell,
    GitRepositoryState,
};
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
