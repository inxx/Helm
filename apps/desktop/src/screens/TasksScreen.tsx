import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Search } from "lucide-react";
import type { AgentRunSummary, ProjectSnapshot, TaskSummary } from "../lib/types";
import { AgentUsageBar } from "../components/AgentUsageBar";
import { ApprovalInbox } from "../components/ApprovalInbox";
import { RuntimeReadinessBar } from "../components/RuntimeReadinessBar";
import { TaskBoard } from "../components/TaskBoard";
import { TaskDetail } from "../components/TaskDetail";
import { useToast } from "../components/ToastProvider";
import { api } from "../lib/api";

interface TasksScreenProps {
  snapshot: ProjectSnapshot | null;
  selectedTask: TaskSummary | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onOpenProject: () => void;
  onRefresh: () => Promise<void>;
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
  onGoGit,
  onGoSettings,
}: TasksScreenProps) {
  const { showToast } = useToast();
  const [taskRuns, setTaskRuns] = useState<Record<string, AgentRunSummary[]>>({});
  const [runRefreshKey, setRunRefreshKey] = useState(0);
  const [taskGraphBusy, setTaskGraphBusy] = useState<"export" | "open" | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const taskRunKey = useMemo(
    () => snapshot?.tasks.map((task) => task.id).join(":") ?? "",
    [snapshot?.tasks],
  );
  const filteredTasks = useMemo(() => {
    if (!snapshot) return [];
    const query = historyQuery.trim().toLowerCase();
    if (!query) return snapshot.tasks;
    return snapshot.tasks.filter((task) => taskSearchText(task, taskRuns[task.id] ?? []).includes(query));
  }, [historyQuery, snapshot, taskRuns]);

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

  return (
    <div className={selectedTask ? "tasks-layout with-detail" : "tasks-layout"}>
      <section className="task-workspace">
        <div className="section-header">
          <div>
            <h2>Agent board</h2>
            <p>계획, 실행, 검토, 테스트, 머지까지 태스크 흐름을 추적합니다.</p>
          </div>
          <div className="section-header-actions">
            <button
              className="secondary-button"
              disabled={taskGraphBusy !== null}
              onClick={openTaskGraph}
              type="button"
            >
              {taskGraphBusy === "open" ? "여는 중..." : "tasks.md 열기"}
            </button>
            <button
              className="secondary-button"
              disabled={taskGraphBusy !== null}
              onClick={regenerateTaskGraph}
              type="button"
            >
              {taskGraphBusy === "export" ? "재생성 중..." : "tasks.md 재생성"}
            </button>
          </div>
        </div>

        <RuntimeReadinessBar snapshot={snapshot} onGoSettings={onGoSettings} />

        <div className="task-history-search" role="search">
          <Search size={14} aria-hidden />
          <input
            aria-label="Task history search"
            placeholder="Task, run status, blocker, failure kind 검색"
            value={historyQuery}
            onChange={(event) => setHistoryQuery(event.target.value)}
          />
          {historyQuery.trim() ? <span>{filteredTasks.length}/{snapshot.tasks.length}</span> : null}
        </div>

        {snapshot.tasks.length === 0 ? (
          <div className="empty-inline">계획에서 승인된 태스크가 아직 없습니다.</div>
        ) : filteredTasks.length === 0 ? (
          <div className="empty-inline">검색 결과가 없습니다.</div>
        ) : (
          <TaskBoard
            tasks={filteredTasks}
            taskRuns={taskRuns}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
          />
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

function taskSearchText(task: TaskSummary, runs: AgentRunSummary[]): string {
  const refs = task.externalRefs.map((ref) => `${ref.refType} ${ref.refValue} ${ref.refTitle ?? ""}`).join(" ");
  const runText = runs
    .map((run) =>
      [
        run.roleId,
        run.status,
        run.lifecyclePhase,
        run.failureKind,
        run.failureReason,
        run.resultStatus,
        run.repairRequestId,
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join(" ");
  return [task.title, task.description, task.status, task.statusReason, refs, runText]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (typeof error === "string") return error;
  return fallback;
}
