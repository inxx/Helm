import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Check, FileText, Folder, GitBranch, Loader2, MessageSquare, MoreHorizontal, Pencil, Plus, Send, Square, SquareTerminal, Trash2, User, X } from "lucide-react";
import { ApprovalInbox } from "../components/ApprovalInbox";
import { api } from "../lib/api";
import { useI18n, type AppLanguage } from "../lib/i18n";
import { shortenPath, type RecentProject } from "../lib/recents";
import { roleLabel } from "../lib/runnerReadiness";
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
  const [events, setEvents] = useState<RunEventSummary[]>([]);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [orchestratorMessages, setOrchestratorMessages] = useState<Array<{ id: string; role: "user" | "assistant"; content: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingStageAi, setSavingStageAi] = useState(false);
  const [editingStageAi, setEditingStageAi] = useState(false);
  const [draftRoleAssignments, setDraftRoleAssignments] = useState<RoleAssignment[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [stoppingTerminalId, setStoppingTerminalId] = useState<string | null>(null);
  const [composingNewSession, setComposingNewSession] = useState(false);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatScrollFrameRef = useRef<number | null>(null);
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
      api.getChangedFiles(snapshot.project.id).catch(() => []),
    ])
      .then(([items, ptys, files]) => {
        if (disposed) return;
        setSessions(items);
        setTerminalPtys(ptys);
        setChangedFiles(files);
        if (composingNewSession) return;
        if (selectedTaskId) {
          setActiveSessionId(items.find((session) => session.taskId === selectedTaskId)?.id ?? items[0]?.id ?? null);
        } else {
          setActiveSessionId((current) => (current && items.some((session) => session.id === current) ? current : items[0]?.id ?? null));
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
  }, [snapshot?.project.id, composingNewSession, selectedTaskId, reloadKey]);

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
    summaryText,
  ]);

  useEffect(() => {
    return () => {
      if (chatScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(chatScrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!snapshot || !activeSession?.sourceRunId || !activeSession.taskId) {
      setEvents([]);
      setSummaryText(null);
      return;
    }
    let disposed = false;
    setEvents([]);
    setSummaryText(null);
    void Promise.all([
      api.listRunEvents(snapshot.project.id, activeSession.sourceRunId).catch(() => []),
      api.readRunArtifact(snapshot.project.id, activeSession.sourceRunId, "summary.md").catch(() => null),
    ]).then(([nextEvents, nextSummary]) => {
      if (disposed) return;
      setEvents(nextEvents);
      setSummaryText(nextSummary);
    });
    return () => {
      disposed = true;
    };
  }, [activeSession?.sourceRunId, activeSession?.taskId, snapshot?.project.id]);

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
    const projectId = snapshot.project.id;
    setOrchestratorBusy(true);
    setLoadError(null);
    try {
      setOrchestratorInput("");
      setOrchestratorMessages((items) => [...items, { id: crypto.randomUUID(), role: "user", content: goalText }]);
      const created = await api.createPlanningSession(projectId, {
        goalText,
        title: titleFromGoal(goalText),
      });
      setOrchestratorMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            language === "ko"
              ? `요청을 오케스트레이터 세션으로 받았습니다. "${created.session.title}" 기준으로 Task 후보와 실행 상태는 태스크 탭에서 확인합니다.`
              : `Received this request as an orchestrator session. Check task candidates and run state in Tasks for "${created.session.title}".`,
        },
      ]);
      await onRefresh();
      setReloadKey((value) => value + 1);
    } catch (error) {
      setLoadError(messageFromError(error, language === "ko" ? "오케스트레이터 지시를 저장하지 못했습니다." : "Failed to save the orchestrator instruction."));
    } finally {
      setOrchestratorBusy(false);
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
                    {sessions.map((session) => {
                      const active = session.id === activeSession?.id;
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
              <div className="session-header-actions">
                {activeSession?.branch ? (
                  <span className="session-meta-pill">
                    <GitBranch size={13} />
                    {activeSession.branch}
                  </span>
                ) : null}
                <button className="secondary-button" onClick={onGoTerminal} type="button">
                  <SquareTerminal size={14} />
                  <span>{t("sessions.terminal")}</span>
                </button>
              </div>
            </header>
            <div className="session-chat-scroll" ref={chatScrollRef}>
              <SessionMessage role="assistant" icon="bot" title={t("sessions.assistantTitle")} timestamp={activeSession?.lastSignalAt ?? null} language={language}>
                <p>{t("sessions.introMessage")}</p>
              </SessionMessage>
              {orchestratorMessages.map((message) => (
                <SessionMessage
                  icon={message.role === "user" ? "user" : "bot"}
                  key={message.id}
                  role={message.role}
                  timestamp={null}
                  title={message.role === "user" ? t("sessions.requestTitle") : t("sessions.assistantTitle")}
                  language={language}
                >
                  <p>{message.content}</p>
                </SessionMessage>
              ))}
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
              {events.map((event) => (
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
              {summaryText && activeSession ? (
                <SessionMessage icon="file" role="assistant" timestamp={activeSession.updatedAt} title={t("sessions.summaryTitle")} language={language}>
                  <div className="session-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{summaryText.trim()}</ReactMarkdown>
                  </div>
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
              <button className="primary-button loading-button" disabled={!orchestratorInput.trim() || orchestratorBusy} type="submit">
                {orchestratorBusy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : <Send size={14} aria-hidden />}
                <span>{orchestratorBusy ? t("sessions.sending") : t("sessions.send")}</span>
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="session-chat-empty">
              <MessageSquare size={20} />
              <h2>{t("sessions.emptyChat.title")}</h2>
              <p>{t("sessions.emptyChat.description")}</p>
              {orchestratorMessages.map((message) => (
                <SessionMessage
                  icon={message.role === "user" ? "user" : "bot"}
                  key={message.id}
                  role={message.role}
                  timestamp={null}
                  title={message.role === "user" ? t("sessions.requestTitle") : t("sessions.assistantTitle")}
                  language={language}
                >
                  <p>{message.content}</p>
                </SessionMessage>
              ))}
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
              <button className="primary-button loading-button" disabled={!orchestratorInput.trim() || orchestratorBusy} type="submit">
                {orchestratorBusy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : <Send size={14} aria-hidden />}
                <span>{orchestratorBusy ? t("sessions.sending") : t("sessions.send")}</span>
              </button>
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
        <ContextRow label="Project" value={snapshot.project.name} />
        <ContextRow label="Branch" value={activeSession?.branch ?? snapshot.repository.currentBranch ?? "-"} />
        <ContextRow label="Worktree" value={activeSession?.worktreePath ?? "-"} />
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

function currentAiLabel(session: AgentSessionSummary, language: AppLanguage = "ko"): string {
  const role = session.roleId ? roleLabel(session.roleId, language) : language === "ko" ? "역할 미정" : "No role";
  const runner = session.model ?? session.provider ?? session.connectionId ?? (language === "ko" ? "AI 미정" : "No AI");
  return `${role} · ${runner}`;
}

function changedFileCountLabel(files: GitFileStatus[], session: AgentSessionSummary | null): string {
  if (files.length > 0) return files.length.toString();
  return session?.changedFileCount?.toString() ?? "-";
}

function titleFromGoal(goalText: string): string {
  const firstLine = goalText.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "New task";
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}...` : firstLine;
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
