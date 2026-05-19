import { TASK_STATUS_LABEL, TASK_STATUS_ORDER } from "../lib/status";
import type { TaskSummary } from "../lib/types";

interface TaskBoardProps {
  tasks: TaskSummary[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

export function TaskBoard({ tasks, selectedTaskId, onSelectTask }: TaskBoardProps) {
  return (
    <div className="task-board">
      {TASK_STATUS_ORDER.map((status) => {
        const columnTasks = tasks.filter((task) => task.status === status);
        return (
          <section className="task-column" key={status}>
            <header className="task-column-header">
              <span>{TASK_STATUS_LABEL[status]}</span>
              <strong>{columnTasks.length}</strong>
            </header>
            <div className="task-card-list">
              {columnTasks.map((task) => (
                <button
                  className={task.id === selectedTaskId ? "task-card selected" : "task-card"}
                  key={task.id}
                  onClick={() => onSelectTask(task.id)}
                  type="button"
                >
                  <strong>{task.title}</strong>
                  {task.description ? <span>{task.description}</span> : null}
                  {task.externalRefs.length > 0 ? (
                    <small>{task.externalRefs[0].refValue}</small>
                  ) : null}
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
