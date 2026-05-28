import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AgentRunSummary, ProjectSnapshot, TaskStatus, TaskSummary } from "../lib/types";
import { AgentUsageBar } from "../components/AgentUsageBar";
import { ApprovalInbox } from "../components/ApprovalInbox";
import { TaskBoard } from "../components/TaskBoard";
import { TaskDetail } from "../components/TaskDetail";
import { useToast } from "../components/ToastProvider";
import { api } from "../lib/api";
import { deriveRunLiveState, isRunActiveState, isRunAttentionState, selectVisibleRun } from "../lib/runLiveState";
import { TASK_STATUS_LABEL } from "../lib/status";

interface TasksScreenProps {
  snapshot: ProjectSnapshot | null;
  selectedTask: TaskSummary | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onOpenProject: () => void;
  onRefresh: () => Promise<void>;
  onGoPlanning: () => void;
  onGoGit: () => void;
  onGoSettings: () => void;
}

export function TasksScreen({
  snapshot,
  selectedTask,
  selectedTaskId,
  onSelectTask,
  onOpenProject,
  onRefresh,
  onGoPlanning,
  onGoGit,
  onGoSettings,
}: TasksScreenProps) {
  const { showToast } = useToast();
  const [taskRuns, setTaskRuns] = useState<Record<string, AgentRunSummary[]>>({});
  const [runRefreshKey, setRunRefreshKey] = useState(0);
  const [taskGraphBusy, setTaskGraphBusy] = useState<"export" | "open" | "coordination" | null>(null);
  const taskRunKey = useMemo(
    () => snapshot?.tasks.map((task) => task.id).join(":") ?? "",
    [snapshot?.tasks],
  );
  const planTaskGroups = useMemo(
    () => (snapshot ? groupTasksByPlan(snapshot.tasks, taskRuns) : []),
    [snapshot, taskRuns],
  );

  useEffect(() => {
    if (!snapshot) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    void listen<{ projectId?: string }>("agent-run://updated", (event) => {
      if (!disposed && event.payload.projectId === snapshot.project.id) {
        setRunRefreshKey((value) => value + 1);
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        cleanup = unlisten;
      }
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [snapshot?.project.id]);

  useEffect(() => {
    let disposed = false;
    if (!snapshot || snapshot.tasks.length === 0) {
      setTaskRuns({});
      return;
    }

    void (async () => {
      const entries = await Promise.all(
        snapshot.tasks.map(async (task) => {
          try {
            return [task.id, await api.listAgentRuns(snapshot.project.id, task.id)] as const;
          } catch {
            return [task.id, []] as const;
          }
        }),
      );
      if (!disposed) setTaskRuns(Object.fromEntries(entries));
    })();

    return () => {
      disposed = true;
    };
  }, [snapshot?.project.id, taskRunKey, runRefreshKey]);

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>프로젝트를 열어주세요</h2>
        <p>Git 저장소를 열면 Helm이 repo-local DB와 태스크 보드를 준비합니다.</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          프로젝트 열기
        </button>
      </section>
    );
  }

  async function regenerateTaskGraph() {
    if (!snapshot) return;
    setTaskGraphBusy("export");
    try {
      const conflict = await api.checkTaskGraphConflict(snapshot.project.id);
      const force = conflict.conflict
        ? window.confirm(
            `${conflict.reason ?? "tasks.md가 외부에서 수정되었습니다."}\n\n현재 Helm DB 상태로 덮어쓸까요?`,
          )
        : false;
      if (conflict.conflict && !force) return;
      const exported = await api.exportTaskGraph(snapshot.project.id, force);
      showToast({
        tone: "success",
        title: "tasks.md 재생성 완료",
        description: `${exported.taskCount}개 Task를 ${exported.path}에 저장했습니다.`,
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "tasks.md 재생성 실패",
        description: messageFromError(error, "Task graph를 저장하지 못했습니다."),
      });
    } finally {
      setTaskGraphBusy(null);
    }
  }

  async function openTaskGraph() {
    if (!snapshot) return;
    setTaskGraphBusy("open");
    try {
      const conflict = await api.checkTaskGraphConflict(snapshot.project.id);
      if (!conflict.exists) {
        await api.exportTaskGraph(snapshot.project.id, false);
      } else if (conflict.conflict) {
        showToast({
          tone: "info",
          title: "외부 편집된 tasks.md",
          description: "덮어쓰지 않고 현재 파일을 엽니다. 재생성하려면 충돌 확인 후 진행하세요.",
        });
      }
      await api.openTaskGraph(snapshot.project.id);
    } catch (error) {
      showToast({
        tone: "error",
        title: "tasks.md 열기 실패",
        description: messageFromError(error, "Task graph 파일을 열지 못했습니다."),
      });
    } finally {
      setTaskGraphBusy(null);
    }
  }

  async function exportCoordinationSnapshot() {
    if (!snapshot) return;
    setTaskGraphBusy("coordination");
    try {
      const exported = await api.exportCoordinationSnapshot(snapshot.project.id);
      showToast({
        tone: "success",
        title: "조정 스냅샷 내보내기 완료",
        description: `${exported.taskCount} Task · ${exported.runCount} Run · ${exported.messageCount} Message를 ${exported.path}에 저장했습니다.`,
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "조정 스냅샷 내보내기 실패",
        description: messageFromError(error, "조정 스냅샷을 저장하지 못했습니다."),
      });
    } finally {
      setTaskGraphBusy(null);
    }
  }

  return (
    <div className={selectedTask ? "tasks-layout with-detail" : "tasks-layout"}>
      <section className="task-workspace">
        <div className="section-header">
          <div>
            <h2>Agent board</h2>
            <p>계획, 실행, 검토, 테스트, 머지까지 태스크 흐름을 추적합니다.</p>
          </div>
          <div className="section-header-actions">
            <div className="header-action-primary">
              <button className="primary-button" onClick={onGoPlanning} type="button">
                계획 만들기
              </button>
            </div>
            <div className="header-action-tools" aria-label="태스크 보드 관리 작업">
              <button
                className="secondary-button"
                disabled={taskGraphBusy !== null}
                onClick={openTaskGraph}
                title="현재 태스크 보드를 Markdown 파일로 엽니다."
                type="button"
              >
                {taskGraphBusy === "open" ? "여는 중..." : "tasks.md 열기"}
              </button>
              <button
                className="secondary-button caution"
                disabled={taskGraphBusy !== null}
                onClick={regenerateTaskGraph}
                title="Helm DB 기준으로 tasks.md를 다시 씁니다. 외부 편집이 있으면 확인 후 진행합니다."
                type="button"
              >
                {taskGraphBusy === "export" ? "다시 쓰는 중..." : "tasks.md 다시 쓰기"}
              </button>
              <button
                className="secondary-button"
                disabled={taskGraphBusy !== null}
                onClick={exportCoordinationSnapshot}
                title="다른 에이전트가 읽을 수 있는 .helm/coordination 스냅샷을 내보냅니다."
                type="button"
              >
                {taskGraphBusy === "coordination" ? "내보내는 중..." : "조정 스냅샷 내보내기"}
              </button>
            </div>
          </div>
        </div>

        {snapshot.tasks.length === 0 ? (
          <div className="empty-board-callout">
            <div>
              <strong>아직 실행할 Task가 없습니다.</strong>
              <span>계획을 승인하면 실행, 검토, 테스트 흐름이 이 보드에 나타납니다.</span>
            </div>
            <button className="primary-button" onClick={onGoPlanning} type="button">
              계획 탭에서 시작
            </button>
          </div>
        ) : (
          <div className={planTaskGroups.length > 1 ? "plan-task-groups" : "plan-task-groups single"}>
            {planTaskGroups.map((group) => (
              <section className="plan-task-group" key={group.id}>
                <header className="plan-task-group-header">
                  <div className="plan-task-group-title">
                    <span>{group.caption}</span>
                    <h3>{group.title}</h3>
                    <p>{group.description}</p>
                  </div>
                  <div className="plan-task-group-metrics" aria-label="Plan progress summary">
                    <span>
                      <strong>{group.tasks.length}</strong>
                      Task
                    </span>
                    <span>
                      <strong>{group.subtaskCounts.total}</strong>
                      Subtask
                    </span>
                    <span>
                      <strong>{group.statusSummary}</strong>
                      현재 단계
                    </span>
                  </div>
                </header>
                {group.subtasks.length > 0 ? (
                  <div className="plan-subtask-strip" aria-label="Subtask progress">
                    {group.subtasks.slice(0, 8).map((subtask) => (
                      <span className={`plan-subtask-chip ${subtask.tone}`} key={subtask.id}>
                        <strong>{subtask.state}</strong>
                        {subtask.title}
                      </span>
                    ))}
                    {group.subtasks.length > 8 ? (
                      <span className="plan-subtask-chip muted">+{group.subtasks.length - 8}개 더</span>
                    ) : null}
                  </div>
                ) : null}
                <TaskBoard
                  tasks={group.tasks}
                  taskRuns={taskRuns}
                  selectedTaskId={selectedTaskId}
                  onSelectTask={onSelectTask}
                />
              </section>
            ))}
          </div>
        )}
        <AgentUsageBar snapshot={snapshot} />
        <ApprovalInbox snapshot={snapshot} onRefresh={onRefresh} />
      </section>
      {selectedTask ? (
        <TaskDetail
          snapshot={snapshot}
          task={selectedTask}
          onRefresh={onRefresh}
          onGoGit={onGoGit}
          onGoSettings={onGoSettings}
          onClose={() => onSelectTask(null)}
        />
      ) : null}
    </div>
  );
}

interface PlanTaskGroup {
  id: string;
  title: string;
  caption: string;
  description: string;
  tasks: TaskSummary[];
  subtasks: PlanSubtask[];
  subtaskCounts: Record<PlanProgressTone, number> & { total: number };
  statusSummary: string;
}

interface PlanSubtask {
  id: string;
  title: string;
  state: string;
  tone: PlanProgressTone;
}

type PlanProgressTone = "waiting" | "active" | "done" | "blocked";

function groupTasksByPlan(tasks: TaskSummary[], taskRuns: Record<string, AgentRunSummary[]>): PlanTaskGroup[] {
  const groups = new Map<
    string,
    {
      title: string;
      caption: string;
      description: string;
      tasks: TaskSummary[];
      latestAt: number;
    }
  >();

  for (const task of tasks) {
    const plan = planIdentityForTask(task);
    const group = groups.get(plan.id) ?? {
      title: plan.title,
      caption: plan.caption,
      description: plan.description,
      tasks: [],
      latestAt: 0,
    };
    group.tasks.push(task);
    group.latestAt = Math.max(group.latestAt, Date.parse(task.updatedAt) || Date.parse(task.createdAt) || 0);
    groups.set(plan.id, group);
  }

  return Array.from(groups.entries())
    .map(([id, group]) => {
      const sortedTasks = [...group.tasks].sort(
        (a, b) => a.sortOrder - b.sortOrder || Date.parse(a.createdAt) - Date.parse(b.createdAt),
      );
      const subtasks = sortedTasks.flatMap((task) => {
        const progress = taskProgressForPlan(task, taskRuns[task.id] ?? []);
        return extractSubtasks(task.description).map((title, index) => ({
          id: `${task.id}:${index}`,
          title,
          state: progress.label,
          tone: progress.tone,
        }));
      });
      const subtaskCounts = countSubtaskProgress(subtasks);
      return {
        id,
        title: group.title,
        caption: group.caption,
        description: group.description,
        tasks: sortedTasks,
        subtasks,
        subtaskCounts,
        statusSummary: summarizePlanStatus(sortedTasks),
        latestAt: group.latestAt,
      };
    })
    .sort((a, b) => b.latestAt - a.latestAt)
    .map(({ latestAt: _latestAt, ...group }) => group);
}

function planIdentityForTask(task: TaskSummary): { id: string; title: string; caption: string; description: string } {
  const goalRef = task.externalRefs.find((ref) => ref.refTitle === "Planning goal");
  const draftRef = task.externalRefs.find((ref) => ref.refTitle === "Planner draft task");
  const jiraRef = task.externalRefs.find((ref) => ref.refTitle === "Jira reference");
  const draftVersion = draftRef?.refValue.match(/^Planner draft v\d+/)?.[0] ?? null;

  if (goalRef) {
    return {
      id: ["planning", goalRef.refValue, draftVersion ?? ""].join(":"),
      title: goalRef.refValue,
      caption: draftVersion ?? "Plan document",
      description: jiraRef ? `Jira reference · ${jiraRef.refValue}` : "Helm Planning에서 승인된 계획",
    };
  }

  if (task.epicId) {
    return {
      id: `epic:${task.epicId}`,
      title: task.epicId,
      caption: "Epic",
      description: "Epic 기준으로 묶인 Task",
    };
  }

  return {
    id: "unplanned",
    title: "계획 연결 없는 Task",
    caption: "No plan",
    description: "Planning goal 참조가 없는 Task",
  };
}

function extractSubtasks(description: string): string[] {
  const section = extractSection(description, "Subtasks", ["Acceptance Criteria", "Risks", "Test Plan"]);
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function extractSection(description: string, startHeading: string, endHeadings: string[]): string {
  const start = description.indexOf(startHeading);
  if (start < 0) return "";
  const bodyStart = start + startHeading.length;
  const end = endHeadings
    .map((heading) => description.indexOf(heading, bodyStart))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return description.slice(bodyStart, end ?? description.length);
}

function taskProgressForPlan(
  task: TaskSummary,
  runs: AgentRunSummary[],
): { label: string; tone: PlanProgressTone } {
  const activeRun = selectVisibleRun(runs);
  const live = activeRun ? deriveRunLiveState(activeRun) : null;

  if (task.status === "Blocked" || (activeRun && isRunAttentionState(activeRun))) {
    return { label: "막힘", tone: "blocked" };
  }
  if (task.status === "MergeWaiting" || task.status === "Merged" || task.status === "Done") {
    return { label: "완료", tone: "done" };
  }
  if (activeRun && isRunActiveState(activeRun)) {
    return { label: live?.state === "approval_pending" ? "승인대기" : "진행중", tone: "active" };
  }
  if (isActiveTaskStatus(task.status)) {
    return { label: "진행중", tone: "active" };
  }
  return { label: "대기", tone: "waiting" };
}

function isActiveTaskStatus(status: TaskStatus): boolean {
  return status === "Coding" || status === "PlanVerification" || status === "CodeReview" || status === "Testing";
}

function countSubtaskProgress(subtasks: PlanSubtask[]): Record<PlanProgressTone, number> & { total: number } {
  return subtasks.reduce(
    (counts, subtask) => {
      counts[subtask.tone] += 1;
      counts.total += 1;
      return counts;
    },
    { waiting: 0, active: 0, done: 0, blocked: 0, total: 0 },
  );
}

function summarizePlanStatus(tasks: TaskSummary[]): string {
  const counts = tasks.reduce(
    (acc, task) => {
      acc[task.status] = (acc[task.status] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<TaskStatus, number>>,
  );
  const mostCommon = Object.entries(counts).sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))[0] as
    | [TaskStatus, number]
    | undefined;
  if (!mostCommon) return "-";
  const [status, count] = mostCommon;
  return count === tasks.length ? TASK_STATUS_LABEL[status] : `${TASK_STATUS_LABEL[status]} ${count}/${tasks.length}`;
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (typeof error === "string") return error;
  return fallback;
}
