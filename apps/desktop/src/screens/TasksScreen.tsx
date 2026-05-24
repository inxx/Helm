import type { ProjectSnapshot, TaskSummary } from "../lib/types";
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

  return (
    <div className={selectedTask ? "tasks-layout with-detail" : "tasks-layout"}>
      <section className="task-workspace">
        <div className="section-header">
          <div>
            <h2>Agent board</h2>
            <p>계획, 실행, 검토, 테스트, 머지까지 태스크 흐름을 추적합니다.</p>
          </div>
        </div>

        {snapshot.tasks.length === 0 ? (
          <div className="empty-inline">계획에서 승인된 태스크가 아직 없습니다.</div>
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
