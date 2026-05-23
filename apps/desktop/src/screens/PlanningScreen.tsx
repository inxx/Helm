import { CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { CreateTaskInput, PlannerConversationResult, ProjectSnapshot, TaskSummary } from "../lib/types";

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
  pending?: boolean;
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
  const [plannerOperation, setPlannerOperation] = useState<"planner" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const sortedSessions = useMemo(() => sessions, [sessions]);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const latestMessage = activeSession?.messages[activeSession.messages.length - 1] ?? null;
  const latestMessageScrollKey = latestMessage
    ? `${latestMessage.id}:${latestMessage.pending ? "pending" : "ready"}:${latestMessage.content.length}`
    : null;

  useEffect(() => {
    if (!latestMessageScrollKey) return;
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [activeSessionId, latestMessageScrollKey]);

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
  const hasSessions = sessions.length > 0;
  const draftGoal = activeSession?.goalText ?? goal;
  const draftTitle = activeSession?.title ?? titleFromGoal(goal);
  const draftJiraRef = activeSession?.jiraRef ?? jiraRef.trim();
  const draftJiraState = activeSession?.jiraState ?? jiraStateForInput(projectSnapshot, jiraRef);
  const jiraChecks = jiraPlanningChecks(projectSnapshot, draftJiraRef, draftJiraState);
  const draft = activeSession?.draft ?? (goal.trim() ? buildPlannerDraft(goal, null) : null);
  const plannerPending = Boolean(activeSession?.messages.some((message) => message.pending));
  const plannerRunning = plannerOperation === "planner" || plannerPending;
  const approvingPlan = plannerOperation === "approve";

  function startNewPlan() {
    setActiveSessionId(null);
    setGoal("");
    setPlannerRequest("");
    setJiraRef("");
    setError(null);
  }

  async function startPlannerSession() {
    const trimmed = goal.trim();
    const trimmedJiraRef = jiraRef.trim();
    if (!trimmed || busy) return;

    const existingTask = trimmedJiraRef ? findTaskByJiraRef(projectSnapshot, trimmedJiraRef) : null;
    const jiraState = existingTask ? "AlreadyTracked" : trimmedJiraRef ? "Linked" : "Missing";
    const fallbackDraft = buildPlannerDraft(trimmed, existingTask?.title ?? null);
    const sessionId = `plan-${Date.now()}`;
    const pendingMessageId = `${sessionId}-planner-pending`;
    const session: PlanningSessionStub = {
      id: sessionId,
      title: fallbackDraft.title,
      status: "Drafting",
      updatedLabel: "응답 대기",
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
          id: pendingMessageId,
          role: "planner",
          content: "응답 로딩중...",
          createdLabel: "응답 대기",
          pending: true,
        },
      ],
      draft: fallbackDraft,
      revision: 1,
      taskId: existingTask?.id,
    };

    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
    setGoal("");
    setPlannerRequest("");
    setError(null);
    setPlannerOperation("planner");
    setBusy(true);
    try {
      await waitForNextPaint();
      const plannerResult = await runPlannerPlanMode(trimmed, trimmed, null, fallbackDraft);
      const draft = plannerResult.draft;
      setSessions((current) =>
        current.map((item) =>
          item.id === sessionId
            ? {
                ...item,
                title: draft.title,
                status: "ReadyForApproval",
                updatedLabel: "방금 전",
                draft,
                messages: item.messages.map((message) =>
                  message.id === pendingMessageId
                    ? {
                        ...message,
                        content: plannerResult.message ?? plannerOpeningMessage(draft, jiraState),
                        createdLabel: "방금 전",
                        pending: false,
                      }
                    : message,
                ),
              }
            : item,
        ),
      );
      setError(plannerResult.warning ?? null);
    } finally {
      setPlannerOperation(null);
      setBusy(false);
    }
  }

  async function reviseActiveDraft() {
    const trimmed = plannerRequest.trim();
    if (!activeSession || !trimmed || busy) return;

    setPlannerOperation("planner");
    setBusy(true);
    const submittedAt = Date.now();
    const pendingMessageId = `${activeSession.id}-planner-pending-${submittedAt}`;
    setSessions((current) =>
      current.map((item) =>
        item.id === activeSession.id
          ? {
              ...item,
              status: "Drafting",
              updatedLabel: "응답 대기",
              messages: [
                ...item.messages,
                {
                  id: `${item.id}-user-${submittedAt}`,
                  role: "user",
                  content: trimmed,
                  createdLabel: "방금 전",
                },
                {
                  id: pendingMessageId,
                  role: "planner",
                  content: "응답 로딩중...",
                  createdLabel: "응답 대기",
                  pending: true,
                },
              ],
            }
          : item,
      ),
    );
    setPlannerRequest("");
    setError(null);
    try {
      await waitForNextPaint();
      const fallbackDraft = buildPlannerDraft(
        `${activeSession.goalText}\n\nplanner message: ${trimmed}`,
        activeSession.taskId ? activeSession.draft.tasks[0]?.title ?? null : null,
      );
      const plannerResult = await runPlannerPlanMode(
        trimmed,
        activeSession.goalText,
        activeSession.draft,
        fallbackDraft,
      );
      const revisedDraft = plannerResult.draft;
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
                messages: item.messages.map((message) =>
                  message.id === pendingMessageId
                    ? {
                        ...message,
                        content: plannerResult.message ?? plannerRevisionMessage(revisedDraft, nextRevision),
                        createdLabel: "방금 전",
                        pending: false,
                      }
                    : message,
                ),
              }
            : item,
        ),
      );
      setError(plannerResult.warning ?? null);
    } finally {
      setPlannerOperation(null);
      setBusy(false);
    }
  }

  async function runPlannerPlanMode(
    message: string,
    goalText: string,
    currentDraft: PlannerDraft | null,
    fallbackDraft: PlannerDraft,
  ): Promise<{ draft: PlannerDraft; message: string | null; warning: string | null }> {
    try {
      const result = await api.runPlannerConversation(projectSnapshot.project.id, {
        message,
        goalText,
        currentDraftJson: currentDraft,
      });
      const parsedDraft = parsePlannerDraft(result.responseText);
      const warning = plannerResultWarning(result);
      if (parsedDraft) {
        return {
          draft: parsedDraft,
          message: plannerMessageFromResult(result, parsedDraft),
          warning,
        };
      }
      return {
        draft: fallbackDraft,
        message: result.responseText.trim() || null,
        warning: warning ?? "planner 응답을 Plan Document JSON으로 해석하지 못해 local draft를 유지했습니다.",
      };
    } catch (err) {
      return {
        draft: fallbackDraft,
        message: null,
        warning: `planner plan mode 실행 실패: ${errorMessage(err)}`,
      };
    }
  }

  async function approvePlanDraft() {
    if (!activeSession || busy) return;
    if (activeSession.status === "Approved" && activeSession.taskId) {
      onOpenTask(activeSession.taskId);
      return;
    }

    setPlannerOperation("approve");
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
      let autoStartWarning: string | null = null;
      try {
        await api.startNextRoleRun(projectSnapshot.project.id, firstTask.id);
      } catch (err) {
        autoStartWarning = `Task는 생성됐지만 첫 planner 자동 실행을 시작하지 못했습니다: ${errorMessage(err)}`;
      }

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
      setError(autoStartWarning);
      onOpenTask(firstTask.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPlannerOperation(null);
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

        <div className="planning-workspace">
          <section className="planning-canvas" aria-busy={plannerRunning ? true : undefined}>
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
                    <article
                      className={`planning-message ${message.role}${message.pending ? " pending" : ""}`}
                      key={message.id}
                    >
                      <div className="planning-message-meta">
                        <strong>{message.role === "planner" ? `Planner · v${activeSession.revision}` : "User"}</strong>
                        <span>{message.createdLabel}</span>
                      </div>
                      {message.pending ? (
                        <p className="planning-typing" role="status" aria-live="polite">
                          <span className="planning-typing-label">{message.content}</span>
                          <span className="planning-typing-dots" aria-hidden="true">
                            <span>.</span>
                            <span>.</span>
                            <span>.</span>
                          </span>
                        </p>
                      ) : (
                        <p>{message.content}</p>
                      )}
                    </article>
                  ))}
                  <div ref={threadEndRef} />
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
                  void reviseActiveDraft();
                } else {
                  void startPlannerSession();
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
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (activeSession) {
                    void reviseActiveDraft();
                  } else {
                    void startPlannerSession();
                  }
                }}
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
                <button
                  type="submit"
                  aria-busy={plannerRunning ? true : undefined}
                  className={plannerRunning ? "primary-button loading-button is-loading" : "primary-button loading-button"}
                  disabled={busy || (activeSession ? !plannerRequest.trim() : !goal.trim())}
                >
                  {plannerRunning ? (
                    <Loader2 className="loading-icon" size={14} aria-hidden />
                  ) : (
                    <Sparkles size={14} aria-hidden />
                  )}
                  {plannerRunning ? "응답 대기" : activeSession ? "planner에게 보내기" : "대화 시작"}
                </button>
              </div>
              {error ? <p className="planning-form-error">{error}</p> : null}
            </form>
          </section>

          <section className="plan-preview">
            <div className="plan-preview-header">
              <h3>Plan Document</h3>
              <span className="status-pill">
                {activeSession
                  ? plannerRunning
                    ? "초안 갱신 중"
                    : activeSession.status === "Approved"
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
                      aria-busy={approvingPlan ? true : undefined}
                      className={approvingPlan ? "primary-button loading-button is-loading" : "primary-button loading-button"}
                      disabled={busy || activeSession.status === "Approved"}
                      onClick={() => {
                        void approvePlanDraft();
                      }}
                    >
                      {approvingPlan ? (
                        <Loader2 className="loading-icon" size={14} aria-hidden />
                      ) : (
                        <CheckCircle2 size={14} aria-hidden />
                      )}
                      {approvingPlan
                        ? "Task 생성 중..."
                        : activeSession.taskId && activeSession.jiraState === "AlreadyTracked"
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
          </section>
        </div>
      </div>
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

function parsePlannerDraft(raw: string): PlannerDraft | null {
  for (const jsonText of extractJsonCandidates(raw)) {
    try {
      const draft = normalizePlannerDraft(JSON.parse(jsonText));
      if (draft) return draft;
    } catch {
      continue;
    }
  }
  return null;
}

function normalizePlannerDraft(value: unknown): PlannerDraft | null {
  const parsed = plannerDraftCandidate(value);
  if (!parsed) return null;

  const title = stringField(parsed, ["title"]);
  const summary = stringField(parsed, ["summary"]);
  const tasks = plannerTasks(parsed);
  if (!title || !summary || tasks.length === 0) return null;

  const risks = stringArrayField(parsed, ["risks"]);
  return {
    title,
    summary,
    scope: scopeList(parsed.scope),
    tasks,
    openQuestions: stringArrayField(parsed, ["openQuestions", "open_questions"]),
    risks: risks.length > 0 ? risks : Array.from(new Set(tasks.flatMap((task) => task.risks))),
  };
}

function plannerDraftCandidate(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 2 || !isRecord(value)) return null;
  if (looksLikePlannerDraft(value)) return value;

  for (const key of ["planDocument", "plan_document", "planDraft", "plan_draft", "draft", "document"]) {
    const candidate = plannerDraftCandidate(value[key], depth + 1);
    if (candidate) return candidate;
  }

  return null;
}

function looksLikePlannerDraft(value: Record<string, unknown>): boolean {
  return typeof value.title === "string" && typeof value.summary === "string" && (Array.isArray(value.tasks) || Array.isArray(value.epics));
}

function plannerTasks(value: Record<string, unknown>): PlannerDraftTask[] {
  const directTasks = Array.isArray(value.tasks)
    ? value.tasks.map(normalizePlannerTask).filter((task): task is PlannerDraftTask => Boolean(task))
    : [];
  if (directTasks.length > 0) return directTasks;

  if (!Array.isArray(value.epics)) return [];
  return value.epics.flatMap((epic) => {
    if (!isRecord(epic) || !Array.isArray(epic.tasks)) return [];
    return epic.tasks.map((task) => normalizePlannerTask(task)).filter((task): task is PlannerDraftTask => Boolean(task));
  });
}

function extractJsonCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const candidates: string[] = [];
  const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenced: RegExpExecArray | null;
  while ((fenced = fencedPattern.exec(trimmed))) {
    if (fenced[1]?.trim()) candidates.push(fenced[1].trim());
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.push(trimmed);
  for (let index = trimmed.indexOf("{"); index >= 0; index = trimmed.indexOf("{", index + 1)) {
    const candidate = balancedJsonObject(trimmed, index);
    if (candidate) candidates.push(candidate);
  }

  return Array.from(new Set(candidates));
}

function balancedJsonObject(value: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }

  return null;
}

function normalizePlannerTask(value: unknown): PlannerDraftTask | null {
  if (!isRecord(value)) return null;
  const title = stringField(value, ["title"]);
  if (!title) return null;
  return {
    title,
    description: stringField(value, ["description"]) ?? "planner가 제안한 실행 Task입니다.",
    subtasks: stringArrayField(value, ["subtasks", "subTasks", "sub_tasks"]),
    acceptanceCriteria: stringArrayField(value, ["acceptanceCriteria", "acceptance_criteria"]),
    risks: stringArrayField(value, ["risks"]),
    testPlan: stringArrayField(value, ["testPlan", "test_plan"]),
  };
}

function stringField(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  return null;
}

function stringArrayField(value: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const items = stringList(value[key]);
    if (items.length > 0) return items;
  }
  return [];
}

function scopeList(value: unknown): string[] {
  const directScope = stringList(value);
  if (directScope.length > 0 || !isRecord(value)) return directScope;

  return [
    ...stringList(value.in).map((item) => `포함: ${item}`),
    ...stringList(value.out).map((item) => `제외: ${item}`),
  ];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plannerResultWarning(result: PlannerConversationResult): string | null {
  if (result.timedOut) return "planner plan mode가 timeout 되어 local draft를 유지했습니다.";
  if (result.exitCode !== 0) {
    return plannerFailureMessage(result);
  }
  return null;
}

function plannerFailureMessage(result: PlannerConversationResult): string {
  const rawMessage = result.stderr.trim() || result.responseText.trim();
  const normalized = rawMessage.toLowerCase();

  if (result.provider === "claude" && normalized.includes("not logged in")) {
    return "Claude CLI는 설치되어 있지만 로그인 상태가 아니어서 planner를 실행하지 못했습니다. 터미널에서 claude를 열고 /login을 실행한 뒤 다시 확인하세요.";
  }

  if (result.provider === "claude" && normalized.includes("organization does not have access")) {
    return "Claude CLI는 설치되어 있지만 현재 로그인된 조직에 Claude Code 접근 권한이 없어 planner를 실행하지 못했습니다. 설정에서 Codex를 planner로 선택하거나 Claude 계정/조직 권한을 확인하세요.";
  }

  return rawMessage || `planner plan mode가 exit code ${result.exitCode}로 종료되었습니다.`;
}

function plannerMessageFromResult(result: PlannerConversationResult, draft: PlannerDraft): string {
  const mode = result.provider === "claude" ? "native plan mode" : result.provider === "codex" ? "read-only plan mode" : "planning mode";
  return [
    `${result.connectionId} ${mode} 응답을 Plan Document draft로 반영했습니다.`,
    `${draft.tasks.length}개의 Task 후보와 ${draft.tasks.reduce((total, task) => total + task.subtasks.length, 0)}개의 Subtask 후보가 있습니다.`,
    draft.openQuestions.length > 0 ? `남은 질문: ${draft.openQuestions.join(" ")}` : "현재 blocking question은 없습니다.",
  ].join(" ");
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

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  if (error instanceof Error) return error.message;
  return "알 수 없는 오류가 발생했습니다.";
}
