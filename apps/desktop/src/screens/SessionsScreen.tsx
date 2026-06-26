import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Check, FileText, Folder, Loader2, MessageSquare, MoreHorizontal, Pencil, Plus, Send, Square, Trash2, User, X } from "lucide-react";
import { collapseSessionsByTask, groupSessionsByEpic } from "../lib/agentSessions";
import { api } from "../lib/api";
import { useI18n, type AppLanguage } from "../lib/i18n";
import { shortenPath, type RecentProject } from "../lib/recents";
import { roleLabel } from "../lib/runnerReadiness";
import { dedupePlanTasks, parseOrchestratorReply, parsePlanTasks, stripPlanJson, type OrchestratorReply, type PlanTask } from "../lib/planParse";
import { parseApprovalDecision } from "../lib/approvalIntent";
import type {
  AgentSessionSummary,
  ApprovalSummary,
  GitFileStatus,
  ProjectSnapshot,
  RoleAssignment,
  RunEventSummary,
  TaskSummary,
  TerminalPtySummary,
  AiConnection,
} from "../lib/types";

interface SessionsScreenProps {
  snapshot: ProjectSnapshot | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onOpenProject: () => void;
  recents: RecentProject[];
  activeProjectId: string | null;
  onSwitchProject: (projectId: string) => void;
  onForgetProject: (projectId: string) => void;
  busy: boolean;
  onGoTerminal: () => void;
  onGoSettings: () => void;
  onRefresh: () => Promise<void>;
}

export function SessionsScreen({
  snapshot,
  selectedTaskId,
  onSelectTask,
  onOpenProject,
  recents,
  activeProjectId,
  onSwitchProject,
  onForgetProject,
  busy,
  onGoTerminal,
  onRefresh,
}: SessionsScreenProps) {
  const { language, t } = useI18n();
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [terminalPtys, setTerminalPtys] = useState<TerminalPtySummary[]>([]);
  const [changedFiles, setChangedFiles] = useState<GitFileStatus[]>([]);
  const [orchestratorInput, setOrchestratorInput] = useState("");
  const [orchestratorBusy, setOrchestratorBusy] = useState(false);
  // 진행 중인 단계가 요구사항 명확화(orchestrator)인지, 계획자 실행(planner)인지. busy 라벨만 구분한다.
  const [busyPhase, setBusyPhase] = useState<"orchestrator" | "planner">("orchestrator");
  // 새 작업을 현재 체크아웃된 브랜치에서 in-place로 할지, 새 워크트리에서 할지.
  const [worktreeMode, setWorktreeMode] = useState<"current_branch" | "worktree">("current_branch");
  // 계획자가 쪼갠 테스크를 어느 Epic("작업") 아래에 쌓을지. 같은 작업의 후속 지시는 같은 Epic에
  // 계속 누적하고, "새 작업"(+)을 누르면 null로 비워 다음 계획부터 새 Epic을 만든다. 프로젝트를
  // 열 때 가장 최근 Epic으로 초기화해 재시작 후에도 후속 작업이 이어진다.
  const [currentEpicId, setCurrentEpicId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [deletingSession, setDeletingSession] = useState(false);
  // 프로젝트 안에서 막힌(NeedsInspection/Failed) 작업들의 알림. 채팅이 task 선택과 무관한
  // 단일 스레드이므로 선택된 task 하나가 아니라 프로젝트 전체 기준으로 모은다.
  const [runAlerts, setRunAlerts] = useState<Array<{ taskId: string; taskTitle: string; roleId: string; failureKind: string | null; failureReason: string | null; at: string | null }>>([]);
  const [orchestratorMessages, setOrchestratorMessages] = useState<Array<{ id: string; role: "user" | "assistant"; content: string; sourceRunId?: string | null }>>([]);
  // 이미 스레드에 적은 작업자 run 요약(source_run_id)을 기억해 3초 폴링마다 중복으로 덧붙이지 않는다.
  // 프로젝트를 바꿀 때만 비운다.
  const persistedRunIdsRef = useRef<Set<string>>(new Set());
  const [pendingOrchestratorRequirement, setPendingOrchestratorRequirement] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingStageAi, setSavingStageAi] = useState(false);
  const [editingStageAi, setEditingStageAi] = useState(false);
  const [draftRoleAssignments, setDraftRoleAssignments] = useState<RoleAssignment[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const [stoppingTerminalId, setStoppingTerminalId] = useState<string | null>(null);
  const [mergeApproving, setMergeApproving] = useState(false);
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [composingNewSession, setComposingNewSession] = useState(false);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatScrollFrameRef = useRef<number | null>(null);
  const pinnedToBottomRef = useRef(true);
  // 대화는 프로젝트 단위 append-only 스레드다. 오케스트레이터 질문/확정 → 계획자 → 작업자 요약이
  // 모두 한 스레드에 누적되며, 세션을 바꿔도 초기화하지 않는다. 프로젝트를 열 때 DB에서 불러오고
  // 프로젝트가 바뀔 때만 in-flight 턴/pending 상태를 정리한다.
  useEffect(() => {
    setOrchestratorBusy(false);
    setPendingOrchestratorRequirement(null);
    persistedRunIdsRef.current = new Set();
    if (!snapshot) {
      setOrchestratorMessages([]);
      setCurrentEpicId(null);
      return;
    }
    // 가장 최근 Epic을 "현재 작업"으로 잡아, 재시작 후에도 후속 지시가 같은 Epic에 쌓이게 한다.
    const latestEpic = [...snapshot.epics].sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt))[0];
    setCurrentEpicId(latestEpic?.id ?? null);
    let disposed = false;
    void api
      .listConversationMessages(snapshot.project.id)
      .then((messages) => {
        if (disposed) return;
        for (const message of messages) {
          if (message.sourceRunId) persistedRunIdsRef.current.add(message.sourceRunId);
        }
        setOrchestratorMessages(
          messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            sourceRunId: message.sourceRunId,
          })),
        );
      })
      .catch(() => {
        if (!disposed) setOrchestratorMessages([]);
      });
    return () => {
      disposed = true;
    };
  }, [snapshot?.project.id]);

  // 채팅 버블을 로컬 상태에 추가하면서 DB에도 append한다(프로젝트 단위 영속). sourceRunId가 있으면
  // 작업자 run 요약으로, 백엔드가 멱등 처리한다.
  function appendMessage(role: "user" | "assistant", content: string, sourceRunId: string | null = null) {
    if (!content) return;
    setOrchestratorMessages((items) => [...items, { id: crypto.randomUUID(), role, content, sourceRunId }]);
    if (snapshot) {
      void api.appendConversationMessage(snapshot.project.id, role, content, sourceRunId).catch(() => undefined);
    }
  }

  const taskById = useMemo(
    () => new Map(snapshot?.tasks.map((task) => [task.id, task]) ?? []),
    [snapshot?.tasks],
  );
  const epicById = useMemo(
    () => new Map(snapshot?.epics.map((epic) => [epic.id, epic]) ?? []),
    [snapshot?.epics],
  );
  const activeSession = useMemo(() => {
    if (composingNewSession) return null;
    if (sessions.length === 0) return null;
    if (activeSessionId) {
      const exact = sessions.find((session) => session.id === activeSessionId);
      if (exact) return exact;
    }
    if (selectedTaskId) {
      const taskSession = sessions.find((session) => session.taskId === selectedTaskId);
      if (taskSession) return taskSession;
    }
    return sessions[0];
  }, [activeSessionId, composingNewSession, selectedTaskId, sessions]);
  const selectedTask = selectedTaskId ? taskById.get(selectedTaskId) ?? null : null;
  const activeTask = activeSession?.taskId ? taskById.get(activeSession.taskId) ?? selectedTask : selectedTask;
  // 채팅이 프로젝트 단위 단일 스레드이므로 승인/머지/진행 표시는 선택된 task 하나가 아니라
  // 프로젝트 전체의 대기 항목을 기준으로 모은다(작업자 진행은 스레드에 요약만 누적된다).
  const projectPendingApprovals =
    snapshot?.approvals.filter((approval) => approval.status === "Pending") ?? [];
  const mergeWaitingTasks = snapshot?.tasks.filter((task) => task.status === "MergeWaiting") ?? [];
  const workingSession = sessions.find((session) => isSessionWorking(session)) ?? null;
  // Orchestrator turn is in flight but no visible assistant text yet.
  const lastOrchestratorMessage = orchestratorMessages.at(-1);
  const hasVisibleAssistantReply =
    lastOrchestratorMessage?.role === "assistant" && stripPlanJson(lastOrchestratorMessage.content).length > 0;
  const orchestratorPending = orchestratorBusy && !hasVisibleAssistantReply;

  useEffect(() => {
    if (!snapshot) {
      setSessions([]);
      setActiveSessionId(null);
      setEditingStageAi(false);
      setDraftRoleAssignments(null);
      return;
    }
    let disposed = false;
    setLoading(true);
    setLoadError(null);
    void Promise.all([
      api.listAgentSessions(snapshot.project.id, 200),
      api.listTerminalPtys(snapshot.project.id).catch(() => []),
    ])
      .then(([items, ptys]) => {
        if (disposed) return;
        const mergedItems = mergeTaskBackedSessions(items, snapshot.tasks);
        setSessions((prev) => keepIfEqual(prev, mergedItems));
        setTerminalPtys(ptys);
        if (composingNewSession) return;
        if (selectedTaskId) {
          setActiveSessionId(mergedItems.find((session) => session.taskId === selectedTaskId)?.id ?? mergedItems[0]?.id ?? null);
        } else {
          setActiveSessionId((current) => (current && mergedItems.some((session) => session.id === current) ? current : mergedItems[0]?.id ?? null));
        }
      })
      .catch((error) => {
        if (!disposed) setLoadError(messageFromError(error, language === "ko" ? "세션 목록을 불러오지 못했습니다." : "Failed to load sessions."));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [snapshot?.project.id, snapshot?.tasks, composingNewSession, selectedTaskId, reloadKey]);

  useEffect(() => {
    if (!snapshot) {
      setChangedFiles([]);
      return;
    }
    let disposed = false;
    const loadFiles = activeTask
      ? api.getTaskWorktreeChangedFiles(snapshot.project.id, activeTask.id)
      : api.getChangedFiles(snapshot.project.id);
    void loadFiles
      .then((files) => {
        if (!disposed) setChangedFiles(files);
      })
      .catch(() => {
        if (!disposed) setChangedFiles([]);
      });
    return () => {
      disposed = true;
    };
  }, [activeTask?.id, snapshot?.project.id, reloadKey]);

  useEffect(() => {
    setEditingStageAi(false);
    setDraftRoleAssignments(null);
  }, [snapshot?.project.id]);

  // 세션을 바꾸면 항상 최신(맨 아래)으로 점프하고 bottom 고정 상태로 되돌린다.
  useEffect(() => {
    pinnedToBottomRef.current = true;
    scrollChatToBottom();
  }, [activeSession?.id, activeTask?.id]);

  // 폴링으로 메시지/요약/승인 카드가 늘어나도 항상 맨 아래로 따라간다. 단, 사용자가
  // 위로 스크롤해 둔 상태면 방해하지 않는다. 개수 기반 deps는 내용이 in-place로 자라는
  // 폴링 업데이트를 놓치므로 scroll 컨테이너의 DOM 변경을 직접 관찰한다.
  useEffect(() => {
    const node = chatScrollRef.current;
    if (!node) return;
    const onScroll = () => {
      pinnedToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    const observer = new MutationObserver(() => {
      if (pinnedToBottomRef.current) scrollChatToBottom();
    });
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [activeSession?.id, activeTask?.id]);

  useEffect(() => {
    return () => {
      if (chatScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(chatScrollFrameRef.current);
      }
    };
  }, []);

  // 작업자 run 요약은 프로젝트 단위 단일 스레드에 누적한다. 채팅이 task 선택과 무관하므로
  // 선택된 task 하나가 아니라 진행 중인 모든 task의 완료 run 요약을 끌어온다. 이미 끝난(Merged/Done)
  // task의 요약은 프로젝트를 열 때 conversation_messages에서 한 번 로드되므로 다시 폴링하지 않는다.
  // ponytail: 진행 중 task만 폴링. 완료 직전 마지막 요약은 직전 폴링에서 이미 잡혀 들어간다.
  useEffect(() => {
    if (!snapshot) {
      setRunAlerts([]);
      return;
    }
    const projectId = snapshot.project.id;
    const activeTasks = snapshot.tasks.filter((task) => task.status !== "Merged" && task.status !== "Done");
    if (activeTasks.length === 0) {
      setRunAlerts((prev) => keepIfEqual(prev, []));
      return;
    }
    let disposed = false;
    void Promise.all(
      activeTasks.map(async (task) => {
        const runs = await api.listAgentRuns(projectId, task.id).catch(() => []);
        const ordered = [...runs].sort((a, b) => timestampValue(a.createdAt) - timestampValue(b.createdAt));
        const summaries = await Promise.all(
          ordered.map(async (run) => ({
            runId: run.id,
            roleId: run.roleId,
            text: (await api.readRunArtifact(projectId, run.id, "summary.md").catch(() => null))?.trim() ?? "",
          })),
        );
        return { task, latest: ordered.at(-1), summaries: summaries.filter((entry) => entry.text) };
      }),
    )
      .then((perTask) => {
        if (disposed) return;
        // 완료된 작업자 run 요약을 스레드에 누적. source_run_id로 멱등 — 같은 run은 폴링이 반복돼도
        // 한 번만 적힌다(메모리 ref + 백엔드 UNIQUE 이중 가드).
        for (const { summaries } of perTask) {
          for (const summary of summaries) {
            if (persistedRunIdsRef.current.has(summary.runId)) continue;
            persistedRunIdsRef.current.add(summary.runId);
            appendMessage(
              "assistant",
              `**${roleLabel(summary.roleId, language)} · ${t("sessions.summaryTitle")}**\n\n${summary.text}`,
              summary.runId,
            );
          }
        }
        // 막힌(NeedsInspection/Failed) task는 조용히 멈춘다(예: coder가 보고한 변경이 worktree diff에 없음).
        // 프로젝트 전체에서 모아 스레드 하단에 노출한다.
        const nextAlerts = perTask
          .filter((entry) => entry.latest && (entry.latest.status === "NeedsInspection" || entry.latest.status === "Failed"))
          .map((entry) => ({
            taskId: entry.task.id,
            taskTitle: entry.task.title,
            roleId: entry.latest!.roleId,
            failureKind: entry.latest!.failureKind,
            failureReason: entry.latest!.failureReason,
            at: entry.latest!.finishedAt ?? entry.latest!.updatedAt,
          }));
        setRunAlerts((prev) => keepIfEqual(prev, nextAlerts));
      })
      .catch(() => {
        if (!disposed) setRunAlerts((prev) => keepIfEqual(prev, []));
      });
    return () => {
      disposed = true;
    };
  }, [snapshot?.project.id, snapshot?.tasks, activityRefreshKey]);

  // 채팅이 프로젝트 단위 단일 스레드라, 선택된 task 하나가 아니라 프로젝트의 모든 run 신호에
  // 반응해 요약/알림 폴링(activityRefreshKey)을 깨운다. 진행 중인 task가 하나라도 있으면 승인
  // 대기처럼 "working" run이 없는 구간을 위해 백업 폴링도 둔다. keepIfEqual이 동일 폴링을 무비용으로 만든다.
  const hasActiveTask = (snapshot?.tasks ?? []).some((task) => task.status !== "Merged" && task.status !== "Done");
  useEffect(() => {
    if (!snapshot) return;
    const projectId = snapshot.project.id;
    let disposed = false;
    const bump = () => {
      if (disposed) return;
      setActivityRefreshKey((value) => value + 1);
      setReloadKey((value) => value + 1);
    };
    const matchesProject = (payload: { projectId?: string }) => payload.projectId === projectId;

    let cleanupEvent: (() => void) | null = null;
    let cleanupUpdated: (() => void) | null = null;
    void listen<RunEventSummary>("agent-run://event", (event) => {
      if (!disposed && matchesProject(event.payload)) bump();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanupEvent = unlisten;
    });
    void listen<{ projectId?: string; taskId?: string; runId?: string }>("agent-run://updated", (event) => {
      if (!disposed && matchesProject(event.payload)) bump();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanupUpdated = unlisten;
    });

    const timer = hasActiveTask ? window.setInterval(bump, 3_000) : null;

    return () => {
      disposed = true;
      cleanupEvent?.();
      cleanupUpdated?.();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [snapshot?.project.id, hasActiveTask]);

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>{t("sessions.emptyProject.title")}</h2>
        <p>{t("sessions.emptyProject.description")}</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          {t("sessions.openProject")}
        </button>
      </section>
    );
  }

  async function submitOrchestratorInstruction() {
    const goalText = orchestratorInput.trim();
    if (!snapshot || !goalText || orchestratorBusy) return;
    setLoadError(null);
    setOrchestratorInput("");
    const priorMessages = orchestratorMessages;
    appendMessage("user", goalText);

    // 승인 대기가 있으면 채팅 입력을 승인/반려 결정으로 먼저 해석한다 (버튼 대신 대화로 결정).
    const decision = parseApprovalDecision(goalText);
    if (decision && projectPendingApprovals.length > 0) {
      await decideApprovalFromChat(projectPendingApprovals[0], decision.decision, decision.reason);
      return;
    }

    // 오케스트레이터가 요구사항 확정(ready)을 마치고 사용자 확인을 기다리는 중 + 사용자가 "확인"
    // → 정리된 요구사항을 그대로 계획자에게 넘긴다.
    if (pendingOrchestratorRequirement && isConfirmationMessage(goalText)) {
      await handOffToPlanner(pendingOrchestratorRequirement);
      return;
    }

    // 그 외 모든 입력 → 오케스트레이터(요구사항 명확화 AI)에게 보내 질문/정리를 받는다.
    setPendingOrchestratorRequirement(null);
    setBusyPhase("orchestrator");
    setOrchestratorBusy(true);
    try {
      const history = [...priorMessages, { role: "user" as const, content: goalText }].map((m) => ({ role: m.role, content: m.content }));
      const originalGoal = priorMessages.find((m) => m.role === "user")?.content ?? goalText;
      const result = await api.runOrchestratorConversation(snapshot.project.id, {
        goalText: originalGoal,
        history,
      });
      if (result.timedOut || result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || result.responseText.trim() || (language === "ko" ? "요구사항 정리 응답을 받지 못했습니다." : "The orchestrator did not return a usable response."));
      }
      const parsed = parseOrchestratorReply(result.responseText);
      if (!parsed) {
        // JSON 파싱 실패 → 원문을 보여주고 대화를 이어간다.
        appendMessage(
          "assistant",
          stripPlanJson(result.responseText.trim()) || (language === "ko" ? "응답을 이해하지 못했습니다. 다시 설명해 주세요." : "Could not parse the response. Please rephrase."),
        );
        return;
      }
      if (parsed.ready) {
        setPendingOrchestratorRequirement(parsed.requirement);
      }
      appendMessage("assistant", orchestratorReplyText(parsed, language));
    } catch (error) {
      setLoadError(messageFromError(error, language === "ko" ? "오케스트레이터에 지시를 전달하지 못했습니다." : "Failed to send the instruction to the orchestrator."));
    } finally {
      setOrchestratorBusy(false);
    }
  }

  async function handOffToPlanner(requirement: string) {
    if (!snapshot) return;
    setPendingOrchestratorRequirement(null);
    setBusyPhase("planner");
    setOrchestratorBusy(true);
    try {
      const result = await api.runPlannerConversation(snapshot.project.id, {
        message: requirement,
        goalText: requirement,
        currentDraftJson: null,
      });
      if (result.timedOut || result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || result.responseText.trim() || (language === "ko" ? "AI 계획 응답을 받지 못했습니다." : "The AI planner did not return a usable response."));
      }
      const reply = result.responseText.trim();
      appendMessage("assistant", stripPlanJson(reply) || (language === "ko" ? "계획을 받았습니다." : "Received a plan."));
      await maybeMaterializeTasks(reply, requirement);
    } catch (error) {
      setLoadError(messageFromError(error, language === "ko" ? "오케스트레이터에 지시를 전달하지 못했습니다." : "Failed to send the instruction to the orchestrator."));
    } finally {
      setOrchestratorBusy(false);
    }
  }

  async function decideApprovalFromChat(
    approval: ApprovalSummary,
    decision: "approve" | "reject",
    reason: string,
  ) {
    if (!snapshot) return;
    const decisionReason = reason.trim() || (decision === "approve" ? "확인 완료" : "반려");
    setOrchestratorBusy(true);
    try {
      if (decision === "approve") {
        await api.approveApproval(snapshot.project.id, approval.id, decisionReason);
        // ApprovalInbox.decide와 동일한 후속 실행 — 빠지면 승인 후 파이프라인이 멈춘다.
        if (approval.approvalType === "PlanApproval" && approval.entityType === "Task") {
          await api.startNextRoleRun(snapshot.project.id, approval.entityId).catch(() => undefined);
        } else if (approval.approvalType === "RunApproval" && approval.entityType === "AgentRun") {
          await api.runHostRole(snapshot.project.id, approval.entityId).catch(() => undefined);
        }
      } else {
        await api.rejectApproval(snapshot.project.id, approval.id, decisionReason);
      }
      await onRefresh();
      setReloadKey((value) => value + 1);
      appendMessage(
        "assistant",
        decision === "approve"
          ? `${approvalLabel(approval.approvalType, language)} 승인을 반영했습니다.`
          : `${approvalLabel(approval.approvalType, language)} 반려를 반영했습니다.`,
      );
    } catch (error) {
      setLoadError(messageFromError(error, language === "ko" ? "승인 상태를 변경하지 못했습니다." : "Failed to update the approval."));
    } finally {
      setOrchestratorBusy(false);
    }
  }

  async function cancelOrchestratorTurn() {
    setOrchestratorBusy(false);
  }

  // Every planner reply is parsed for tasks[] JSON. If found, confirm once, then materialize
  // each into a Helm task that the existing role-pipeline engine runs.
  async function maybeMaterializeTasks(turnText: string, goalText: string) {
    if (!snapshot) return;
    const tasks = parsePlanTasks(turnText);
    if (!tasks) return;
    // The planner re-runs statelessly on each follow-up and re-proposes tasks it already emitted,
    // which is the "세션이 계속 생긴다" pile-up. Drop tasks whose title already exists in the project
    // (and any in-batch repeats) before creating anything.
    const freshTasks = dedupePlanTasks(tasks, snapshot.tasks.map((task) => task.title));
    const skippedDupes = tasks.length - freshTasks.length;
    if (freshTasks.length === 0) {
      appendMessage(
        "assistant",
        language === "ko"
          ? `이미 만든 작업과 모두 중복이라 새로 만들지 않았습니다 (${skippedDupes}개 건너뜀).`
          : `All ${skippedDupes} proposed task(s) already exist, so nothing new was created.`,
      );
      return;
    }
    // 사용자는 이미 채팅에서 "확인"으로 요구사항을 승인했다(handOffToPlanner 진입 조건).
    // 여기서 다시 window.confirm을 띄우면 같은 결정을 두 번 묻는 셈이라 제거한다 — 단일 승인 게이트.
    const projectId = snapshot.project.id;
    // 같은 작업의 후속 지시는 같은 Epic 아래로 계속 쌓는다: 현재 작업 중인 Epic(currentEpicId)이
    // 아직 존재하면 재사용하고, 없거나 "새 작업"으로 비워졌으면 새 Epic을 만든다. Epic 생성이
    // 실패하면 묶지 않고(epicId=null) 진행한다.
    let epicId: string | null =
      currentEpicId && snapshot.epics.some((epic) => epic.id === currentEpicId) ? currentEpicId : null;
    if (!epicId) {
      try {
        epicId = (await api.createEpic(projectId, deriveEpicTitle(goalText, freshTasks))).id;
        setCurrentEpicId(epicId);
      } catch {
        /* group-less fallback */
      }
    }
    const created: string[] = [];
    const startFailed: string[] = [];
    for (const task of freshTasks) {
      try {
        const description = [task.description, task.role ? `(role: ${task.role})` : null].filter(Boolean).join("\n\n") || task.title;
        const newTask = await api.createTask(projectId, {
          epicId,
          title: task.title.slice(0, 120),
          description,
          externalRefs: [{ refType: "PlainText", refValue: task.description ?? task.title, refTitle: language === "ko" ? "AI 계획 작업" : "AI-planned task" }],
          worktreeMode,
        });
        try {
          await api.startNextRoleRun(projectId, newTask.id);
        } catch (error) {
          // 첫 역할(planner) kickoff은 한 번만 호출되고 reconcile 안전망은 Planned을 건너뛰므로,
          // 여기서 실패를 삼키면 태스크가 영구히 "다음 역할 실행 준비 중"에 멈춘다. 반드시 표면화한다.
          startFailed.push(`${newTask.title}: ${messageFromError(error, language === "ko" ? "역할 실행 시작 실패" : "failed to start the run")}`);
        }
        created.push(newTask.title);
      } catch {
        /* skip a task that failed to create */
      }
    }
    if (startFailed.length) {
      setLoadError(language === "ko" ? `일부 작업의 실행을 시작하지 못했습니다:\n- ${startFailed.join("\n- ")}` : `Failed to start some tasks:\n- ${startFailed.join("\n- ")}`);
    }
    appendMessage(
      "assistant",
      (created.length
        ? (language === "ko" ? `${created.length}개 작업을 만들었습니다:\n- ${created.join("\n- ")}` : `Created ${created.length} task(s):\n- ${created.join("\n- ")}`)
        : (language === "ko" ? "작업 생성에 실패했습니다." : "Failed to create tasks."))
        + (startFailed.length
          ? (language === "ko" ? `\n\n⚠️ 실행을 시작하지 못한 작업:\n- ${startFailed.join("\n- ")}` : `\n\n⚠️ Failed to start:\n- ${startFailed.join("\n- ")}`)
          : "")
        + (skippedDupes
          ? (language === "ko" ? `\n\n(중복 ${skippedDupes}개는 건너뜀)` : `\n\n(skipped ${skippedDupes} duplicate(s))`)
          : ""),
    );
    setOrchestratorBusy(false);
    await onRefresh();
    setReloadKey((value) => value + 1);
  }

  // Delete the active work session: removes the task and (via the backend command) its runs,
  // events, evidence, approvals, plus the on-disk git worktree and local branch. Clearing
  // activeSessionId below also resets the orchestrator chat bubbles via the effect above.
  async function deleteSession(task: TaskSummary) {
    if (!snapshot || deletingSession) return;
    const proceed = window.confirm(
      language === "ko"
        ? `"${task.title}" 작업 세션을 삭제할까요?\n연결된 run/event/근거와 git worktree·로컬 브랜치까지 함께 삭제됩니다.`
        : `Delete the work session "${task.title}"?\nThis also removes its runs/events/evidence and the git worktree and local branch.`,
    );
    if (!proceed) return;
    setDeletingSession(true);
    setLoadError(null);
    try {
      await api.deleteTask(snapshot.project.id, task.id);
      setActiveSessionId(null);
      await onRefresh();
      setReloadKey((value) => value + 1);
    } catch (error) {
      setLoadError(messageFromError(error, language === "ko" ? "세션을 삭제하지 못했습니다." : "Failed to delete the session."));
    } finally {
      setDeletingSession(false);
    }
  }

  // Manual merge gate: tasks auto-run through the tester, then stop at MergeWaiting. The user
  // approves the merge here, which commits + pushes the worktree branch (same backend command the
  // Tasks view uses).
  async function approveMerge(task: TaskSummary) {
    if (!snapshot || mergeApproving) return;
    const proceed = window.confirm(
      language === "ko"
        ? `"${task.title}" 작업을 머지 승인할까요?\nworktree 변경사항을 커밋하고 origin에 push합니다.`
        : `Approve merge for "${task.title}"?\nThis commits the worktree changes and pushes to origin.`,
    );
    if (!proceed) return;
    setMergeApproving(true);
    setLoadError(null);
    try {
      await api.approveTaskCompletionWithGit(snapshot.project.id, task.id);
      await onRefresh();
      setReloadKey((value) => value + 1);
    } catch (error) {
      setLoadError(messageFromError(error, language === "ko" ? "머지 승인에 실패했습니다." : "Failed to approve the merge."));
    } finally {
      setMergeApproving(false);
    }
  }

  // Merge-gate "request changes": attach the feedback as a task instruction, reopen the task at
  // the coder stage, and re-run. Auto-handoff replays coder → … → MergeWaiting with the feedback
  // visible in the runner's context pack. Reuses existing commands — no dedicated backend path.
  async function requestChanges(task: TaskSummary, feedback: string) {
    if (!snapshot || requestingChanges) return;
    const trimmed = feedback.trim();
    if (!trimmed) return;
    setRequestingChanges(true);
    setLoadError(null);
    try {
      await api.appendTaskInstruction(snapshot.project.id, task.id, trimmed);
      await api.updateTaskStatus(snapshot.project.id, task.id, "Ready", language === "ko" ? "머지 전 수정 요청으로 재작업" : "Reopened for pre-merge changes");
      await api.startNextRoleRun(snapshot.project.id, task.id);
      await onRefresh();
      setReloadKey((value) => value + 1);
    } catch (error) {
      setLoadError(messageFromError(error, language === "ko" ? "수정 요청에 실패했습니다." : "Failed to request changes."));
    } finally {
      setRequestingChanges(false);
    }
  }

  function beginStageAiEdit() {
    if (!snapshot) return;
    setDraftRoleAssignments(cloneRoleAssignments(snapshot.settings.roleAssignments));
    setEditingStageAi(true);
    setLoadError(null);
  }

  function cancelStageAiEdit() {
    setDraftRoleAssignments(null);
    setEditingStageAi(false);
    setLoadError(null);
  }

  async function saveStageAiEdit() {
    const projectId = snapshot?.project.id;
    if (!projectId || savingStageAi || !draftRoleAssignments) return;
    setSavingStageAi(true);
    setLoadError(null);
    try {
      await api.updateProjectSettings(projectId, { roleAssignments: draftRoleAssignments });
      await onRefresh();
      setDraftRoleAssignments(null);
      setEditingStageAi(false);
    } catch (error) {
      setLoadError(messageFromError(error, language === "ko" ? "단계별 AI 설정을 저장하지 못했습니다." : "Failed to save stage AI settings."));
    } finally {
      setSavingStageAi(false);
    }
  }

  function updateRoleConnection(roleId: RoleAssignment["roleId"], connectionId: string) {
    if (!snapshot || savingStageAi) return;
    const connection = snapshot.settings.aiConnections.find((item) => item.id === connectionId);
    setDraftRoleAssignments((current) => (current ?? cloneRoleAssignments(snapshot.settings.roleAssignments)).map((assignment) => {
      if (assignment.roleId !== roleId) return assignment;
      const selections = connection
        ? [{ connectionId: connection.id, model: connection.defaultModel ?? null, effort: null }]
        : [];
      return {
        ...assignment,
        selections,
        connectionIds: selections.map((selection) => selection.connectionId),
      };
    }));
  }

  function updateRoleModel(roleId: RoleAssignment["roleId"], model: string) {
    if (!snapshot || savingStageAi) return;
    setDraftRoleAssignments((current) => (current ?? cloneRoleAssignments(snapshot.settings.roleAssignments)).map((assignment) => {
      if (assignment.roleId !== roleId) return assignment;
      const selection = assignment.selections[0];
      if (!selection) return assignment;
      return {
        ...assignment,
        selections: [{ ...selection, model: model.trim() ? model.trim() : null }],
      };
    }));
  }

  async function stopTerminal(terminalId: string) {
    setStoppingTerminalId(terminalId);
    setLoadError(null);
    try {
      await api.stopTerminalPty(terminalId);
      setTerminalPtys((items) => items.filter((item) => item.terminalId !== terminalId));
    } catch (error) {
      setLoadError(messageFromError(error, language === "ko" ? "터미널 종료에 실패했습니다." : "Failed to stop the terminal."));
    } finally {
      setStoppingTerminalId((current) => (current === terminalId ? null : current));
    }
  }

  function startNewSession() {
    setComposingNewSession(true);
    setActiveSessionId(null);
    onSelectTask(null);
    // "새 작업" → 다음 계획자 산출물은 기존 Epic이 아니라 새 Epic 아래로 묶는다.
    setCurrentEpicId(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function renderSessionRow(session: AgentSessionSummary) {
    const active = session.taskId
      ? session.taskId === activeSession?.taskId
      : session.id === activeSession?.id;
    return (
      <button
        className={active ? "session-row active" : "session-row"}
        key={session.id}
        onClick={() => {
          setComposingNewSession(false);
          setActiveSessionId(session.id);
          onSelectTask(session.taskId);
        }}
        type="button"
      >
        <span className={`session-status-dot ${session.nextAction}`} />
        <span className="session-row-main">
          <strong>{session.title}</strong>
          <small>{session.provider ?? t("sessions.providerUnknown")} · {formatRelative(session.lastSignalAt, language)}</small>
        </span>
      </button>
    );
  }

  function scrollChatToBottom() {
    if (chatScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(chatScrollFrameRef.current);
    }
    chatScrollFrameRef.current = window.requestAnimationFrame(() => {
      chatScrollFrameRef.current = null;
      const scrollNode = chatScrollRef.current;
      if (!scrollNode) return;
      scrollNode.scrollTop = scrollNode.scrollHeight;
    });
  }

  return (
    <div className="sessions-layout">
      <aside className="sessions-rail" aria-label={t("sessions.listAria")}>
        <div className="sessions-project-header">
          <Folder size={18} aria-hidden />
          <h2>{t("sessions.projects")}</h2>
        </div>
        {loadError ? <div className="error-banner compact">{loadError}</div> : null}
        <div className="session-list">
          {recents.map((project) => {
            const activeProject = project.id === activeProjectId;
            const disabled = busy && !activeProject;
            return (
              <div className="session-project-group" key={project.id}>
                <div className={activeProject ? "session-project-row active" : "session-project-row"}>
                  <button
                    className="session-project-main"
                    disabled={disabled}
                    onClick={() => {
                      if (!activeProject) {
                        setComposingNewSession(false);
                        void onSwitchProject(project.id);
                      }
                    }}
                    title={project.rootPath}
                    type="button"
                  >
                    <span className="session-row-main">
                      <strong>{project.name}</strong>
                      <small>{shortenPath(project.rootPath)}</small>
                    </span>
                  </button>
                  {activeProject ? (
                    <button
                      aria-label={`${project.name} ${t("sessions.addSession")}`}
                      className="session-project-action"
                      onClick={startNewSession}
                      title={t("sessions.addSession")}
                      type="button"
                    >
                      <Plus size={14} aria-hidden />
                    </button>
                  ) : null}
                  <div className="session-project-menu-wrap">
                    <button
                      aria-label={`${project.name} ${t("sessions.projectMenu")}`}
                      className="session-project-action"
                      onClick={() => setOpenProjectMenuId((current) => (current === project.id ? null : project.id))}
                      title={t("sessions.projectMenu")}
                      type="button"
                    >
                      <MoreHorizontal size={15} aria-hidden />
                    </button>
                    {openProjectMenuId === project.id ? (
                      <div className="session-project-menu">
                        <button
                          onClick={() => {
                            setOpenProjectMenuId(null);
                            onForgetProject(project.id);
                          }}
                          type="button"
                        >
                          <Trash2 size={13} aria-hidden />
                          <span>{t("sessions.deleteProject")}</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
                {activeProject ? (
                  <div className="session-project-sessions">
                    {sessions.length === 0 ? (
                      <div className="session-list-empty">
                        <MessageSquare size={16} />
                        <span>{t("sessions.noSessions")}</span>
                      </div>
                    ) : null}
                    {groupSessionsByEpic(
                      collapseSessionsByTask(sessions),
                      (taskId) => taskById.get(taskId)?.epicId ?? null,
                      (id) => epicById.get(id)?.title ?? null,
                    ).map((group) => {
                      if (!group.epicId) return renderSessionRow(group.sessions[0]);
                      const groupActive = group.sessions.some((session) =>
                        session.taskId ? session.taskId === activeSession?.taskId : session.id === activeSession?.id,
                      );
                      return (
                        <details className="session-epic-group" key={group.epicId} open={groupActive || undefined}>
                          <summary className="session-epic-summary">
                            <span className="session-epic-title">{group.epicTitle ?? t("sessions.epicUntitled")}</span>
                            <span className="session-epic-count">{group.sessions.length}</span>
                          </summary>
                          <div className="session-epic-children">
                            {group.sessions.map((session) => renderSessionRow(session))}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <button className="sidebar-add-project sessions-add-project" disabled={loading} onClick={onOpenProject} type="button">
          <Plus size={14} aria-hidden />
          <span>{t("sessions.addProject")}</span>
        </button>
      </aside>

      <section className="session-chat" aria-label={t("sessions.chatAria")}>
        {/* 가운데는 프로젝트 단위 오케스트레이터 스레드 하나로 고정한다. 사이드바에서 task를 골라도
            여기 대화는 바뀌지 않고(우측 패널 컨텍스트만 갱신), 작업자 진행은 스레드에 요약으로만 쌓인다. */}
        <header className="session-chat-header">
          <div>
            <h1>{snapshot.project.name}</h1>
            <p>{t("sessions.assistantTitle")}</p>
          </div>
        </header>
        {orchestratorMessages.length === 0 && !orchestratorPending ? (
          <div className="session-chat-empty">
            <MessageSquare size={20} />
            <h2>{t("sessions.emptyChat.title")}</h2>
            <p>{t("sessions.emptyChat.description")}</p>
          </div>
        ) : (
          <div className="session-chat-scroll" ref={chatScrollRef}>
            <SessionMessage role="assistant" icon="bot" title={t("sessions.assistantTitle")} timestamp={null} language={language}>
              <p>{t("sessions.introMessage")}</p>
            </SessionMessage>
            {orchestratorMessages.map((message) => {
              const text = message.role === "assistant" ? stripPlanJson(message.content) : message.content;
              if (!text) return null;
              return (
                <SessionMessage
                  icon={message.role === "user" ? "user" : "bot"}
                  key={message.id}
                  role={message.role}
                  timestamp={null}
                  title={message.role === "user" ? t("sessions.requestTitle") : t("sessions.assistantTitle")}
                  language={language}
                >
                  {message.role === "assistant" ? (
                    <div className="session-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                    </div>
                  ) : (
                    <p>{text}</p>
                  )}
                </SessionMessage>
              );
            })}
            {orchestratorPending ? <OrchestratorPending language={language} phase={busyPhase} /> : null}
            {/* 진행/막힘/머지/승인 카드는 항상 스레드 맨 아래(입력창 바로 위)에 둔다 — 자동 스크롤이
                맨 아래로 따라가므로 위쪽에 두면 사용자가 보지 못하고 지나친다. */}
            {workingSession ? (
              <SessionMessage icon="bot" role="assistant" timestamp={workingSession.lastSignalAt ?? null} title={language === "ko" ? "진행 중" : "Working"} language={language}>
                <SessionWorkingIndicator language={language} session={workingSession} />
              </SessionMessage>
            ) : null}
            {runAlerts.map((alert) => (
              <SessionMessage
                key={alert.taskId}
                icon="bot"
                role="tool"
                timestamp={alert.at}
                title={`${language === "ko" ? "막힘 · 점검 필요" : "Blocked · needs inspection"} — ${alert.taskTitle}`}
                language={language}
              >
                <p>{blockReasonCopy(alert.failureKind, alert.failureReason, language)}</p>
                {alert.failureKind === "diff_mismatch" ? (
                  <p>
                    {language === "ko"
                      ? "에이전트가 보고한 변경 파일이 worktree의 실제 git diff에 없습니다. coder를 재실행하거나 Git 화면에서 worktree 변경사항을 직접 확인하세요."
                      : "The agent's reported changes are not in the worktree's actual git diff. Re-run the coder, or inspect the worktree in the Git view."}
                  </p>
                ) : null}
              </SessionMessage>
            ))}
            {mergeWaitingTasks.map((task) => (
              <MergeApprovalCard
                key={task.id}
                task={task}
                language={language}
                busy={mergeApproving || requestingChanges}
                approving={mergeApproving}
                requesting={requestingChanges}
                onApprove={() => void approveMerge(task)}
                onRequestChanges={(feedback) => void requestChanges(task, feedback)}
              />
            ))}
            {projectPendingApprovals.map((approval) => (
              <SessionMessage key={approval.id} role="assistant" icon="bot" title={t("sessions.approvalTitle")} timestamp={null} language={language}>
                <p>
                  <strong>{approvalLabel(approval.approvalType, language)}</strong>
                  {approval.requestedReason ? ` — ${approval.requestedReason}` : ""}
                </p>
                <p>
                  {language === "ko"
                    ? '아래 입력창에 "승인" 또는 "반려"를 입력하세요. 뒤에 결정 사유를 덧붙일 수 있습니다.'
                    : 'Type "approve" or "reject" in the box below. You can add a reason after it.'}
                </p>
              </SessionMessage>
            ))}
          </div>
        )}
        <form
          className="session-orchestrator-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submitOrchestratorInstruction();
          }}
        >
          <textarea
            ref={composerRef}
            disabled={orchestratorBusy}
            onChange={(event) => setOrchestratorInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void submitOrchestratorInstruction();
            }}
            placeholder={t("sessions.composerPlaceholder")}
            rows={2}
            value={orchestratorInput}
          />
          <div className="composer-buttons">
            <label
              className="composer-worktree-toggle"
              title={
                language === "ko"
                  ? "체크 시 새 작업마다 워크트리를 만듭니다. 해제 시 현재 체크아웃된 브랜치에서 작업합니다(보호 브랜치면 새 브랜치 생성)."
                  : "Checked: create a worktree per task. Unchecked: work in the current branch (a new branch is created on protected branches)."
              }
            >
              <input
                type="checkbox"
                checked={worktreeMode === "worktree"}
                disabled={orchestratorBusy}
                onChange={(event) =>
                  setWorktreeMode(event.target.checked ? "worktree" : "current_branch")
                }
              />
              <span>{language === "ko" ? "새 워크트리" : "New worktree"}</span>
            </label>
            {orchestratorBusy ? (
              <button className="primary-button loading-button" onClick={() => void cancelOrchestratorTurn()} type="button">
                <Square size={14} aria-hidden />
                <span>{t("sessions.stop")}</span>
              </button>
            ) : (
              <button className="primary-button loading-button" disabled={!orchestratorInput.trim()} type="submit">
                <Send size={14} aria-hidden />
                <span>{t("sessions.send")}</span>
              </button>
            )}
          </div>
        </form>
      </section>

      <aside className="session-context-panel" aria-label={language === "ko" ? "환경" : "Environment"}>
        <div className="session-context-header">
          <h3>Environment</h3>
          {activeTask ? (
            <button
              type="button"
              className="secondary-button session-delete-button"
              onClick={() => void deleteSession(activeTask)}
              disabled={deletingSession}
            >
              {deletingSession
                ? language === "ko"
                  ? "삭제 중…"
                  : "Deleting…"
                : language === "ko"
                  ? "테스크 삭제"
                  : "Delete task"}
            </button>
          ) : null}
        </div>
        <ContextRow className="full-value" label="Branch" value={activeSession?.branch ?? snapshot.repository.currentBranch ?? "-"} />
        <ContextRow className="full-value" label="Worktree" value={activeSession?.worktreePath ?? "-"} />
        <ContextRow label="Changed files" value={changedFileCountLabel(changedFiles, activeSession)} />
        <ContextRow label="Events" value={activeSession?.eventCount?.toString() ?? "0"} />
        <ContextRow
          className="path-value"
          label="Obsidian"
          value={snapshot.settings.obsidianVaultPath ?? (language === "ko" ? "미설정" : "Not set")}
          displayValue={compactHomePath(snapshot.settings.obsidianVaultPath)}
        />
        <div className="session-context-section">
          <div className="session-context-section-title">
            <span>Changes</span>
            <strong>{changedFiles.length}</strong>
          </div>
          {changedFiles.length > 0 ? (
            <div className="session-context-list">
              {changedFiles.slice(0, 6).map((file) => (
                <div className="session-context-file-row" key={`${file.status}:${file.path}`}>
                  <span>{file.status}</span>
                  <strong title={file.path}>{file.path}</strong>
                </div>
              ))}
              {changedFiles.length > 6 ? (
                <p className="session-context-empty">
                  {language === "ko" ? `외 ${changedFiles.length - 6}개 파일` : `${changedFiles.length - 6} more files`}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="session-context-empty">{language === "ko" ? "Git 변경 파일 없음" : "No Git changes"}</p>
          )}
        </div>
        <div className="session-context-section">
          <div className="session-context-section-title">
            <span>Current AI</span>
            <strong>{activeSession ? currentAiLabel(activeSession, language) : "-"}</strong>
          </div>
          <div className="session-context-section-title">
            <span>Local servers</span>
            <strong>{terminalPtys.filter((pty) => pty.running).length}</strong>
          </div>
          {terminalPtys.length > 0 ? (
            <div className="session-context-list">
              {terminalPtys.slice(0, 4).map((pty) => (
                <div className="session-context-list-row session-terminal-row" key={pty.terminalId}>
                  <button
                    className="session-terminal-open"
                    onClick={onGoTerminal}
                    title={`${pty.cwd}\n${pty.terminalId}`}
                    type="button"
                  >
                    <span className={pty.running ? "session-run-dot running" : "session-run-dot"} />
                    <span className="session-terminal-copy">
                      <strong>{shortPath(pty.cwd)}</strong>
                      <small>
                        {pty.running ? "running" : pty.exitCode === null ? "starting" : `exit ${pty.exitCode}`} ·{" "}
                        {shortTerminalId(pty.terminalId)} · {formatRelative(pty.updatedAt, language)}
                      </small>
                    </span>
                  </button>
                  <button
                    aria-label={language === "ko" ? `${shortPath(pty.cwd)} 터미널 종료` : `Stop terminal ${shortPath(pty.cwd)}`}
                    className="session-terminal-stop"
                    disabled={stoppingTerminalId === pty.terminalId}
                    onClick={() => void stopTerminal(pty.terminalId)}
                    title={language === "ko" ? "터미널 종료" : "Stop terminal"}
                    type="button"
                  >
                    {stoppingTerminalId === pty.terminalId ? (
                      <Loader2 size={12} aria-hidden="true" className="loading-icon" />
                    ) : (
                      <Square size={11} aria-hidden="true" />
                    )}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="session-context-empty">{language === "ko" ? "터미널 세션 없음" : "No terminal sessions"}</p>
          )}
        </div>
        <div className="session-context-section">
          <div className="session-context-section-title">
            <span>Stage AI</span>
            {editingStageAi ? (
              <span className="session-context-actions">
                <button className="session-context-link" disabled={savingStageAi} onClick={() => void saveStageAiEdit()} type="button">
                  {savingStageAi ? <Loader2 size={12} className="loading-icon" /> : <Check size={12} />}
                  {language === "ko" ? "저장" : "Save"}
                </button>
                <button className="session-context-link" disabled={savingStageAi} onClick={cancelStageAiEdit} type="button">
                  <X size={12} />
                  {language === "ko" ? "취소" : "Cancel"}
                </button>
              </span>
            ) : (
              <button className="session-context-link" onClick={beginStageAiEdit} type="button">
                <Pencil size={12} />
                {language === "ko" ? "편집" : "Edit"}
              </button>
            )}
          </div>
          <div className="session-context-list">
            {(editingStageAi ? draftRoleAssignments ?? snapshot.settings.roleAssignments : snapshot.settings.roleAssignments).map((assignment) => (
              <RoleAssignmentRow
                assignment={assignment}
                connections={snapshot.settings.aiConnections.filter((connection) => connection.enabled)}
                editing={editingStageAi}
                key={assignment.roleId}
                onChange={(connectionId) => void updateRoleConnection(assignment.roleId, connectionId)}
                onModelChange={(model) => void updateRoleModel(assignment.roleId, model)}
                saving={savingStageAi}
                snapshot={snapshot}
                language={language}
              />
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

function RoleAssignmentRow({
  assignment,
  connections,
  editing,
  language,
  onChange,
  onModelChange,
  saving,
  snapshot,
}: {
  assignment: RoleAssignment;
  connections: AiConnection[];
  editing: boolean;
  language: AppLanguage;
  onChange: (connectionId: string) => void;
  onModelChange: (model: string) => void;
  saving: boolean;
  snapshot: ProjectSnapshot;
}) {
  const labels = assignment.selections.length > 0
    ? assignment.selections.map((selection) => {
        const connection = snapshot.settings.aiConnections.find((item) => item.id === selection.connectionId);
        return `${connection?.label ?? selection.connectionId}${selection.model ? ` · ${selection.model}` : ""}`;
      })
    : assignment.connectionIds;
  const selectedConnectionId = assignment.selections[0]?.connectionId ?? assignment.connectionIds[0] ?? "";
  const selectedConnection = snapshot.settings.aiConnections.find((item) => item.id === selectedConnectionId);
  const selectedModel = assignment.selections[0]?.model ?? selectedConnection?.defaultModel ?? "";
  const modelOptions = modelChoices(selectedConnection, selectedModel);
  return (
    <div
      className={
        editing
          ? "session-context-list-row static session-role-assignment-row editing"
          : "session-context-list-row static session-role-assignment-row"
      }
    >
      <div>
        <strong>{roleLabel(assignment.roleId, language)}</strong>
        {!editing ? <small>{labels.length > 0 ? labels.join(", ") : language === "ko" ? "미설정" : "Not set"}</small> : null}
      </div>
      {editing ? (
        <select
          aria-label={language === "ko" ? `${roleLabel(assignment.roleId, language)} AI 변경` : `Change ${roleLabel(assignment.roleId, language)} AI`}
          disabled={saving || connections.length === 0}
          onChange={(event) => onChange(event.target.value)}
          value={selectedConnectionId}
        >
          <option value="">{language === "ko" ? "미설정" : "Not set"}</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.label}
            </option>
          ))}
        </select>
      ) : null}
      {editing && selectedConnection ? (
        <select
          aria-label={language === "ko" ? `${roleLabel(assignment.roleId, language)} 모델 변경` : `Change ${roleLabel(assignment.roleId, language)} model`}
          disabled={saving}
          onChange={(event) => onModelChange(event.target.value)}
          value={selectedModel}
        >
          <option value="">{language === "ko" ? "CLI 기본 모델" : "CLI default model"}</option>
          {modelOptions.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function modelChoices(connection: AiConnection | undefined, selectedModel: string): string[] {
  if (!connection) return [];
  return [...new Set([...(connection.availableModels ?? []), connection.defaultModel ?? "", selectedModel].filter(Boolean))];
}

function cloneRoleAssignments(assignments: RoleAssignment[]): RoleAssignment[] {
  return assignments.map((assignment) => ({
    ...assignment,
    selections: assignment.selections.map((selection) => ({ ...selection })),
    connectionIds: [...assignment.connectionIds],
  }));
}

function SessionMessage(props: {
  role: "user" | "assistant" | "tool";
  icon: "user" | "bot" | "file";
  title: string;
  timestamp: string | null;
  language: AppLanguage;
  children: ReactNode;
}) {
  const Icon = props.icon === "user" ? User : props.icon === "file" ? FileText : Bot;
  return (
    <article className={`session-message ${props.role}`}>
      <div className="session-message-avatar">
        <Icon size={14} />
      </div>
      <div className="session-message-body">
        <header>
          <strong>{props.title}</strong>
          <time>{formatRelative(props.timestamp, props.language)}</time>
        </header>
        <div className="session-message-content">{props.children}</div>
      </div>
    </article>
  );
}

function OrchestratorPending({ language, phase }: { language: AppLanguage; phase: "orchestrator" | "planner" }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const label =
    phase === "planner"
      ? language === "ko"
        ? "계획자가 계획을 세우는 중입니다"
        : "The planner is drafting a plan"
      : language === "ko"
        ? "오케스트레이터가 응답을 작성 중입니다"
        : "The orchestrator is composing a reply";
  return (
    <SessionMessage role="assistant" icon="bot" title={language === "ko" ? "응답 대기 중" : "Waiting for reply"} timestamp={null} language={language}>
      <div className="session-working-indicator">
        <span className="session-working-spinner" aria-hidden="true" />
        <div>
          <strong>
            {label}
            <span className="session-working-dots" aria-hidden="true" />
          </strong>
          <p>{formatElapsed(seconds, language)}</p>
        </div>
      </div>
    </SessionMessage>
  );
}

function formatElapsed(seconds: number, language: AppLanguage): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (language === "ko") return m > 0 ? `${m}분 ${s}초 경과` : `${s}초 경과`;
  return m > 0 ? `${m}m ${s}s elapsed` : `${s}s elapsed`;
}

function SessionWorkingIndicator({
  language,
  session,
}: {
  language: AppLanguage;
  session: AgentSessionSummary | null;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const statusLabel = sessionWorkingLabel(session, language);
  return (
    <div className="session-working-indicator">
      <span className="session-working-spinner" aria-hidden="true" />
      <div>
        <strong>
          {statusLabel}
          <span className="session-working-dots" aria-hidden="true" />
        </strong>
        <p>{formatElapsed(seconds, language)}</p>
      </div>
    </div>
  );
}

// 머지 게이트 카드: 수정 요청 textarea는 task마다 독립이라 카드 단위로 로컬 상태를 둔다.
function MergeApprovalCard({
  task,
  language,
  busy,
  approving,
  requesting,
  onApprove,
  onRequestChanges,
}: {
  task: TaskSummary;
  language: AppLanguage;
  busy: boolean;
  approving: boolean;
  requesting: boolean;
  onApprove: () => void;
  onRequestChanges: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  return (
    <SessionMessage
      icon="bot"
      role="assistant"
      timestamp={task.updatedAt}
      title={`${language === "ko" ? "머지 승인 대기" : "Waiting for merge approval"} — ${task.title}`}
      language={language}
    >
      <p>
        {language === "ko"
          ? "테스트까지 모두 통과했습니다. 승인하면 worktree 변경사항을 커밋하고 origin에 push합니다."
          : "All checks including tests passed. Approving commits the worktree changes and pushes to origin."}
      </p>
      <p>
        {language === "ko"
          ? "수정할 부분이 있으면 아래에 적어 다시 작업시킬 수 있습니다."
          : "If anything needs fixing, describe it below to send it back for rework."}
      </p>
      <textarea
        className="session-change-request"
        disabled={busy}
        onChange={(event) => setFeedback(event.target.value)}
        placeholder={language === "ko" ? "수정 요청 내용 (선택)" : "Revision request (optional)"}
        rows={2}
        value={feedback}
      />
      <div className="composer-buttons">
        <button className="primary-button loading-button" disabled={busy} onClick={onApprove} type="button">
          {approving ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
          <span>{approving ? (language === "ko" ? "커밋/푸시 중…" : "Committing…") : (language === "ko" ? "머지 승인" : "Approve merge")}</span>
        </button>
        <button
          className="secondary-button loading-button"
          disabled={busy || !feedback.trim()}
          onClick={() => onRequestChanges(feedback)}
          type="button"
        >
          {requesting ? <Loader2 className="loading-icon" size={14} aria-hidden /> : <Pencil size={14} aria-hidden />}
          <span>{requesting ? (language === "ko" ? "재작업 시작 중…" : "Reopening…") : (language === "ko" ? "수정 요청" : "Request changes")}</span>
        </button>
      </div>
    </SessionMessage>
  );
}

function ContextRow({
  className,
  displayValue,
  label,
  value,
}: {
  className?: string;
  displayValue?: string;
  label: string;
  value: string;
}) {
  return (
    <div className="session-context-row">
      <span>{label}</span>
      <strong className={className} title={value}>
        {displayValue ?? value}
      </strong>
    </div>
  );
}

function blockReasonCopy(failureKind: string | null, failureReason: string | null, language: AppLanguage): string {
  if (language !== "ko") return failureReason ?? "Run requires manual inspection before continuing.";
  switch (failureKind) {
    case "diff_mismatch":
      return "보고된 변경 파일과 실제 Git diff가 일치하지 않아 자동 진행을 멈췄습니다.";
    case "schema_invalid":
      return "structured-result.json이 없거나 계약 형식과 맞지 않습니다.";
    case "blocking_gate":
      return "게이트 결과가 차단 이슈를 보고했습니다.";
    case "timeout":
      return "실행이 제한 시간을 초과했습니다.";
    case "exit_failed":
      return "러너가 비정상 종료 코드로 끝났습니다.";
    default:
      return "계속하기 전에 수동 점검이 필요합니다.";
  }
}

function isSessionWorking(session: AgentSessionSummary): boolean {
  return session.nextAction === "start" || session.nextAction === "watch" || session.nextAction === "approval";
}

function sessionWorkingLabel(session: AgentSessionSummary | null, language: AppLanguage): string {
  if (!session) return language === "ko" ? "작업 상태 확인 중" : "Checking work status";
  if (language === "en") {
    if (session.nextAction === "approval") return "Waiting for approval";
    if (session.nextAction === "start") return "Preparing the next role";
    return "Agent is working";
  }
  if (session.nextAction === "approval") return "승인 대기 중";
  if (session.nextAction === "start") return "다음 역할 실행 준비 중";
  return "에이전트가 작업 중입니다";
}

function currentAiLabel(session: AgentSessionSummary, language: AppLanguage = "ko"): string {
  const role = session.roleId ? roleLabel(session.roleId, language) : language === "ko" ? "역할 미정" : "No role";
  const runner = session.model ?? session.provider ?? session.connectionId ?? (language === "ko" ? "AI 미정" : "No AI");
  return `${role} · ${runner}`;
}

function changedFileCountLabel(files: GitFileStatus[], session: AgentSessionSummary | null): string {
  if (files.length > 0) return files.length.toString();
  return session?.changedFileCount?.toString() ?? "-";
}

function mergeTaskBackedSessions(
  sessions: AgentSessionSummary[],
  tasks: TaskSummary[],
): AgentSessionSummary[] {
  const sessionTaskIds = new Set(sessions.map((session) => session.taskId).filter(Boolean));
  const taskSessions = tasks
    .filter((task) => !sessionTaskIds.has(task.id))
    .map(taskBackedSession);
  return [...sessions, ...taskSessions].sort(
    (left, right) => timestampValue(right.lastSignalAt ?? right.updatedAt) - timestampValue(left.lastSignalAt ?? left.updatedAt),
  );
}

function taskBackedSession(task: TaskSummary): AgentSessionSummary {
  return {
    id: `task:${task.id}`,
    projectId: task.projectId,
    taskId: task.id,
    sourceRunId: null,
    title: task.title,
    status: task.status,
    provider: null,
    connectionId: null,
    model: null,
    roleId: null,
    taskStatus: task.status,
    branch: null,
    worktreePath: null,
    lastSignalAt: task.updatedAt,
    nextAction: "start",
    changedFileCount: null,
    eventCount: 0,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function timestampValue(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path || "/";
  return `.../${parts.slice(-2).join("/")}`;
}

function compactHomePath(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function shortTerminalId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function formatRelative(value: string | null | undefined, language: AppLanguage = "ko"): string {
  const time = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return "-";
  const diffMs = Math.max(0, Date.now() - time);
  if (diffMs < 60_000) return language === "ko" ? "방금 전" : "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return language === "ko" ? `${minutes}분 전` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return language === "ko" ? `${hours}시간 전` : `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return language === "ko" ? `${days}일 전` : `${days} day${days === 1 ? "" : "s"} ago`;
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}

function isConfirmationMessage(text: string): boolean {
  return /^(확인|진행|시작|좋아|오케이|ok|okay|yes|y|go|proceed)$/i.test(text.trim());
}

// Epic title for a materialized plan: the goal's first meaningful line (the original ask, before
// any "추가 요구사항" appended by follow-ups), trimmed to a sidebar-friendly length. Falls back to
// the first task title when the goal is empty.
// Epic 제목은 사이드바 그룹명으로 보이므로, 확정 요구사항의 마크다운 마커(##, -, * 등)를 벗기고
// "목표/범위/제약" 같은 섹션 라벨 줄은 건너뛰어 실제 내용 첫 줄을 제목으로 삼는다.
function deriveEpicTitle(goalText: string, tasks: PlanTask[]): string {
  const sectionLabels = new Set([
    "목표", "범위", "제약", "요약", "완료 조건", "추가 요구사항:",
    "goal", "goals", "scope", "constraints", "summary",
  ]);
  const stripMarkdown = (line: string) => line.replace(/^[#>*\-\s]+/, "").trim();
  const firstLine = goalText
    .split("\n")
    .map(stripMarkdown)
    .find((line) => line && !sectionLabels.has(line.toLowerCase()));
  const base = firstLine || tasks[0]?.title || "AI 계획";
  return base.length > 80 ? `${base.slice(0, 79)}…` : base;
}

function approvalLabel(type: string, language: AppLanguage): string {
  const ko = language === "ko";
  if (type === "PlanApproval") return ko ? "계획 승인" : "Plan approval";
  if (type === "ReviewApproval") return ko ? "리뷰 진행 승인" : "Review approval";
  if (type === "RunApproval") return ko ? "실행 승인" : "Run approval";
  if (type === "ManualStatusChange") return ko ? "수동 상태 변경" : "Manual status change";
  return type;
}

// Render the orchestrator's structured reply for the chat. When not ready, lead with open questions
// so the user knows what to answer; when ready, show the organized requirement and ask for confirmation.
function orchestratorReplyText(reply: OrchestratorReply, language: AppLanguage): string {
  const ko = language === "ko";
  const sections: string[] = [];
  if (reply.requirement.trim()) {
    sections.push(`${ko ? "📋 정리된 요구사항" : "📋 Requirements so far"}\n${reply.requirement.trim()}`);
  }
  if (reply.assumptions.length) {
    const list = reply.assumptions.map((item) => `- ${item}`).join("\n");
    sections.push(`${ko ? "🔎 가정 (확인 필요)" : "🔎 Assumptions (please check)"}\n${list}`);
  }
  if (!reply.ready && reply.questions.length) {
    const list = reply.questions.map((item, index) => `${index + 1}. ${item}`).join("\n");
    sections.push(`${ko ? "❓ 확인이 필요한 점" : "❓ Open questions"}\n${list}`);
  }
  sections.push(
    reply.ready
      ? ko
        ? '이대로 계획자에게 넘길까요? 진행하려면 "확인" 또는 "진행"이라고 답하고, 수정할 내용이 있으면 이어서 적어주세요.'
        : 'Hand this to the planner? Reply "ok" to proceed, or add corrections.'
      : ko
        ? "위 질문에 답하거나 빠진 내용을 알려주세요."
        : "Answer the questions above or add the missing details.",
  );
  return sections.join("\n\n");
}

// Keep the previous reference when the freshly-fetched value is deeply equal, so a no-op poll
// doesn't trigger a re-render. ponytail: JSON.stringify compare — these arrays are small (one
// task's transcript); swap for a structural compare only if they ever grow large.
function keepIfEqual<T>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}
