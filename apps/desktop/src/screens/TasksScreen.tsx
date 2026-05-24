import { useState } from "react";
import { api } from "../lib/api";
import type { CreateTaskInput, ProjectSnapshot, TaskSummary } from "../lib/types";
import { AgentUsageBar } from "../components/AgentUsageBar";
import { ApprovalInbox } from "../components/ApprovalInbox";
import { TaskBoard } from "../components/TaskBoard";
import { TaskDetail } from "../components/TaskDetail";
import { useToast } from "../components/ToastProvider";

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
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
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
    };
    setBusy(true);
    try {
      await api.createTask(snapshot.project.id, input);
      await onRefresh();
      setTitle("");
      setDescription("");
      showToast({
        tone: "success",
        title: "태스크 생성 완료",
        description: "보드에서 선택하면 상세를 볼 수 있습니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "태스크 생성 실패",
        description: messageFromError(error, "태스크를 만들지 못했습니다."),
      });
    } finally {
      setBusy(false);
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
        </div>

        <div className="create-panel">
          <div className="form-grid">
            <input
              placeholder="태스크 제목"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
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

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (typeof error === "string") return error;
  return fallback;
}
