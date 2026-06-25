import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Check, FileText, Folder, Loader2, MessageSquare, MoreHorizontal, Pencil, Plus, Send, Square, Trash2, User, X } from "lucide-react";
import { ApprovalInbox } from "../components/ApprovalInbox";
import { collapseSessionsByTask } from "../lib/agentSessions";
import { api } from "../lib/api";
import { useI18n, type AppLanguage } from "../lib/i18n";
import { shortenPath, type RecentProject } from "../lib/recents";
import { roleLabel } from "../lib/runnerReadiness";
import { parsePlanTasks, stripPlanJson } from "../lib/planParse";
import type {
  AgentSessionSummary,
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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [deletingSession, setDeletingSession] = useState(false);
  const [events, setEvents] = useState<RunEventSummary[]>([]);
  const [summaries, setSummaries] = useState<Array<{ runId: string; roleId: string; text: string; at: string | null }>>([]);
  const [runAlert, setRunAlert] = useState<{ roleId: string; status: string; failureKind: string | null; failureReason: string | null; at: string | null } | null>(null);
  const [orchestratorMessages, setOrchestratorMessages] = useState<Array<{ id: string; role: "user" | "assistant"; content: string }>>([]);
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
  const [changeRequest, setChangeRequest] = useState("");
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [composingNewSession, setComposingNewSession] = useState(false);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatScrollFrameRef = useRef<number | null>(null);
  // Orchestrator chat bubbles are project-scoped client state with no backing store. Reset them
  // whenever the active session changes — switching, deleting, starting a new compose, or changing
  // project — so a previous session's transcript doesn't bleed into the next one. Also abandon any
  // in-flight conductor turn: left running it would keep streaming into the cleared transcript and
  // could still materialize tasks for a session the user just left.
  useEffect(() => {
    setOrchestratorBusy(false);
    setPendingOrchestratorRequirement(null);
    setOrchestratorMessages([]);
  }, [activeSessionId]);

  const taskById = useMemo(
    () => new Map(snapshot?.tasks.map((task) => [task.id, task]) ?? []),
    [snapshot?.tasks],
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
  const activeApprovalEntityIds = [activeTask?.id, activeSession?.sourceRunId].filter(Boolean) as string[];
  const activeApprovalCount =
    activeApprovalEntityIds.length > 0
      ? snapshot?.approvals.filter(
          (approval) => approval.status === "Pending" && activeApprovalEntityIds.includes(approval.entityId),
        ).length ?? 0
      : 0;
  const pendingApprovalCount = snapshot?.approvals.filter((approval) => approval.status === "Pending").length ?? 0;
  const activeRunWorking = Boolean(activeSession && isSessionWorking(activeSession));
  const latestActivity = events.at(-1) ?? null;
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

  useEffect(() => {
    scrollChatToBottom();
  }, [
    activeApprovalCount,
    activeSession?.id,
    activeTask?.id,
    events.length,
    orchestratorMessages.length,
    orchestratorPending,
    summaries.length,
  ]);

  useEffect(() => {
    return () => {
      if (chatScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(chatScrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const taskId = activeTask?.id;
    if (!snapshot || !taskId) {
      setEvents([]);
      setSummaries([]);
      setRunAlert(null);
      return;
    }
    let disposed = false;
    const projectId = snapshot.project.id;
    // Accumulate the whole task transcript: every role run's events + summary, in run order,
    // so handing off to the next role appends history instead of replacing it.
    void api
      .listAgentRuns(projectId, taskId)
      .then(async (runs) => {
        const ordered = [...runs].sort((a, b) => timestampValue(a.createdAt) - timestampValue(b.createdAt));
        const perRun = await Promise.all(
          ordered.map(async (run) => ({
            run,
            events: await api.listRunEvents(projectId, run.id).catch(() => []),
            summary: await api.readRunArtifact(projectId, run.id, "summary.md").catch(() => null),
          })),
        );
        if (disposed) return;
        // Polling re-fetches the whole transcript every few seconds. Bail when the data is
        // unchanged (return the prev reference) so identical polls don't churn the DOM and make
        // chat blocks blink/reorder.
        const nextEvents = perRun.flatMap((entry) => entry.events);
        setEvents((prev) => keepIfEqual(prev, nextEvents));
        const nextSummaries = perRun
          .filter((entry) => entry.summary?.trim())
          .map((entry) => ({ runId: entry.run.id, roleId: entry.run.roleId, text: entry.summary!.trim(), at: entry.run.finishedAt ?? entry.run.updatedAt }));
        setSummaries((prev) => keepIfEqual(prev, nextSummaries));
        // Surface the latest run's blocking reason: a NeedsInspection/Failed run leaves the task
        // silently stuck (e.g. coder reported edits that aren't in the worktree diff). Show it.
        const latest = ordered.at(-1);
        const nextAlert =
          latest && (latest.status === "NeedsInspection" || latest.status === "Failed")
            ? { roleId: latest.roleId, status: latest.status, failureKind: latest.failureKind, failureReason: latest.failureReason, at: latest.finishedAt ?? latest.updatedAt }
            : null;
        setRunAlert((prev) => keepIfEqual(prev, nextAlert));
      })
      .catch(() => {
        if (!disposed) {
          setEvents([]);
          setSummaries([]);
          setRunAlert(null);
        }
      });
    return () => {
      disposed = true;
    };
  }, [activeTask?.id, activityRefreshKey, snapshot?.project.id]);

  useEffect(() => {
    if (!snapshot || !activeSession?.sourceRunId) return;
    const projectId = snapshot.project.id;
    const runId = activeSession.sourceRunId;
    let disposed = false;
    let cleanupEvent: (() => void) | null = null;
    let cleanupUpdated: (() => void) | null = null;

    void listen<RunEventSummary>("agent-run://event", (event) => {
      if (disposed || event.payload.projectId !== projectId || event.payload.runId !== runId) return;
      setActivityRefreshKey((value) => value + 1);
      setReloadKey((value) => value + 1);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        cleanupEvent = unlisten;
      }
    });

    void listen<{ projectId?: string; runId?: string }>("agent-run://updated", (event) => {
      if (disposed || event.payload.projectId !== projectId || event.payload.runId !== runId) return;
      setActivityRefreshKey((value) => value + 1);
      setReloadKey((value) => value + 1);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        cleanupUpdated = unlisten;
      }
    });

    const timer = window.setInterval(() => {
      if (activeRunWorking) {
        setActivityRefreshKey((value) => value + 1);
        setReloadKey((value) => value + 1);
      }
    }, 3_000);

    return () => {
      disposed = true;
      cleanupEvent?.();
      cleanupUpdated?.();
      window.clearInterval(timer);
    };
  }, [activeRunWorking, activeSession?.sourceRunId, snapshot?.project.id]);

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
    setOrchestratorMessages((items) => [...items, { id: crypto.randomUUID(), role: "user", content: goalText }]);

    if (!pendingOrchestratorRequirement || !isConfirmationMessage(goalText)) {
      const nextRequirement = [pendingOrchestratorRequirement, goalText].filter(Boolean).join("\n\n추가 요구사항:\n");
      setPendingOrchestratorRequirement(nextRequirement);
      setOrchestratorMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: requirementConfirmationText(nextRequirement, language),
        },
      ]);
      return;
    }

    const confirmedRequirement = pendingOrchestratorRequirement;
    setPendingOrchestratorRequirement(null);
    setOrchestratorBusy(true);
    try {
      const result = await api.runPlannerConversation(snapshot.project.id, {
        message: confirmedRequirement,
        goalText: confirmedRequirement,
        currentDraftJson: null,
      });
      if (result.timedOut || result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || result.responseText.trim() || (language === "ko" ? "AI 계획 응답을 받지 못했습니다." : "The AI planner did not return a usable response."));
      }
      const reply = result.responseText.trim();
      setOrchestratorMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: stripPlanJson(reply) || (language === "ko" ? "계획을 받았습니다." : "Received a plan."),
        },
      ]);
      await maybeMaterializeTasks(reply);
    } catch (error) {
      setLoadError(messageFromError(error, language === "ko" ? "오케스트레이터에 지시를 전달하지 못했습니다." : "Failed to send the instruction to the orchestrator."));
    } finally {
      setOrchestratorBusy(false);
    }
  }

  async function cancelOrchestratorTurn() {
    setOrchestratorBusy(false);
  }

  // Every planner reply is parsed for tasks[] JSON. If found, confirm once, then materialize
  // each into a Helm task that the existing role-pipeline engine runs.
  async function maybeMaterializeTasks(turnText: string) {
    if (!snapshot) return;
    const tasks = parsePlanTasks(turnText);
    if (!tasks) return;
    const proceed = window.confirm(language === "ko" ? "이대로 진행할까요? 설계자에게 넘겨 작업을 시작합니다." : "Proceed? This hands the requirement to the planner and starts the task.");
    if (!proceed) return;
    const projectId = snapshot.project.id;
    const created: string[] = [];
    for (const task of tasks) {
      try {
        const description = [task.description, task.role ? `(role: ${task.role})` : null].filter(Boolean).join("\n\n") || task.title;
        const newTask = await api.createTask(projectId, {
          title: task.title.slice(0, 120),
          description,
          externalRefs: [{ refType: "PlainText", refValue: task.description ?? task.title, refTitle: language === "ko" ? "AI 계획 작업" : "AI-planned task" }],
        });
        try {
          await api.startNextRoleRun(projectId, newTask.id);
        } catch {
          /* task created; run start is best-effort */
        }
        created.push(newTask.title);
      } catch {
        /* skip a task that failed to create */
      }
    }
    setOrchestratorMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: created.length
          ? (language === "ko" ? `${created.length}개 작업을 만들고 실행을 시작했습니다:\n- ${created.join("\n- ")}` : `Created ${created.length} task(s) and started their runs:\n- ${created.join("\n- ")}`)
          : (language === "ko" ? "작업 생성에 실패했습니다." : "Failed to create tasks."),
      },
    ]);
    setOrchestratorBusy(false);
    await onRefresh();
    setReloadKey((value) => value + 1);
  }

  // Delete the active work session: removes the task and (via the backend command) its runs,
  // events, evidence, approvals, plus the on-disk git worktree and local branch. Clearing
  // activeSessionId below also resets the orchestrator chat bubbles via the effect above.
  async function deleteSession() {
    if (!snapshot || !activeTask || deletingSession) return;
    const proceed = window.confirm(
      language === "ko"
        ? `"${activeTask.title}" 작업 세션을 삭제할까요?\n연결된 run/event/근거와 git worktree·로컬 브랜치까지 함께 삭제됩니다.`
        : `Delete the work session "${activeTask.title}"?\nThis also removes its runs/events/evidence and the git worktree and local branch.`,
    );
    if (!proceed) return;
    setDeletingSession(true);
    setLoadError(null);
    try {
      await api.deleteTask(snapshot.project.id, activeTask.id);
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
  async function approveMerge() {
    if (!snapshot || !activeTask || mergeApproving) return;
    const proceed = window.confirm(
      language === "ko"
        ? `"${activeTask.title}" 작업을 머지 승인할까요?\nworktree 변경사항을 커밋하고 origin에 push합니다.`
        : `Approve merge for "${activeTask.title}"?\nThis commits the worktree changes and pushes to origin.`,
    );
    if (!proceed) return;
    setMergeApproving(true);
    setLoadError(null);
    try {
      await api.approveTaskCompletionWithGit(snapshot.project.id, activeTask.id);
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
  async function requestChanges() {
    if (!snapshot || !activeTask || requestingChanges) return;
    const feedback = changeRequest.trim();
    if (!feedback) return;
    setRequestingChanges(true);
    setLoadError(null);
    try {
      await api.appendTaskInstruction(snapshot.project.id, activeTask.id, feedback);
      await api.updateTaskStatus(snapshot.project.id, activeTask.id, "Ready", language === "ko" ? "머지 전 수정 요청으로 재작업" : "Reopened for pre-merge changes");
      await api.startNextRoleRun(snapshot.project.id, activeTask.id);
      setChangeRequest("");
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
    window.setTimeout(() => composerRef.current?.focus(), 0);
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
                    {collapseSessionsByTask(sessions).map((session) => {
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
        {activeSession || activeTask ? (
          <>
            <header className="session-chat-header">
              <div>
                <h1>{activeSession?.title ?? activeTask?.title}</h1>
                <p>
                  {activeSession?.provider ?? t("sessions.providerUnknown")}
                  {activeSession?.model ? ` · ${activeSession.model}` : ""}
                </p>
              </div>
              {activeTask ? (
                <button
                  type="button"
                  className="secondary-button session-delete-button"
                  onClick={() => void deleteSession()}
                  disabled={deletingSession}
                >
                  {deletingSession
                    ? language === "ko"
                      ? "삭제 중…"
                      : "Deleting…"
                    : language === "ko"
                      ? "세션 삭제"
                      : "Delete session"}
                </button>
              ) : null}
            </header>
            <div className="session-chat-scroll" ref={chatScrollRef}>
              <SessionMessage role="assistant" icon="bot" title={t("sessions.assistantTitle")} timestamp={activeSession?.lastSignalAt ?? null} language={language}>
                <p>{t("sessions.introMessage")}</p>
              </SessionMessage>
              <SessionMessage role="user" icon="user" title={t("sessions.requestTitle")} timestamp={activeTask?.createdAt ?? activeSession?.createdAt ?? null} language={language}>
                <strong>{activeTask?.title ?? activeSession?.title}</strong>
                {activeTask?.description ? <p>{activeTask.description}</p> : null}
              </SessionMessage>
              {activeSession ? (
                <SessionMessage role="assistant" icon="bot" title={t("sessions.progressTitle")} timestamp={activeSession.lastSignalAt ?? activeSession.updatedAt} language={language}>
                  <p>{sessionStatusCopy(activeSession, language)}</p>
                </SessionMessage>
              ) : (
                <SessionMessage role="assistant" icon="bot" title={t("sessions.waitingTitle")} timestamp={activeTask?.updatedAt ?? null} language={language}>
                  <p>{t("sessions.noLinkedRun")}</p>
                </SessionMessage>
              )}
              {activeApprovalCount > 0 ? (
                <SessionMessage role="assistant" icon="bot" title={t("sessions.approvalTitle")} timestamp={activeSession?.lastSignalAt ?? activeTask?.updatedAt ?? null} language={language}>
                  <ApprovalInbox
                    compact
                    entityIds={activeApprovalEntityIds}
                    onRefresh={onRefresh}
                    snapshot={snapshot}
                  />
                </SessionMessage>
              ) : null}
              {events.filter(isContentEvent).map((event) => (
                <SessionMessage
                  icon={event.kind === "artifact" ? "file" : "bot"}
                  key={event.id}
                  role={event.kind === "stdout" || event.kind === "stderr" ? "tool" : "assistant"}
                  timestamp={event.createdAt}
                  title={event.kind}
                  language={language}
                >
                  <p>{event.message}</p>
                </SessionMessage>
              ))}
              {summaries.map((summary) => (
                <SessionMessage
                  icon="file"
                  key={summary.runId}
                  role="assistant"
                  timestamp={summary.at}
                  title={`${roleLabel(summary.roleId, language)} · ${t("sessions.summaryTitle")}`}
                  language={language}
                >
                  <div className="session-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.text}</ReactMarkdown>
                  </div>
                </SessionMessage>
              ))}
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
                    <p>{text}</p>
                  </SessionMessage>
                );
              })}
              {orchestratorPending ? <OrchestratorPending language={language} /> : null}
              {runAlert ? (
                <SessionMessage
                  icon="bot"
                  role="tool"
                  timestamp={runAlert.at}
                  title={language === "ko" ? "막힘 · 점검 필요" : "Blocked · needs inspection"}
                  language={language}
                >
                  <p>{blockReasonCopy(runAlert.failureKind, runAlert.failureReason, language)}</p>
                  {runAlert.failureKind === "diff_mismatch" ? (
                    <p>
                      {language === "ko"
                        ? "에이전트가 보고한 변경 파일이 worktree의 실제 git diff에 없습니다. coder를 재실행하거나 Git 화면에서 worktree 변경사항을 직접 확인하세요."
                        : "The agent's reported changes are not in the worktree's actual git diff. Re-run the coder, or inspect the worktree in the Git view."}
                    </p>
                  ) : null}
                </SessionMessage>
              ) : null}
              {activeTask?.status === "MergeWaiting" ? (
                <SessionMessage
                  icon="bot"
                  role="assistant"
                  timestamp={activeTask.updatedAt}
                  title={language === "ko" ? "머지 승인 대기" : "Waiting for merge approval"}
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
                    disabled={mergeApproving || requestingChanges}
                    onChange={(event) => setChangeRequest(event.target.value)}
                    placeholder={language === "ko" ? "수정 요청 내용 (선택)" : "Revision request (optional)"}
                    rows={2}
                    value={changeRequest}
                  />
                  <div className="composer-buttons">
                    <button
                      className="primary-button loading-button"
                      disabled={mergeApproving || requestingChanges}
                      onClick={() => void approveMerge()}
                      type="button"
                    >
                      {mergeApproving ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
                      <span>{mergeApproving ? (language === "ko" ? "커밋/푸시 중…" : "Committing…") : (language === "ko" ? "머지 승인" : "Approve merge")}</span>
                    </button>
                    <button
                      className="secondary-button loading-button"
                      disabled={mergeApproving || requestingChanges || !changeRequest.trim()}
                      onClick={() => void requestChanges()}
                      type="button"
                    >
                      {requestingChanges ? <Loader2 className="loading-icon" size={14} aria-hidden /> : <Pencil size={14} aria-hidden />}
                      <span>{requestingChanges ? (language === "ko" ? "재작업 시작 중…" : "Reopening…") : (language === "ko" ? "수정 요청" : "Request changes")}</span>
                    </button>
                  </div>
                </SessionMessage>
              ) : null}
              {activeRunWorking ? (
                <SessionMessage icon="bot" role="assistant" timestamp={activeSession?.lastSignalAt ?? null} title={language === "ko" ? "진행 중" : "Working"} language={language}>
                  <SessionWorkingIndicator
                    language={language}
                    latestActivity={latestActivity}
                    session={activeSession}
                  />
                </SessionMessage>
              ) : null}
            </div>
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
          </>
        ) : (
          <>
            {orchestratorMessages.length === 0 ? (
              <div className="session-chat-empty">
                <MessageSquare size={20} />
                <h2>{t("sessions.emptyChat.title")}</h2>
                <p>{t("sessions.emptyChat.description")}</p>
              </div>
            ) : (
              <div className="session-chat-scroll" ref={chatScrollRef}>
                <div className="session-chat-thread">
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
                        <p>{text}</p>
                      </SessionMessage>
                    );
                  })}
                  {orchestratorPending ? <OrchestratorPending language={language} /> : null}
                </div>
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
          </>
        )}
      </section>

      <aside className="session-context-panel" aria-label={language === "ko" ? "환경" : "Environment"}>
        <h3>Environment</h3>
        {pendingApprovalCount > 0 ? (
          <div className="session-context-approval">
            <ApprovalInbox compact snapshot={snapshot} onRefresh={onRefresh} />
          </div>
        ) : null}
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

function OrchestratorPending({ language }: { language: AppLanguage }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <SessionMessage role="assistant" icon="bot" title={language === "ko" ? "응답 대기 중" : "Waiting for reply"} timestamp={null} language={language}>
      <div className="session-working-indicator">
        <span className="session-working-spinner" aria-hidden="true" />
        <div>
          <strong>
            {language === "ko" ? "오케스트레이터가 응답을 작성 중입니다" : "The orchestrator is composing a reply"}
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
  latestActivity,
  session,
}: {
  language: AppLanguage;
  latestActivity: RunEventSummary | null;
  session: AgentSessionSummary | null;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const statusLabel = sessionWorkingLabel(session, language);
  const activityLabel = latestActivity
    ? `${latestActivity.kind}: ${latestActivity.message}`
    : language === "ko"
      ? "아직 새 이벤트가 없습니다."
      : "No new event yet.";
  return (
    <div className="session-working-indicator">
      <span className="session-working-spinner" aria-hidden="true" />
      <div>
        <strong>
          {statusLabel}
          <span className="session-working-dots" aria-hidden="true" />
        </strong>
        <p>{activityLabel}</p>
        <p>{formatElapsed(seconds, language)}</p>
      </div>
    </div>
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

function sessionStatusCopy(session: AgentSessionSummary, language: AppLanguage): string {
  if (language === "en") {
    if (session.nextAction === "approval") return "User approval is required. Helm will not continue before approval.";
    if (session.nextAction === "watch") return "A worker is running. Events and artifacts will accumulate in the timeline below.";
    if (session.nextAction === "review") return "The run has finished. Review changed files and verification results next.";
    if (session.nextAction === "retry") return "The run failed or was canceled. Check the reason and decide whether to retry.";
    if (session.nextAction === "start") return "Waiting to start. Details will appear once a worker claims the session.";
    return "Inspect the session details.";
  }
  if (session.nextAction === "approval") return "사용자 승인이 필요합니다. 승인 전에는 다음 단계로 진행하지 않습니다.";
  if (session.nextAction === "watch") return "작업자가 실행 중입니다. 이벤트와 산출물은 아래 타임라인에 누적됩니다.";
  if (session.nextAction === "review") return "실행이 끝났습니다. 변경 파일과 검증 결과를 확인할 차례입니다.";
  if (session.nextAction === "retry") return "실행 실패 또는 취소 상태입니다. 실패 이유를 확인하고 재시도 여부를 결정해야 합니다.";
  if (session.nextAction === "start") return "실행 대기 상태입니다. 작업자가 세션을 가져가면 상세 이벤트가 표시됩니다.";
  return "세션 상세를 확인합니다.";
}

// Lifecycle plumbing (status/system/artifact creation notices) is noise in the chat; show only
// events that carry real agent output. The run summary already renders separately as a summary block.
function isContentEvent(event: RunEventSummary): boolean {
  return event.kind === "stdout" || event.kind === "stderr" || event.kind === "result";
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

function requirementConfirmationText(requirement: string, language: AppLanguage): string {
  if (language === "en") {
    return `I'll hand this to the planner after your confirmation.\n\n${requirement}\n\nReply "ok" to proceed, or add missing details.`;
  }
  return `아래 내용으로 계획자 AI에게 넘길까요?\n\n${requirement}\n\n진행하려면 "확인" 또는 "진행"이라고 답하고, 빠진 내용이 있으면 이어서 적어주세요.`;
}

// Keep the previous reference when the freshly-fetched value is deeply equal, so a no-op poll
// doesn't trigger a re-render. ponytail: JSON.stringify compare — these arrays are small (one
// task's transcript); swap for a structural compare only if they ever grow large.
function keepIfEqual<T>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}
