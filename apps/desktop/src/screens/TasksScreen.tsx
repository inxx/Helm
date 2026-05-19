import { useState } from "react";
import { api } from "../lib/api";
import type { CreateTaskInput, ProjectSnapshot, TaskSummary } from "../lib/types";
import { AgentUsageBar } from "../components/AgentUsageBar";
import { ApprovalInbox } from "../components/ApprovalInbox";
import { TaskBoard } from "../components/TaskBoard";
import { TaskDetail } from "../components/TaskDetail";

interface TasksScreenProps {
  snapshot: ProjectSnapshot | null;
  selectedTask: TaskSummary | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onOpenProject: () => void;
  onRefresh: () => Promise<void>;
  onGoGit: () => void;
}

export function TasksScreen({
  snapshot,
  selectedTask,
  selectedTaskId,
  onSelectTask,
  onOpenProject,
  onRefresh,
  onGoGit,
}: TasksScreenProps) {
  const [mode, setMode] = useState<"new" | "jira">("new");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [busy, setBusy] = useState(false);

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

  async function createTask() {
    if (!snapshot) return;
    const input: CreateTaskInput = {
      title,
      description,
      externalRefs:
        mode === "jira" && externalRef.trim()
          ? [
              {
                refType: externalRef.includes("browse/") || externalRef.startsWith("http")
                  ? "Url"
                  : "JiraTask",
                refValue: externalRef,
              },
            ]
          : [],
    };
    setBusy(true);
    const task = await api.createTask(snapshot.project.id, input);
    await onRefresh();
    onSelectTask((task as TaskSummary).id);
    setTitle("");
    setDescription("");
    setExternalRef("");
    setBusy(false);
  }

  return (
    <div className="tasks-layout">
      <section className="task-workspace">
        <div className="section-header">
          <div>
            <h2>Agent board</h2>
            <p>계획, 실행, 검토, 테스트, 머지까지 태스크 흐름을 추적합니다.</p>
          </div>
        </div>

        <div className="create-panel">
          <div className="segmented">
            <button className={mode === "new" ? "active" : ""} onClick={() => setMode("new")} type="button">
              새 태스크
            </button>
            <button className={mode === "jira" ? "active" : ""} onClick={() => setMode("jira")} type="button">
              Jira에서 시작
            </button>
          </div>
          <div className="form-grid">
            <input
              placeholder="태스크 제목"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            {mode === "jira" ? (
              <input
                placeholder="Jira key 또는 URL"
                value={externalRef}
                onChange={(event) => setExternalRef(event.target.value)}
              />
            ) : null}
            <input
              placeholder="설명, 기대 결과, acceptance"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <button disabled={busy || !title.trim()} onClick={createTask} type="button">
              만들기
            </button>
          </div>
        </div>

        {snapshot.tasks.length === 0 ? (
          <div className="empty-inline">아직 태스크가 없습니다.</div>
        ) : (
          <TaskBoard
            tasks={snapshot.tasks}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
          />
        )}
        <AgentUsageBar snapshot={snapshot} />
        <ApprovalInbox snapshot={snapshot} onRefresh={onRefresh} />
      </section>
      <TaskDetail
        snapshot={snapshot}
        task={selectedTask}
        onRefresh={onRefresh}
        onGoGit={onGoGit}
      />
    </div>
  );
}
