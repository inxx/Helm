import { CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../components/ToastProvider";
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
  copyChanges: PlannerCopyChange[];
  acceptanceCriteria: string[];
  risks: string[];
  testPlan: string[];
}

interface PlannerCopyChange {
  location: string;
  currentText: string | null;
  proposedText: string;
  reason: string;
}

interface PlannerDraftParseResult {
  draft: PlannerDraft;
  note: string | null;
}

const PLANNER_SOFT_NOTICE_MS = 12_000;
const PLANNER_REFINE_DELAY_MS = 2_000;

export function PlanningScreen({ snapshot, onOpenProject, onRefresh, onOpenTask }: PlanningScreenProps) {
  const { showToast } = useToast();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [plannerRequest, setPlannerRequest] = useState("");
  const [jiraRef, setJiraRef] = useState("");
  const [sessions, setSessions] = useState<PlanningSessionStub[]>([]);
  const [plannerOperation, setPlannerOperation] = useState<"planner" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const sessionsRef = useRef<PlanningSessionStub[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const plannerRefinementTimerRef = useRef<number | null>(null);

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

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => () => cancelPlannerRefinement(), []);

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
  const approvingPlan = plannerOperation === "approve";

  function startNewPlan() {
    cancelPlannerRefinement();
    setActiveSessionId(null);
    setGoal("");
    setPlannerRequest("");
    setJiraRef("");
    setError(null);
  }

  function schedulePlannerRefinement(task: () => void) {
    cancelPlannerRefinement();
    plannerRefinementTimerRef.current = window.setTimeout(() => {
      plannerRefinementTimerRef.current = null;
      window.requestAnimationFrame(() => {
        window.setTimeout(task, 0);
      });
    }, PLANNER_REFINE_DELAY_MS);
  }

  function cancelPlannerRefinement() {
    if (plannerRefinementTimerRef.current === null) return;
    window.clearTimeout(plannerRefinementTimerRef.current);
    plannerRefinementTimerRef.current = null;
  }

  function shouldRunPlannerRefinement(sessionId: string, messageId: string) {
    if (document.visibilityState === "hidden") return false;
    if (activeSessionIdRef.current !== sessionId) return false;
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    if (!session || session.status === "Approved") return false;
    return session.messages.some((message) => message.id === messageId);
  }

  function startPlannerSession() {
    const trimmed = goal.trim();
    const trimmedJiraRef = jiraRef.trim();
    if (!trimmed || approvingPlan) return;

    const existingTask = trimmedJiraRef ? findTaskByJiraRef(projectSnapshot, trimmedJiraRef) : null;
    const jiraState = existingTask ? "AlreadyTracked" : trimmedJiraRef ? "Linked" : "Missing";
    const fallbackDraft = buildPlannerDraft(trimmed, existingTask?.title ?? null);
    const sessionId = `plan-${Date.now()}`;
    const pendingMessageId = `${sessionId}-planner-pending`;
    const session: PlanningSessionStub = {
      id: sessionId,
      title: fallbackDraft.title,
      status: "ReadyForApproval",
      updatedLabel: "빠른 초안",
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
          content: quickPlannerDraftMessage(false),
          createdLabel: "방금 전",
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
    schedulePlannerRefinement(() => {
      void refineInitialPlannerSession(sessionId, pendingMessageId, trimmed, jiraState, fallbackDraft);
    });
  }

  async function refineInitialPlannerSession(
    sessionId: string,
    pendingMessageId: string,
    goalText: string,
    jiraState: PlanningSessionStub["jiraState"],
    fallbackDraft: PlannerDraft,
  ) {
    try {
      if (!shouldRunPlannerRefinement(sessionId, pendingMessageId)) return;
      await waitForNextPaint();
      if (!shouldRunPlannerRefinement(sessionId, pendingMessageId)) return;
      const plannerResult = await runPlannerPlanMode(goalText, goalText, null, fallbackDraft, () => {
        markPlannerStillWorking(
          sessionId,
          pendingMessageId,
          "AI planner가 아직 계획을 다듬는 중입니다. 로컬 초안으로 계속 진행할 수 있고, 응답이 도착하면 이 문서가 갱신됩니다.",
        );
      });
      const draft = plannerResult.draft;
      const responseMessage = plannerResult.message ?? plannerOpeningMessage(draft, jiraState);
      setSessions((current) =>
        current.map((item) =>
          item.id === sessionId
            ? {
                ...item,
                title: item.status === "Approved" ? item.title : draft.title,
                status: item.status === "Approved" ? item.status : "ReadyForApproval",
                updatedLabel: "방금 전",
                draft: item.status === "Approved" ? item.draft : draft,
                messages: item.messages.map((message) =>
                  message.id === pendingMessageId
                    ? {
                        ...message,
                        content:
                          item.status === "Approved"
                            ? "AI planner 응답은 승인 후 도착해서 이미 생성된 Task에는 반영하지 않았습니다."
                            : responseMessage,
                        createdLabel: "방금 전",
                        pending: false,
                      }
                    : message,
                ),
              }
            : item,
        ),
      );
      reportPlannerWarning(plannerResult.warning);
    } catch (err) {
      const message = errorMessage(err);
      setSessions((current) =>
        current.map((item) =>
          item.id === sessionId
            ? {
                ...item,
                messages: item.messages.map((message) =>
                  message.id === pendingMessageId
                    ? {
                        ...message,
                        content: "AI planner 응답이 늦어 로컬 초안을 유지했습니다. 계속 승인하거나 메시지를 보낼 수 있습니다.",
                        createdLabel: "방금 전",
                        pending: false,
                      }
                    : message,
                ),
              }
            : item,
        ),
      );
      setError(message);
      showToast({
        tone: "error",
        title: "planner 실행 실패",
        description: message,
      });
    }
  }

  function reviseActiveDraft() {
    const trimmed = plannerRequest.trim();
    if (!activeSession || !trimmed || approvingPlan) return;

    const submittedAt = Date.now();
    const pendingMessageId = `${activeSession.id}-planner-pending-${submittedAt}`;
    const fallbackDraft = buildPlannerDraft(
      `${activeSession.goalText}\n\nplanner message: ${trimmed}`,
      activeSession.taskId ? activeSession.draft.tasks[0]?.title ?? null : null,
    );
    const nextRevision = activeSession.revision + 1;
    setSessions((current) =>
      current.map((item) =>
        item.id === activeSession.id
          ? {
              ...item,
              title: fallbackDraft.title,
              status: "ReadyForApproval",
              updatedLabel: "빠른 초안",
              draft: fallbackDraft,
              revision: nextRevision,
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
                  content: quickPlannerDraftMessage(true),
                  createdLabel: "방금 전",
                },
              ],
            }
          : item,
      ),
    );
    setPlannerRequest("");
    setError(null);
    schedulePlannerRefinement(() => {
      void refineActivePlannerSession(
        activeSession.id,
        pendingMessageId,
        trimmed,
        activeSession.goalText,
        activeSession.draft,
        fallbackDraft,
        nextRevision,
      );
    });
  }

  async function refineActivePlannerSession(
    sessionId: string,
    pendingMessageId: string,
    message: string,
    goalText: string,
    currentDraft: PlannerDraft,
    fallbackDraft: PlannerDraft,
    nextRevision: number,
  ) {
    try {
      if (!shouldRunPlannerRefinement(sessionId, pendingMessageId)) return;
      await waitForNextPaint();
      if (!shouldRunPlannerRefinement(sessionId, pendingMessageId)) return;
      const plannerResult = await runPlannerPlanMode(
        message,
        goalText,
        currentDraft,
        fallbackDraft,
        () => {
          markPlannerStillWorking(
            sessionId,
            pendingMessageId,
            "AI planner가 아직 수정 요청을 반영하는 중입니다. 현재 로컬 수정안으로 계속 진행할 수 있습니다.",
          );
        },
      );
      const revisedDraft = plannerResult.draft;
      const responseMessage = plannerResult.message ?? plannerRevisionMessage(revisedDraft, nextRevision);

      setSessions((current) =>
        current.map((item) =>
          item.id === sessionId
            ? {
                ...item,
                title: item.status === "Approved" ? item.title : revisedDraft.title,
                status: item.status === "Approved" ? item.status : "ReadyForApproval",
                updatedLabel: "방금 전",
                draft: item.status === "Approved" ? item.draft : revisedDraft,
                revision: item.status === "Approved" ? item.revision : nextRevision,
                messages: item.messages.map((message) =>
                  message.id === pendingMessageId
                    ? {
                        ...message,
                        content:
                          item.status === "Approved"
                            ? "AI planner 응답은 승인 후 도착해서 이미 생성된 Task에는 반영하지 않았습니다."
                            : responseMessage,
                        createdLabel: "방금 전",
                        pending: false,
                      }
                    : message,
                ),
              }
            : item,
        ),
      );
      reportPlannerWarning(plannerResult.warning);
    } catch (err) {
      const message = errorMessage(err);
      setSessions((current) =>
        current.map((item) =>
          item.id === sessionId
            ? {
                ...item,
                messages: item.messages.map((message) =>
                  message.id === pendingMessageId
                    ? {
                        ...message,
                        content: "AI planner 응답이 늦어 로컬 수정안을 유지했습니다. 계속 승인하거나 메시지를 보낼 수 있습니다.",
                        createdLabel: "방금 전",
                        pending: false,
                      }
                    : message,
                ),
              }
            : item,
        ),
      );
      setError(message);
      showToast({
        tone: "error",
        title: "planner 실행 실패",
        description: message,
      });
    }
  }

  function markPlannerStillWorking(sessionId: string, messageId: string, content: string) {
    if (!shouldRunPlannerRefinement(sessionId, messageId)) return;
    setSessions((current) =>
      current.map((item) =>
        item.id === sessionId && item.status !== "Approved"
          ? {
              ...item,
              messages: item.messages.map((message) =>
                message.id === messageId
                  ? {
                      ...message,
                      content,
                      createdLabel: "진행 중",
                      pending: true,
                    }
                  : message,
              ),
            }
          : item,
      ),
    );
  }

  function reportPlannerWarning(warning: string | null) {
    if (!warning) return;
    const fallback = isPlannerFallbackWarning(warning);
    setError(fallback ? null : warning);
    showToast({
      tone: fallback ? "info" : "error",
      title: fallback ? "AI planner 응답 지연" : "planner 실행 확인 필요",
      description: warning,
    });
  }

  async function runPlannerPlanMode(
    message: string,
    goalText: string,
    currentDraft: PlannerDraft | null,
    fallbackDraft: PlannerDraft,
    onSoftTimeout?: () => void,
  ): Promise<{ draft: PlannerDraft; message: string | null; warning: string | null }> {
    try {
      const result = await withPlannerSoftNotice(
        api.runPlannerConversation(projectSnapshot.project.id, {
          message,
          goalText,
          currentDraftJson: currentDraft,
        }),
        onSoftTimeout,
      );
      const parsedDraft = parsePlannerDraft(result.responseText, fallbackDraft);
      const warning = plannerResultWarning(result);
      if (parsedDraft) {
        return {
          draft: parsedDraft.draft,
          message: plannerMessageFromResult(result, parsedDraft.draft, parsedDraft.note),
          warning,
        };
      }
      return {
        draft: fallbackDraft,
        message: plannerFallbackMessage(result, fallbackDraft),
        warning,
      };
    } catch (err) {
      const message = errorMessage(err);
      const fallback = isPlannerFallbackWarning(message);
      return {
        draft: fallbackDraft,
        message: null,
        warning: fallback
          ? "AI planner가 오래 걸려 로컬 초안을 유지했습니다. 현재 초안으로 계속 진행할 수 있고, 응답이 돌아오면 문서를 갱신합니다."
          : `planner 실행 실패: ${message}`,
      };
    }
  }

  async function approvePlanDraft() {
    if (!activeSession || approvingPlan) return;
    cancelPlannerRefinement();
    if (activeSession.status === "Approved" && activeSession.taskId) {
      onOpenTask(activeSession.taskId);
      return;
    }

    setPlannerOperation("approve");
    try {
      if (activeSession.taskId && activeSession.jiraState === "AlreadyTracked") {
        setSessions((current) =>
          current.map((item) =>
            item.id === activeSession.id
              ? { ...item, status: "Approved", updatedLabel: "방금 전", taskIds: [activeSession.taskId!] }
              : item,
          ),
        );
        showToast({
          tone: "info",
          title: "기존 Task 연결",
          description: "이미 추적 중인 Task를 열었습니다.",
        });
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
      let autoStarted = 0;
      const autoStartFailures: string[] = [];
      for (const task of createdTasks) {
        try {
          await api.startNextRoleRun(projectSnapshot.project.id, task.id);
          autoStarted += 1;
        } catch (error) {
          autoStartFailures.push(`${task.title}: ${errorMessage(error)}`);
        }
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
      setError(null);
      showToast({
        tone: autoStartFailures.length > 0 ? "info" : "success",
        title: autoStarted > 0 ? "Task 생성 및 자동 진행 시작" : "Task 생성 완료",
        description:
          autoStarted > 0
            ? `${createdTasks.length}개 Task 중 ${autoStarted}개가 테스트 완료 전까지 자동 진행을 시작했습니다. Merge는 수동입니다.`
            : `${createdTasks.length}개의 Task를 생성했습니다. Runtime readiness를 확인한 뒤 Planner 준비를 시작하세요.`,
      });
      if (autoStartFailures.length > 0) {
        showToast({
          tone: "info",
          title: "일부 자동 진행 대기",
          description: autoStartFailures[0],
        });
      }
      onOpenTask(firstTask.id);
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      showToast({
        tone: "error",
        title: "Plan Document 저장 실패",
        description: message,
      });
    } finally {
      setPlannerOperation(null);
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
                    <article
                      className={`planning-message ${message.role}${message.pending ? " pending" : ""}`}
                      key={message.id}
                    >
                      <div className="planning-message-meta">
                        <strong>{message.role === "planner" ? `Planner · v${activeSession.revision}` : "User"}</strong>
                        <span>{message.createdLabel}</span>
                      </div>
                      <p>{message.content}</p>
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
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (activeSession) {
                    reviseActiveDraft();
                  } else {
                    startPlannerSession();
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
                    ? "빠른 로컬 초안을 즉시 반영하고 AI planner 응답이 도착하면 정교화합니다."
                    : goal.trim()
                      ? jiraChecks.summary
                      : "대화로 계획 문서를 고정하고 승인 후에만 Helm Task를 생성합니다."}
                </span>
                <button
                  type="submit"
                  className="primary-button loading-button"
                  disabled={approvingPlan || (activeSession ? !plannerRequest.trim() : !goal.trim())}
                >
                  <Sparkles size={14} aria-hidden />
                  {activeSession ? "planner에게 보내기" : "대화 시작"}
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
                      {task.copyChanges.length > 0 ? (
                        <div className="planner-copy-changes">
                          <h4>Proposed Copy</h4>
                          {task.copyChanges.map((change) => (
                            <div className="planner-copy-change" key={`${change.location}-${change.proposedText}`}>
                              <span>{change.location}</span>
                              {change.currentText ? (
                                <p>
                                  <strong>현재</strong>
                                  {change.currentText}
                                </p>
                              ) : null}
                              <p>
                                <strong>제안</strong>
                                {change.proposedText}
                              </p>
                              <p>
                                <strong>이유</strong>
                                {change.reason}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : null}
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
                      disabled={approvingPlan || activeSession.status === "Approved"}
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
                        ? "자동 진행 준비 중..."
                        : activeSession.taskId && activeSession.jiraState === "AlreadyTracked"
                        ? "기존 Task 열기"
                        : "승인하고 테스트까지 자동 진행"}
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
  const copyPlan = hasLinkedTask ? null : copyChangePlanFromGoal(normalizedGoal, title);
  const tasks: PlannerDraftTask[] = hasLinkedTask
    ? [
        {
          title: linkedTaskTitle ?? title,
          description: "이미 연결된 Helm Task를 기준으로 계획 문서를 보강하고 실행 조건을 확인합니다.",
          subtasks: ["기존 Task 설명 확인", "누락된 acceptance criteria 정리", "실행 전 blocker 확인"],
          copyChanges: [],
          acceptanceCriteria: ["기존 Task와 Jira 참조가 같은 작업을 가리킨다.", "실행 전 확인해야 할 blocker가 Plan Draft에 남는다."],
          risks: ["기존 Task의 범위가 현재 목표보다 넓거나 좁을 수 있다."],
          testPlan: ["기존 Task external ref와 입력한 Jira 참조가 일치하는지 확인한다."],
        },
      ]
    : copyPlan
      ? [
          {
            title: copyPlan.taskTitle,
            description: copyPlan.description,
            subtasks: copyPlan.subtasks,
            copyChanges: copyPlan.copyChanges,
            acceptanceCriteria: copyPlan.acceptanceCriteria,
            risks: copyPlan.risks,
            testPlan: copyPlan.testPlan,
          },
        ]
    : [
        {
          title: `${title} 계획 모델 정리`,
          description: "목표를 구현 가능한 범위로 고정하고 화면, 데이터, 승인 경계를 확정합니다.",
          subtasks: ["현재 화면 동작 확인", "필요한 상태와 draft 구조 정의", "승인 전후 경계 정리"],
          copyChanges: [],
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
          copyChanges: [],
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
          copyChanges: [],
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
      : copyPlan
        ? copyPlan.summary
      : `planner가 "${normalizedGoal}" 목표를 계획 문서 초안으로 정리하고 ${tasks.length}개의 실행 Task 후보로 나눴습니다.`,
    scope: hasLinkedTask
      ? ["기존 Task 범위 확인", "누락된 승인 조건 보강", "실행 전 blocker 정리"]
      : copyPlan
        ? copyPlan.scope
      : ["Planning 탭의 대화형 계획 수립", "계획 문서 draft versioning", "승인된 계획의 Task materialize"],
    tasks,
    openQuestions: hasLinkedTask
      ? ["기존 Task 설명이 현재 목표를 충분히 포함하는지 확인이 필요합니다."]
      : copyPlan
        ? copyPlan.openQuestions
      : ["계획 세션과 draft를 backend DB에 언제 영속화할지 결정해야 합니다."],
    risks: Array.from(new Set(tasks.flatMap((task) => task.risks))),
  };
}

function copyChangePlanFromGoal(goal: string, title: string): {
  taskTitle: string;
  summary: string;
  description: string;
  scope: string[];
  subtasks: string[];
  copyChanges: PlannerCopyChange[];
  acceptanceCriteria: string[];
  risks: string[];
  testPlan: string[];
  openQuestions: string[];
} | null {
  const normalized = goal.toLowerCase();
  const asksForCopy = /문구|텍스트|copy|empty state|빈 상태/.test(goal);
  if (!asksForCopy) return null;

  if (goal.includes("Task 상세") && goal.includes("실행 기록")) {
    return {
      taskTitle: "Task 상세 실행 기록 빈 상태 문구 수정",
      summary:
        "Task 상세 패널의 실행 기록 빈 상태에서 보일 문구를 더 자연스럽게 바꾸는 UI 텍스트 전용 계획입니다. 레이아웃과 로직은 변경하지 않습니다.",
      description:
        "TaskDetail 실행 기록 섹션에서 runs가 비어 있을 때의 안내 문구만 교체합니다. 승인 전에 변경될 실제 문구 후보를 Plan Document에 고정합니다.",
      scope: [
        "TaskDetail 실행 기록 빈 상태 문구",
        "UI 텍스트만 수정",
        "레이아웃, 상태 전이, 실행 로직 변경 제외",
      ],
      subtasks: [
        "TaskDetail 실행 기록 빈 상태 위치 확인",
        "현재 문구와 제안 문구를 대조해 적용",
        "텍스트 외 diff가 없는지 확인",
      ],
      copyChanges: [
        {
          location: "Task 상세 패널 > 실행 탭 > 실행 기록 empty state",
          currentText: "아직 실행 기록이 없습니다.",
          proposedText: "아직 실행된 기록이 없습니다. 실행을 시작하면 이곳에 진행 상황이 표시됩니다.",
          reason: "빈 상태의 의미와 다음에 무엇이 보일지 함께 알려줘서 덜 딱딱하고 덜 막힌 느낌을 줍니다.",
        },
      ],
      acceptanceCriteria: [
        "실행 기록이 없을 때 제안 문구가 표시된다.",
        "TaskDetail의 레이아웃, 탭 구조, 데이터 로딩, 실행 로직은 바뀌지 않는다.",
        "변경 diff가 UI 텍스트 수정 범위를 벗어나지 않는다.",
      ],
      risks: ["문구가 너무 길면 좁은 상세 패널에서 줄바꿈이 늘어날 수 있다."],
      testPlan: [
        "실행 기록이 없는 Task 상세 패널을 열어 제안 문구가 보이는지 확인한다.",
        "typecheck를 실행해 텍스트 변경 외 타입 오류가 없는지 확인한다.",
      ],
      openQuestions: [],
    };
  }

  if (goal.includes("Task board") || goal.includes("task board") || normalized.includes("kanban")) {
    return {
      taskTitle: "Task board 빈 상태 문구 수정",
      summary: "Task board가 비어 있을 때 보일 안내 문구를 더 명확하게 바꾸는 UI 텍스트 전용 계획입니다.",
      description: "TasksScreen 또는 Task board 빈 상태에서 보이는 안내 문구만 교체합니다.",
      scope: ["Task board empty state 문구", "UI 텍스트만 수정", "동작 로직 변경 제외"],
      subtasks: ["빈 Task board 문구 위치 확인", "현재 문구와 제안 문구를 대조해 적용", "텍스트 외 diff 확인"],
      copyChanges: [
        {
          location: "Task board empty state",
          currentText: null,
          proposedText: "아직 Task가 없습니다. 계획을 승인하면 실행할 Task가 여기에 표시됩니다.",
          reason: "빈 보드가 정상 상태인지, 다음에 무엇을 하면 채워지는지 바로 이해할 수 있게 합니다.",
        },
      ],
      acceptanceCriteria: [
        "Task board가 비어 있을 때 제안 문구가 표시된다.",
        "Task 생성, 상태 전이, 칸반 정렬 로직은 바뀌지 않는다.",
      ],
      risks: ["실제 현재 문구가 다르면 적용 전 파일에서 정확한 원문을 다시 확인해야 한다."],
      testPlan: ["Task가 없는 프로젝트에서 Task board empty state를 확인한다.", "typecheck를 통과시킨다."],
      openQuestions: [],
    };
  }

  return {
    taskTitle: `${title} 문구 수정`,
    summary: "요청한 UI 문구를 구체적인 제안 문구와 함께 고정하는 UI 텍스트 전용 계획입니다.",
    description: "대상 화면의 현재 문구를 확인한 뒤 제안 문구만 적용합니다.",
    scope: ["대상 UI 문구", "텍스트 변경", "동작/레이아웃 변경 제외"],
    subtasks: ["대상 문구 위치 확인", "현재 문구와 제안 문구 확정", "텍스트 외 diff 확인"],
    copyChanges: [
      {
        location: "요청한 UI 위치",
        currentText: null,
        proposedText: "대상 화면의 현재 문맥을 확인한 뒤 더 자연스러운 안내 문구로 교체합니다.",
        reason: "정확한 원문은 구현 단계에서 파일을 확인해 고정합니다.",
      },
    ],
    acceptanceCriteria: ["변경될 문구 후보가 Plan Document에 표시된다.", "UI 텍스트 외 로직과 레이아웃은 바뀌지 않는다."],
    risks: ["현재 문구를 확인하기 전에는 최종 제안 문구가 달라질 수 있다."],
    testPlan: ["대상 화면에서 제안 문구가 보이는지 확인한다.", "typecheck를 통과시킨다."],
    openQuestions: ["현재 문구 원문을 구현 단계에서 확인해야 합니다."],
  };
}

function parsePlannerDraft(raw: string, fallbackDraft: PlannerDraft): PlannerDraftParseResult | null {
  for (const jsonText of extractJsonCandidates(raw)) {
    try {
      const draft = normalizePlannerDraft(JSON.parse(jsonText), fallbackDraft);
      if (draft) return draft;
    } catch {
      continue;
    }
  }
  return null;
}

function normalizePlannerDraft(value: unknown, fallbackDraft: PlannerDraft): PlannerDraftParseResult | null {
  const parsed = plannerDraftCandidate(value);
  if (!parsed) return null;

  const title = stringField(parsed, ["title"]);
  const summary = stringField(parsed, ["summary"]);
  const parsedTasks = plannerTasks(parsed);
  if (!title || !summary) return null;

  const tasks = parsedTasks.length > 0 ? parsedTasks : fallbackDraft.tasks;
  const note =
    parsedTasks.length > 0
      ? null
      : "planner가 Task 후보를 비워 보내서 로컬 Task breakdown을 유지했습니다.";

  const risks = stringArrayField(parsed, ["risks"]);
  const scope = scopeList(parsed.scope);
  return {
    draft: {
      title,
      summary,
      scope: scope.length > 0 ? scope : fallbackDraft.scope,
      tasks,
      openQuestions: stringArrayField(parsed, ["openQuestions", "open_questions"]),
      risks: risks.length > 0 ? risks : Array.from(new Set(tasks.flatMap((task) => task.risks))),
    },
    note,
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
    copyChanges: copyChangesField(value),
    acceptanceCriteria: stringArrayField(value, ["acceptanceCriteria", "acceptance_criteria"]),
    risks: stringArrayField(value, ["risks"]),
    testPlan: stringArrayField(value, ["testPlan", "test_plan"]),
  };
}

function copyChangesField(value: Record<string, unknown>): PlannerCopyChange[] {
  for (const key of ["copyChanges", "copy_changes", "proposedCopy", "proposed_copy"]) {
    const field = value[key];
    if (!Array.isArray(field)) continue;
    const changes = field
      .map((item) => {
        if (!isRecord(item)) return null;
        const proposedText = stringField(item, ["proposedText", "proposed_text", "to", "text"]);
        if (!proposedText) return null;
        return {
          location: stringField(item, ["location", "target", "where"]) ?? "대상 UI 문구",
          currentText: stringField(item, ["currentText", "current_text", "from", "before"]),
          proposedText,
          reason: stringField(item, ["reason", "why"]) ?? "문맥을 더 자연스럽게 전달하기 위해 수정합니다.",
        } satisfies PlannerCopyChange;
      })
      .filter((item): item is PlannerCopyChange => Boolean(item));
    if (changes.length > 0) return changes;
  }
  return [];
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
  if (result.timedOut) {
    return "AI planner가 제한 시간 안에 끝나지 않아 로컬 초안을 유지했습니다. 현재 초안으로 계속 진행하거나 다시 요청할 수 있습니다.";
  }
  if (result.exitCode !== 0) {
    return plannerFailureMessage(result);
  }
  return null;
}

function isPlannerFallbackWarning(message: string): boolean {
  return (
    message.includes("로컬 초안") ||
    message.includes("local draft") ||
    message.includes("제한 시간") ||
    message.includes("응답이 오래 걸려") ||
    message.toLowerCase().includes("timeout")
  );
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

function plannerMessageFromResult(
  result: PlannerConversationResult,
  draft: PlannerDraft,
  note: string | null = null,
): string {
  const mode = result.provider === "claude" ? "native plan mode" : result.provider === "codex" ? "read-only plan mode" : "planning mode";
  const elapsed = formatElapsed(result.elapsedMs);
  return [
    `${result.connectionId} ${mode} 응답을${elapsed ? ` ${elapsed} 후` : ""} Plan Document draft로 반영했습니다.`,
    note,
    `${draft.tasks.length}개의 Task 후보와 ${draft.tasks.reduce((total, task) => total + task.subtasks.length, 0)}개의 Subtask 후보가 있습니다.`,
    draft.openQuestions.length > 0 ? `남은 질문: ${draft.openQuestions.join(" ")}` : "현재 blocking question은 없습니다.",
  ].filter(Boolean).join(" ");
}

function plannerFallbackMessage(result: PlannerConversationResult, fallbackDraft: PlannerDraft): string {
  const mode = result.provider === "claude" ? "native plan mode" : result.provider === "codex" ? "read-only plan mode" : "planning mode";
  const elapsed = formatElapsed(result.elapsedMs);
  const prefix = `${result.connectionId} ${mode} 응답을${elapsed ? ` ${elapsed} 후` : ""} 받았지만 Plan Document schema와 맞지 않아 로컬 초안을 유지했습니다.`;
  const taskSummary = `${fallbackDraft.tasks.length}개의 로컬 Task 후보는 계속 사용할 수 있습니다.`;
  const trimmed = result.responseText.trim();

  if (!trimmed || looksLikeJsonResponse(trimmed)) {
    return `${prefix} ${taskSummary}`;
  }

  return `${prefix} planner 메시지: ${trimmed}`;
}

function looksLikeJsonResponse(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || extractJsonCandidates(trimmed).length > 0;
}

function quickPlannerDraftMessage(revision: boolean): string {
  return revision
    ? "빠른 로컬 갱신안을 채팅과 Plan Document에 반영했습니다. 지금 버전으로 바로 승인하거나 다시 수정할 수 있습니다."
    : "빠른 로컬 초안을 채팅과 Plan Document에 반영했습니다. 지금 버전으로 바로 승인하거나 다시 수정할 수 있습니다.";
}

function formatElapsed(elapsedMs: number | undefined): string | null {
  if (!Number.isFinite(elapsedMs) || !elapsedMs || elapsedMs < 1000) return null;
  return `${(elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)}초`;
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
      ...(draftTask.copyChanges.length > 0
        ? [
            "Proposed Copy",
            ...draftTask.copyChanges.flatMap((change) => [
              `- Location: ${change.location}`,
              ...(change.currentText ? [`  Current: ${change.currentText}`] : []),
              `  Proposed: ${change.proposedText}`,
              `  Reason: ${change.reason}`,
            ]),
            "",
          ]
        : []),
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

function withPlannerSoftNotice<T>(promise: Promise<T>, onSoftTimeout?: () => void): Promise<T> {
  let timeoutId: number | undefined;
  timeoutId = window.setTimeout(() => {
    onSoftTimeout?.();
  }, PLANNER_SOFT_NOTICE_MS);

  return promise.finally(() => {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  });
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
    const message = String((error as { message: unknown }).message);
    const details =
      "details" in error && typeof (error as { details?: unknown }).details === "string"
        ? (error as { details: string }).details.trim()
        : "";
    if (details && !message.includes(details)) return `${message}: ${details}`;
    return message;
  }
  if (error instanceof Error) return error.message;
  return "알 수 없는 오류가 발생했습니다.";
}
