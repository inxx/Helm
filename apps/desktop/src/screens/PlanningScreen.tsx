import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import type { ProjectSnapshot } from "../lib/types";

interface PlanningScreenProps {
  snapshot: ProjectSnapshot | null;
  onOpenProject: () => void;
}

interface PlanningSessionStub {
  id: string;
  title: string;
  status: "Drafting" | "ReadyForApproval" | "Approved" | "Archived";
  updatedLabel: string;
}

export function PlanningScreen({ snapshot, onOpenProject }: PlanningScreenProps) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [goal, setGoal] = useState("");

  const sessions = useMemo<PlanningSessionStub[]>(() => [], []);

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>계획</h2>
        <p>프로젝트를 열면 AI와 함께 목표를 구체화하는 계획 워크스페이스가 준비됩니다.</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          프로젝트 열기
        </button>
      </section>
    );
  }

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const hasSessions = sessions.length > 0;

  return (
    <div className="planning-layout">
      <div className="planning-body">
        <aside className="planning-aside">
          <div className="planning-aside-section">
            <h3>계획 세션</h3>
            {hasSessions ? (
              <ul className="planning-session-list">
                {sessions.map((session) => {
                  const isActive = session.id === activeSessionId;
                  return (
                    <li key={session.id}>
                      <button
                        type="button"
                        className={isActive ? "planning-session-item active" : "planning-session-item"}
                        onClick={() => setActiveSessionId(session.id)}
                      >
                        <strong>{session.title}</strong>
                        <span>
                          {session.status} · {session.updatedLabel}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="planning-aside-empty">아직 시작한 계획이 없습니다.</p>
            )}
          </div>
          <div className="planning-aside-footer">
            <button
              type="button"
              className="sidebar-add-button"
              onClick={() => setActiveSessionId(null)}
            >
              + 새 계획
            </button>
          </div>
        </aside>

        <section className="planning-canvas">
          <header className="section-header">
            <div>
              <h2>{activeSession?.title ?? "새 계획"}</h2>
              <p>막연한 목표를 입력하면 AI가 Epic·Task 초안을 제안합니다. 승인된 초안만 실제 태스크가 됩니다.</p>
            </div>
          </header>

          <div className="planning-canvas-body">
            {activeSession ? (
              <article className="planning-message">
                <strong>System</strong>
                <p>선택한 세션의 대화가 여기에 표시됩니다.</p>
              </article>
            ) : (
              <div className="planning-empty">
                <h3>무엇을 만들고 싶나요?</h3>
                <p>
                  Helm은 입력한 목표를 곧바로 태스크로 만들지 않습니다. 먼저 AI와 대화하며 Plan Draft를 만들고, 사용자가 승인하면 그제서야 Epic과 Task로 materialize 됩니다.
                </p>
              </div>
            )}
          </div>

          <form
            className="planning-goal-form"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <textarea
              placeholder="예: Conductor처럼 AI와 프로젝트 계획을 세우는 화면을 Helm에 넣고 싶다."
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={2}
            />
            <div className="planning-goal-actions">
              <span className="planning-goal-hint">
                {goal.trim() ? "Enter로 보내거나 버튼으로 시작" : "AI는 사용자 승인 없이 태스크를 만들지 않습니다."}
              </span>
              <button type="button" className="secondary-button" disabled>
                repo context 첨부
              </button>
              <button type="submit" className="primary-button" disabled={!goal.trim()}>
                <Sparkles size={14} />
                계획 초안 시작
              </button>
            </div>
          </form>
        </section>

        <aside className="planning-context">
          <div className="planning-context-block">
            <h3>저장소</h3>
            <ul>
              <li>
                <span className="ctx-label">branch</span>
                <span className="ctx-value">{snapshot.repository.currentBranch ?? "detached"}</span>
              </li>
              <li>
                <span className="ctx-label">staged</span>
                <span className="ctx-value">{snapshot.repository.stagedCount}</span>
              </li>
              <li>
                <span className="ctx-label">unstaged</span>
                <span className="ctx-value">{snapshot.repository.unstagedCount}</span>
              </li>
              <li>
                <span className="ctx-label">untracked</span>
                <span className="ctx-value">{snapshot.repository.untrackedCount}</span>
              </li>
            </ul>
          </div>

          <div className="planning-context-block">
            <h3>기존 태스크</h3>
            {snapshot.tasks.length === 0 ? (
              <p className="planning-context-empty">아직 등록된 태스크가 없습니다.</p>
            ) : (
              <ul>
                {snapshot.tasks.slice(0, 5).map((task) => (
                  <li key={task.id}>
                    <span className="ctx-label">{task.title}</span>
                    <span className="ctx-value">{task.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="planning-context-block">
            <h3>외부 레퍼런스</h3>
            <p className="planning-context-empty">Jira key, URL, 마크다운 사양을 첨부할 수 있습니다.</p>
          </div>

          <div className="planning-context-block">
            <h3>위험</h3>
            <p className="planning-context-empty">AI가 식별한 위험과 검증 방법이 표시됩니다.</p>
          </div>
        </aside>
      </div>

      <footer className="plan-preview">
        <div className="plan-preview-header">
          <h3>Plan Draft</h3>
          <span className="status-pill">아직 초안 없음</span>
        </div>
        <p className="plan-preview-empty">
          목표를 입력하면 Epic · Task · Acceptance Criteria · Risk · Role Plan이 구조화된 미리보기로 표시됩니다.
        </p>
      </footer>
    </div>
  );
}
