import { CheckCircle2, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../lib/api";
import type { CreateTaskInput, ProjectSnapshot, TaskSummary } from "../lib/types";

interface PlanningScreenProps {
  snapshot: ProjectSnapshot | null;
  onOpenProject: () => void;
  onRefresh: () => Promise<void>;
  onOpenTask: (taskId: string) => void;
}

interface PlanningSessionStub {
  id: string;
  title: string;
  status: "Drafting" | "ReadyForApproval" | "Approved" | "Archived";
  updatedLabel: string;
  goalText: string;
  jiraRef: string | null;
  jiraState: "Linked" | "Missing" | "AlreadyTracked";
  messages: PlanningMessage[];
  draft: PlannerDraft;
  revision: number;
  taskId?: string;
  taskIds?: string[];
}

interface PlanningMessage {
  id: string;
  role: "user" | "planner";
  content: string;
  createdLabel: string;
}

interface PlannerDraft {
  title: string;
  summary: string;
  scope: string[];
  tasks: PlannerDraftTask[];
  openQuestions: string[];
  risks: string[];
}

interface PlannerDraftTask {
  title: string;
  description: string;
  subtasks: string[];
  acceptanceCriteria: string[];
  risks: string[];
  testPlan: string[];
}

export function PlanningScreen({ snapshot, onOpenProject, onRefresh, onOpenTask }: PlanningScreenProps) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [plannerRequest, setPlannerRequest] = useState("");
  const [jiraRef, setJiraRef] = useState("");
  const [sessions, setSessions] = useState<PlanningSessionStub[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedSessions = useMemo(() => sessions, [sessions]);

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>계획</h2>
        <p>프로젝트를 열면 planner와 함께 목표를 Task 단위로 나누는 계획 워크스페이스가 준비됩니다.</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          프로젝트 열기
        </button>
      </section>
    );
  }

  const projectSnapshot = snapshot;
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const hasSessions = sessions.length > 0;
  const draftGoal = activeSession?.goalText ?? goal;
  const draftTitle = activeSession?.title ?? titleFromGoal(goal);
  const draftJiraRef = activeSession?.jiraRef ?? jiraRef.trim();
  const draftJiraState = activeSession?.jiraState ?? jiraStateForInput(projectSnapshot, jiraRef);
  const jiraChecks = jiraPlanningChecks(projectSnapshot, draftJiraRef, draftJiraState);
  const draft = activeSession?.draft ?? (goal.trim() ? buildPlannerDraft(goal, null) : null);

  function startNewPlan() {
    setActiveSessionId(null);
    setGoal("");
    setPlannerRequest("");
    setJiraRef("");
    setError(null);
  }

  function startPlannerSession() {
    const trimmed = goal.trim();
    const trimmedJiraRef = jiraRef.trim();
    if (!trimmed || busy) return;

    const existingTask = trimmedJiraRef ? findTaskByJiraRef(projectSnapshot, trimmedJiraRef) : null;
    const jiraState = existingTask ? "AlreadyTracked" : trimmedJiraRef ? "Linked" : "Missing";
    const draft = buildPlannerDraft(trimmed, existingTask?.title ?? null);
    const sessionId = `plan-${Date.now()}`;

    const session: PlanningSessionStub = {
      id: sessionId,
      title: draft.title,
      status: "ReadyForApproval",
      updatedLabel: "방금 전",
      goalText: trimmed,
      jiraRef: trimmedJiraRef || null,
      jiraState,
      messages: [
        {
          id: `${sessionId}-user-1`,
          role: "user",
          content: trimmed,
          createdLabel: "방금 전",
        },
        {
          id: `${sessionId}-planner-1`,
          role: "planner",
          content: plannerOpeningMessage(draft, jiraState),
          createdLabel: "방금 전",
        },
      ],
      draft,
      revision: 1,
      taskId: existingTask?.id,
    };

    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
    setGoal("");
    setPlannerRequest("");
    setError(null);
  }

  function reviseActiveDraft() {
    const trimmed = plannerRequest.trim();
    if (!activeSession || !trimmed || busy) return;

    const revisedDraft = buildPlannerDraft(
      `${activeSession.goalText}\n\nplanner 수정 요청: ${trimmed}`,
      activeSession.taskId ? activeSession.draft.tasks[0]?.title ?? null : null,
    );
    const nextRevision = activeSession.revision + 1;

    setSessions((current) =>
      current.map((item) =>
        item.id === activeSession.id
          ? {
              ...item,
              title: revisedDraft.title,
              status: "ReadyForApproval",
              updatedLabel: "방금 전",
              draft: revisedDraft,
              revision: nextRevision,
              messages: [
                ...item.messages,
                {
                  id: `${item.id}-user-${Date.now()}`,
                  role: "user",
                  content: trimmed,
                  createdLabel: "방금 전",
                },
                {
                  id: `${item.id}-planner-${Date.now()}`,
                  role: "planner",
                  content: plannerRevisionMessage(revisedDraft, nextRevision),
                  createdLabel: "방금 전",
                },
              ],
            }
          : item,
      ),
    );
    setPlannerRequest("");
    setError(null);
  }

  async function approvePlanDraft() {
    if (!activeSession || busy) return;
    if (activeSession.status === "Approved" && activeSession.taskId) {
      onOpenTask(activeSession.taskId);
      return;
    }

    setBusy(true);
    try {
      if (activeSession.taskId && activeSession.jiraState === "AlreadyTracked") {
        setSessions((current) =>
          current.map((item) =>
            item.id === activeSession.id
              ? { ...item, status: "Approved", updatedLabel: "방금 전", taskIds: [activeSession.taskId!] }
              : item,
          ),
        );
        onOpenTask(activeSession.taskId);
        return;
      }

      const createdTasks: TaskSummary[] = [];
      for (const draftTask of activeSession.draft.tasks) {
        const input = createTaskInputFromDraft(activeSession, draftTask);
        const task = await api.createTask(projectSnapshot.project.id, input);
        createdTasks.push(task);
      }

      const firstTask = createdTasks[0];
      if (!firstTask) return;

      setSessions((current) =>
        current.map((item) =>
          item.id === activeSession.id
            ? {
                ...item,
                status: "Approved",
                updatedLabel: "방금 전",
                taskId: firstTask.id,
                taskIds: createdTasks.map((task) => task.id),
              }
            : item,
        ),
      );
      await onRefresh();
      onOpenTask(firstTask.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="planning-layout">
      <div className="planning-body">
        <aside className="planning-aside">
          <div className="planning-aside-section">
            <h3>계획 세션</h3>
            {hasSessions ? (
              <ul className="planning-session-list">
                {sortedSessions.map((session) => {
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
              onClick={startNewPlan}
            >
              + 새 계획
            </button>
          </div>
        </aside>

        <section className="planning-canvas">
          <header className="section-header">
            <div>
              <h2>{activeSession?.title ?? "새 계획"}</h2>
              <p>planner와 대화하면서 계획 문서를 고정하고, 승인한 문서만 Helm Task로 변환합니다.</p>
            </div>
          </header>

          <div className="planning-canvas-body">
            {activeSession ? (
              <div className="planning-thread">
                {activeSession.messages.map((message) => (
                  <article className={`planning-message ${message.role}`} key={message.id}>
                    <div className="planning-message-meta">
                      <strong>{message.role === "planner" ? `Planner · v${activeSession.revision}` : "User"}</strong>
                      <span>{message.createdLabel}</span>
                    </div>
                    <p>{message.content}</p>
                  </article>
                ))}
              </div>
            ) : (
              <div className="planning-empty">
                <h3>planner와 어떤 계획을 세울까요?</h3>
                <p>
                  Codex Desktop에서 계획을 잡듯이 요구사항을 설명하고, planner가 만든 계획 문서를 대화로 다듬은 뒤 승인합니다.
                </p>
              </div>
            )}
          </div>

          <form
            className="planning-goal-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (activeSession) {
                reviseActiveDraft();
              } else {
                startPlannerSession();
              }
            }}
          >
            <textarea
              placeholder={
                activeSession
                  ? "planner에게 메시지: 예) 이 범위는 너무 넓어. 먼저 MVP 기준으로 줄이고 승인 조건을 다시 써줘."
                  : "예: Codex Desktop처럼 대화하면서 계획 문서를 확정하고 Task로 나누고 싶다."
              }
              value={activeSession ? plannerRequest : goal}
              onChange={(event) =>
                activeSession ? setPlannerRequest(event.target.value) : setGoal(event.target.value)
              }
              rows={2}
            />
            {activeSession ? null : (
              <input
                placeholder="Jira Epic, 이슈 키 또는 URL이 이미 있으면 입력"
                value={jiraRef}
                onChange={(event) => setJiraRef(event.target.value)}
              />
            )}
            <div className="planning-goal-actions">
              <span className="planning-goal-hint">
                {activeSession
                  ? "메시지를 보내면 planner가 Plan Document draft를 갱신합니다."
                  : goal.trim()
                    ? jiraChecks.summary
                    : "대화로 계획 문서를 고정하고 승인 후에만 Helm Task를 생성합니다."}
              </span>
              <button type="button" className="secondary-button" disabled>
                repo context 첨부
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={busy || (activeSession ? !plannerRequest.trim() : !goal.trim())}
              >
                <Sparkles size={14} />
                {activeSession ? "planner에게 보내기" : "대화 시작"}
              </button>
            </div>
            {error ? <p className="planning-form-error">{error}</p> : null}
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
            <p className="planning-context-empty">
              {draftJiraRef ? `${jiraStateLabel(draftJiraState)} · ${draftJiraRef}` : "Jira Epic 또는 링크가 있으면 첨부할 수 있습니다."}
            </p>
          </div>

          <div className="planning-context-block">
            <h3>위험</h3>
            {draft ? (
              <ul>
                {draft.risks.map((risk) => (
                  <li key={risk}>
                    <span className="ctx-label">{risk}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="planning-context-empty">planner가 식별한 위험과 검증 방법이 표시됩니다.</p>
            )}
          </div>
        </aside>
      </div>

      <footer className="plan-preview">
        <div className="plan-preview-header">
          <h3>Plan Document</h3>
          <span className="status-pill">
            {activeSession
              ? activeSession.status === "Approved"
                ? "태스크 생성됨"
                : jiraStateLabel(activeSession.jiraState)
              : goal.trim()
                ? "작성 중"
                : "아직 초안 없음"}
          </span>
        </div>
        {draftGoal.trim() && draft ? (
          <div className="plan-preview-draft">
            <div className="plan-document-title">
              <strong>{draftTitle}</strong>
              {activeSession ? <span>Draft v{activeSession.revision}</span> : null}
            </div>
            <p>{draft.summary}</p>
            <div className="plan-preview-task-counts">
              <span>{draft.tasks.length} Tasks</span>
              <span>{draft.tasks.reduce((total, task) => total + task.subtasks.length, 0)} Subtasks</span>
            </div>
            <div className="plan-document-grid">
              <section>
                <h4>Scope</h4>
                <ul>
                  {draft.scope.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
              <section>
                <h4>Open Questions</h4>
                {draft.openQuestions.length > 0 ? (
                  <ul>
                    {draft.openQuestions.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p>현재 blocking question 없음</p>
                )}
              </section>
              <section>
                <h4>Context</h4>
                <ul>
                  {jiraChecks.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
            </div>
            <div className="plan-document-tasks">
              {draft.tasks.map((task, index) => (
                <article className="planner-task-card" key={`${task.title}-${index}`}>
                  <div className="planner-task-card-header">
                    <span>Task {index + 1}</span>
                    <strong>{task.title}</strong>
                  </div>
                  <p>{task.description}</p>
                  <div className="planner-task-grid">
                    <div>
                      <h4>Subtasks</h4>
                      <ul>
                        {task.subtasks.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h4>Acceptance</h4>
                      <ul>
                        {task.acceptanceCriteria.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h4>Test</h4>
                      <ul>
                        {task.testPlan.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            <div className="plan-preview-actions">
              {activeSession?.taskId && activeSession.status === "Approved" ? (
                <span className="status-pill">Task 연결 완료</span>
              ) : null}
              {activeSession ? (
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || activeSession.status === "Approved"}
                  onClick={() => {
                    void approvePlanDraft();
                  }}
                >
                  <CheckCircle2 size={14} />
                  {activeSession.taskId && activeSession.jiraState === "AlreadyTracked"
                    ? "기존 Task 열기"
                    : "승인하고 Task 생성"}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="plan-preview-empty">
            목표를 입력하면 planner와의 대화가 시작되고, 승인 대상 Plan Document가 여기에서 갱신됩니다.
          </p>
        )}
      </footer>
    </div>
  );
}

function buildPlannerDraft(goal: string, linkedTaskTitle: string | null): PlannerDraft {
  const title = titleFromGoal(goal);
  const normalizedGoal = goal.replace(/\s+/g, " ").trim();
  const hasLinkedTask = Boolean(linkedTaskTitle);
  const tasks: PlannerDraftTask[] = hasLinkedTask
    ? [
        {
          title: linkedTaskTitle ?? title,
          description: "이미 연결된 Helm Task를 기준으로 계획 문서를 보강하고 실행 조건을 확인합니다.",
          subtasks: ["기존 Task 설명 확인", "누락된 acceptance criteria 정리", "실행 전 blocker 확인"],
          acceptanceCriteria: ["기존 Task와 Jira 참조가 같은 작업을 가리킨다.", "실행 전 확인해야 할 blocker가 Plan Draft에 남는다."],
          risks: ["기존 Task의 범위가 현재 목표보다 넓거나 좁을 수 있다."],
          testPlan: ["기존 Task external ref와 입력한 Jira 참조가 일치하는지 확인한다."],
        },
      ]
    : [
        {
          title: `${title} 계획 모델 정리`,
          description: "목표를 구현 가능한 범위로 고정하고 화면, 데이터, 승인 경계를 확정합니다.",
          subtasks: ["현재 화면 동작 확인", "필요한 상태와 draft 구조 정의", "승인 전후 경계 정리"],
          acceptanceCriteria: [
            "승인 전에는 Helm Task가 생성되지 않는다.",
            "계획 draft에서 생성될 Task 목록을 확인할 수 있다.",
          ],
          risks: ["계획 대화와 Task 실행 흐름의 책임이 섞일 수 있다."],
          testPlan: ["Planning 탭에서 목표 입력 후 Task가 즉시 생성되지 않는지 확인한다."],
        },
        {
          title: `${title} 화면 흐름 구현`,
          description: "planner 대화, Task breakdown preview, 승인 액션을 Planning 탭에서 연결합니다.",
          subtasks: ["planner 메시지 영역 추가", "Task/Subtask breakdown 카드 추가", "승인 후 Task 생성 액션 연결"],
          acceptanceCriteria: [
            "planner가 제안한 Task와 Subtask가 화면에 표시된다.",
            "사용자는 승인 버튼을 눌러야 Helm Task를 생성할 수 있다.",
          ],
          risks: ["초기 MVP에서는 planning session이 새로고침 후 유지되지 않는다."],
          testPlan: ["목표 입력, 수정 요청, 승인 버튼 상태를 수동으로 확인한다."],
        },
        {
          title: `${title} 검증과 후속 연결`,
          description: "생성된 Task가 기존 Task Detail core loop로 자연스럽게 이어지는지 확인합니다.",
          subtasks: ["생성 Task description 확인", "external ref 저장 확인", "첫 Task Detail 이동 확인"],
          acceptanceCriteria: [
            "승인 후 생성된 첫 Task Detail로 이동한다.",
            "생성된 Task description에 acceptance criteria와 test plan이 포함된다.",
          ],
          risks: ["여러 Task 생성 중 일부만 성공하면 수동 정리가 필요할 수 있다."],
          testPlan: ["데스크톱 앱 build/typecheck를 통과시킨다.", "승인 후 Task 목록이 갱신되는지 확인한다."],
        },
      ];

  return {
    title,
    summary: hasLinkedTask
      ? "planner가 기존 Helm Task를 기준으로 실행 전 계획 확인 항목을 만들었습니다."
      : `planner가 "${normalizedGoal}" 목표를 계획 문서 초안으로 정리하고 ${tasks.length}개의 실행 Task 후보로 나눴습니다.`,
    scope: hasLinkedTask
      ? ["기존 Task 범위 확인", "누락된 승인 조건 보강", "실행 전 blocker 정리"]
      : ["Planning 탭의 대화형 계획 수립", "계획 문서 draft versioning", "승인된 계획의 Task materialize"],
    tasks,
    openQuestions: hasLinkedTask
      ? ["기존 Task 설명이 현재 목표를 충분히 포함하는지 확인이 필요합니다."]
      : ["계획 세션과 draft를 backend DB에 언제 영속화할지 결정해야 합니다."],
    risks: Array.from(new Set(tasks.flatMap((task) => task.risks))),
  };
}

function plannerOpeningMessage(draft: PlannerDraft, jiraState: PlanningSessionStub["jiraState"]): string {
  const jiraNote =
    jiraState === "AlreadyTracked"
      ? "입력한 Jira 참조는 이미 Helm Task와 연결되어 있어 새 Task 생성보다 기존 Task 검토가 먼저입니다."
      : jiraState === "Linked"
        ? "입력한 Jira 참조는 Plan Document의 external reference로 남기겠습니다."
        : "Jira 참조 없이 Helm 내부 계획 문서를 기준으로 진행할 수 있습니다.";

  return [
    "먼저 계획 문서 초안을 만들었습니다.",
    `${draft.tasks.length}개의 Task 후보와 ${draft.tasks.reduce((total, task) => total + task.subtasks.length, 0)}개의 Subtask 후보로 나눴습니다.`,
    jiraNote,
    "범위가 넓거나 순서가 맞지 않으면 메시지로 수정 요청을 보내주세요. 승인 전에는 Helm Task를 만들지 않습니다.",
  ].join(" ");
}

function plannerRevisionMessage(draft: PlannerDraft, revision: number): string {
  return [
    `수정 요청을 반영해 Plan Document v${revision}을 갱신했습니다.`,
    `현재 draft는 ${draft.tasks.length}개의 Task 후보를 포함합니다.`,
    draft.openQuestions.length > 0
      ? `남은 질문: ${draft.openQuestions.join(" ")}`
      : "현재 blocking question은 없습니다.",
    "이 버전을 기준으로 더 다듬거나 승인할 수 있습니다.",
  ].join(" ");
}

function createTaskInputFromDraft(
  session: PlanningSessionStub,
  draftTask: PlannerDraftTask,
): CreateTaskInput {
  return {
    title: draftTask.title,
    description: [
      session.draft.summary,
      "",
      "Planning Goal",
      session.goalText,
      "",
      "Description",
      draftTask.description,
      "",
      "Subtasks",
      ...draftTask.subtasks.map((item) => `- ${item}`),
      "",
      "Acceptance Criteria",
      ...draftTask.acceptanceCriteria.map((item) => `- ${item}`),
      "",
      "Risks",
      ...draftTask.risks.map((item) => `- ${item}`),
      "",
      "Test Plan",
      ...draftTask.testPlan.map((item) => `- ${item}`),
    ].join("\n"),
    externalRefs: [
      ...(session.jiraRef
        ? [
            {
              refType: refTypeForJiraRef(session.jiraRef),
              refValue: session.jiraRef,
              refTitle: "Jira reference",
            } satisfies NonNullable<CreateTaskInput["externalRefs"]>[number],
          ]
        : []),
      {
        refType: "PlainText",
        refValue: session.goalText,
        refTitle: "Planning goal",
      },
      {
        refType: "PlainText",
        refValue: `Planner draft v${session.revision}: ${draftTask.title}`,
        refTitle: "Planner draft task",
      },
    ],
  };
}

function titleFromGoal(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "새 계획";
  return trimmed.length > 42 ? `${trimmed.slice(0, 42)}...` : trimmed;
}

function jiraStateForInput(
  snapshot: ProjectSnapshot,
  value: string,
): PlanningSessionStub["jiraState"] {
  const trimmed = value.trim();
  if (!trimmed) return "Missing";
  return findTaskByJiraRef(snapshot, trimmed) ? "AlreadyTracked" : "Linked";
}

function jiraStateLabel(state: PlanningSessionStub["jiraState"]): string {
  if (state === "AlreadyTracked") return "이미 Helm Task에 연결된 Jira";
  if (state === "Linked") return "기존 Jira 참조 있음";
  return "Jira 없음";
}

function jiraPlanningChecks(
  snapshot: ProjectSnapshot,
  jiraRef: string,
  state: PlanningSessionStub["jiraState"],
): { summary: string; items: string[] } {
  const jiraConfig = snapshot.settings.jiraConfig;
  const jiraEnabled = Boolean(jiraConfig?.enabled);
  const projectKey = jiraConfig?.projectKey?.trim();
  const hasJiraRef = Boolean(jiraRef.trim());
  const hasEpicLikeRef = hasJiraRef && isJiraEpicOrLink(jiraRef);
  const creationState =
    state === "AlreadyTracked"
      ? "기존 Helm Task 연결됨"
      : hasJiraRef
        ? "새 Helm Task 생성 시 링크만 연결"
        : "Jira 생성 필요 여부 미정";

  return {
    summary: state === "AlreadyTracked" ? "기존 Jira가 이미 Helm Task에 연결되어 있습니다." : jiraStateLabel(state),
    items: [
      `Jira 전역 설정: ${jiraEnabled && projectKey ? `${projectKey} 사용` : "미설정"}`,
      `Jira Epic 또는 링크: ${hasJiraRef ? "있음" : "없음"}`,
      `Epic 판별: ${hasEpicLikeRef ? "후보 있음" : "후보 없음"}`,
      `생성 상태: ${creationState}`,
    ],
  };
}

function isJiraEpicOrLink(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /browse\/[A-Z][A-Z0-9]+-\d+/i.test(trimmed) || /^[A-Z][A-Z0-9]+-\d+$/i.test(trimmed);
}

function findTaskByJiraRef(snapshot: ProjectSnapshot, value: string) {
  const normalized = normalizeJiraRef(value);
  if (!normalized) return null;

  return (
    snapshot.tasks.find((task) =>
      task.externalRefs.some((ref) => {
        if (ref.refType !== "JiraEpic" && ref.refType !== "JiraTask" && ref.refType !== "Url") {
          return false;
        }
        return normalizeJiraRef(ref.refValue) === normalized;
      }),
    ) ?? null
  );
}

function refTypeForJiraRef(value: string): NonNullable<CreateTaskInput["externalRefs"]>[number]["refType"] {
  return value.includes("browse/") || value.startsWith("http") ? "Url" : "JiraTask";
}

function normalizeJiraRef(value: string): string {
  const trimmed = value.trim();
  const keyMatch = trimmed.match(/[A-Z][A-Z0-9]+-\d+/i);
  return keyMatch ? keyMatch[0].toUpperCase() : trimmed.toLowerCase();
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (error instanceof Error) return error.message;
  return "알 수 없는 오류가 발생했습니다.";
}
