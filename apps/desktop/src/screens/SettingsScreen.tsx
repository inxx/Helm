import { CheckCircle2, Download, FolderTree, Info, Layers, Plug, RefreshCw, Workflow, Wrench, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { checkForManualUpdate, type ManualUpdateInfo } from "../lib/updater";
import type {
  AiConnection,
  AiConnectionCheckResult,
  ProjectSnapshot,
  RoleAssignment,
  RunnerCheckResult,
  RunnerTemplateSummary,
} from "../lib/types";

interface SettingsScreenProps {
  snapshot: ProjectSnapshot | null;
  onRefresh: () => Promise<void>;
  onOpenProject: () => void;
}

type SettingsCategory = "templates" | "connections" | "assignments" | "worktree" | "app" | "advanced";

const CATEGORIES: Array<{
  id: SettingsCategory;
  label: string;
  hint: string;
  icon: typeof Layers;
}> = [
  { id: "templates", label: "Runner Templates", hint: "역할 프리셋과 AI 연결을 한 번에 적용", icon: Layers },
  { id: "connections", label: "AI 연결", hint: "Codex · Claude 등 도구 등록", icon: Plug },
  { id: "assignments", label: "작업별 AI 선택", hint: "계획 · 구현 · 검수 · 테스트 매핑", icon: Workflow },
  { id: "worktree", label: "Worktree", hint: "병렬 작업 디렉터리 위치", icon: FolderTree },
  { id: "app", label: "앱", hint: "Helm 업데이트 확인", icon: Info },
  { id: "advanced", label: "고급", hint: "Role presets JSON · 기존 runner 확인", icon: Wrench },
];

const ROLE_DEFINITIONS: Array<{
  roleId: RoleAssignment["roleId"];
  label: string;
  group: string;
  selectionMode: RoleAssignment["selectionMode"];
}> = [
  { roleId: "planner", label: "설계자", group: "계획", selectionMode: "single" },
  { roleId: "coder", label: "구현자", group: "구현", selectionMode: "single" },
  { roleId: "plan_verifier", label: "계획 검수", group: "검수", selectionMode: "multiple" },
  { roleId: "code_reviewer", label: "코드 리뷰", group: "검수", selectionMode: "multiple" },
  { roleId: "tester", label: "테스트", group: "테스트", selectionMode: "multiple" },
];

type MessageTone = "success" | "error" | "info";

export function SettingsScreen({ snapshot, onRefresh, onOpenProject }: SettingsScreenProps) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("templates");
  const [rolePresets, setRolePresets] = useState("");
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [templates, setTemplates] = useState<RunnerTemplateSummary[]>([]);
  const [runnerChecks, setRunnerChecks] = useState<RunnerCheckResult[]>([]);
  const [connectionChecks, setConnectionChecks] = useState<Record<string, AiConnectionCheckResult>>({});
  const [aiConnections, setAiConnections] = useState<AiConnection[]>([]);
  const [roleAssignments, setRoleAssignments] = useState<RoleAssignment[]>([]);
  const [message, setMessage] = useState<{ tone: MessageTone; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [updaterBusy, setUpdaterBusy] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<ManualUpdateInfo | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    setRolePresets(JSON.stringify(snapshot.settings.rolePresets, null, 2));
    setAiConnections(normalizeAiConnections(snapshot.settings.aiConnections));
    setRoleAssignments(normalizeRoleAssignments(snapshot.settings.roleAssignments));
    setWorktreeRoot(snapshot.settings.worktreeRoot ?? "");
    void api.listRunnerTemplates(snapshot.project.id).then(setTemplates);
    setRunnerChecks([]);
    setConnectionChecks({});
    setMessage(null);
  }, [snapshot]);

  const enabledConnections = useMemo(
    () => aiConnections.filter((connection) => connection.enabled),
    [aiConnections],
  );

  async function save() {
    if (!snapshot) return;
    setBusy(true);
    setMessage(null);
    try {
      const parsedRolePresets = JSON.parse(rolePresets);
      await api.updateProjectSettings(snapshot.project.id, {
        rolePresets: parsedRolePresets,
        aiConnections,
        roleAssignments: normalizeRoleAssignments(roleAssignments),
        worktreeRoot: worktreeRoot.trim() ? worktreeRoot.trim() : null,
      });
      await onRefresh();
      setMessage({ tone: "success", text: "저장됨" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "설정 저장에 실패했습니다." });
    } finally {
      setBusy(false);
    }
  }

  async function applyTemplate(templateId: string) {
    if (!snapshot) return;
    setBusy(true);
    setMessage(null);
    try {
      const settings = await api.applyRunnerTemplate(snapshot.project.id, templateId);
      setRolePresets(JSON.stringify(settings.rolePresets, null, 2));
      setAiConnections(normalizeAiConnections(settings.aiConnections));
      setRoleAssignments(normalizeRoleAssignments(settings.roleAssignments));
      await onRefresh();
      setMessage({ tone: "success", text: "runner template 적용됨" });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error, "runner template 적용에 실패했습니다.") });
    } finally {
      setBusy(false);
    }
  }

  async function checkConnection(connection: AiConnection) {
    if (!snapshot) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.checkAiConnection(snapshot.project.id, connection);
      setConnectionChecks((current) => ({ ...current, [connection.id]: result }));
      setMessage({ tone: "info", text: "AI 연결 확인 완료" });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error, "AI 연결 확인에 실패했습니다.") });
    } finally {
      setBusy(false);
    }
  }

  async function checkRunners() {
    if (!snapshot) return;
    setBusy(true);
    setMessage(null);
    try {
      const results = await Promise.all(
        ROLE_DEFINITIONS.map((role) => api.checkRoleRunner(snapshot.project.id, role.roleId)),
      );
      setRunnerChecks(results);
      setMessage({ tone: "info", text: "기존 role preset runner 확인 완료" });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error, "runner 확인에 실패했습니다.") });
    } finally {
      setBusy(false);
    }
  }

  async function checkUpdates() {
    setUpdaterBusy(true);
    setMessage(null);
    try {
      const result = await checkForManualUpdate();
      setCurrentVersion(result.currentVersion);
      setPendingUpdate(result.update);
      setMessage({
        tone: result.update ? "info" : "success",
        text: result.update
          ? `Helm ${result.update.version} 업데이트를 찾았습니다.`
          : "현재 최신 버전입니다.",
      });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error, "업데이트 확인에 실패했습니다.") });
    } finally {
      setUpdaterBusy(false);
    }
  }

  async function installUpdate() {
    if (!pendingUpdate) return;
    setUpdaterBusy(true);
    setMessage({ tone: "info", text: "업데이트 다운로드 및 설치 중…" });
    try {
      await pendingUpdate.install();
      setMessage({ tone: "success", text: "업데이트가 설치되었습니다. 앱을 다시 시작하면 적용됩니다." });
      setPendingUpdate(null);
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error, "업데이트 설치에 실패했습니다.") });
    } finally {
      setUpdaterBusy(false);
    }
  }

  function addConnection(provider: "codex" | "claude") {
    setAiConnections((current) => {
      const candidate = provider === "codex" ? codexConnection() : claudeConnection();
      if (current.some((connection) => connection.id === candidate.id)) return current;
      return [...current, candidate];
    });
    setMessage(null);
  }

  function updateConnection(id: string, patch: Partial<AiConnection>) {
    setAiConnections((current) =>
      current.map((connection) => (connection.id === id ? { ...connection, ...patch } : connection)),
    );
  }

  function removeConnection(id: string) {
    setAiConnections((current) => current.filter((connection) => connection.id !== id));
    setRoleAssignments((current) =>
      normalizeRoleAssignments(current).map((assignment) =>
        withLegacyConnectionIds({
          ...assignment,
          selections: assignment.selections.filter((selection) => selection.connectionId !== id),
        }),
      ),
    );
  }

  function setRoleConnection(roleId: RoleAssignment["roleId"], connectionId: string, checked: boolean) {
    setRoleAssignments((current) =>
      normalizeRoleAssignments(current).map((assignment) => {
        if (assignment.roleId !== roleId) return assignment;
        if (assignment.selectionMode === "single") {
          return withLegacyConnectionIds({
            ...assignment,
            selections: checked
              ? [roleSelection(connectionId, modelForConnection(connectionId, aiConnections))]
              : [],
          });
        }
        const next = checked
          ? upsertSelection(
              assignment.selections,
              roleSelection(connectionId, modelForConnection(connectionId, aiConnections)),
            )
          : assignment.selections.filter((selection) => selection.connectionId !== connectionId);
        return withLegacyConnectionIds({ ...assignment, selections: next });
      }),
    );
  }

  function setRoleModel(roleId: RoleAssignment["roleId"], connectionId: string, model: string) {
    setRoleAssignments((current) =>
      normalizeRoleAssignments(current).map((assignment) => {
        if (assignment.roleId !== roleId) return assignment;
        return withLegacyConnectionIds({
          ...assignment,
          selections: upsertSelection(assignment.selections, roleSelection(connectionId, model.trim() || null)),
        });
      }),
    );
  }

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>설정</h2>
        <p>프로젝트를 열면 runner, worktree, AI 연결 설정이 표시됩니다.</p>
        <div className="settings-actions">
          <button className="secondary-button" disabled={updaterBusy} onClick={checkUpdates} type="button">
            <RefreshCw size={14} aria-hidden />
            {updaterBusy ? "확인 중…" : "업데이트 확인"}
          </button>
        </div>
        {message ? (
          <span className={`settings-status settings-status-${message.tone}`} role="status">
            {message.tone === "success" ? <CheckCircle2 size={14} aria-hidden /> : null}
            {message.tone === "error" ? <XCircle size={14} aria-hidden /> : null}
            {message.text}
          </span>
        ) : null}
        <button className="primary-button" onClick={onOpenProject} type="button">
          프로젝트 열기
        </button>
      </section>
    );
  }

  const activeMeta = CATEGORIES.find((category) => category.id === activeCategory) ?? CATEGORIES[0];

  return (
    <div className="settings-layout">
      <div className="settings-body">
        <aside className="settings-nav">
          <div className="settings-nav-meta">
            <h3>설정</h3>
            <p className="settings-nav-project">{snapshot.project.name}</p>
          </div>
          <ul className="settings-nav-list">
            {CATEGORIES.map((category) => {
              const isActive = category.id === activeCategory;
              const Icon = category.icon;
              return (
                <li key={category.id}>
                  <button
                    type="button"
                    className={isActive ? "settings-nav-item active" : "settings-nav-item"}
                    onClick={() => setActiveCategory(category.id)}
                  >
                    <Icon size={14} aria-hidden />
                    <span className="settings-nav-item-label">
                      <strong>{category.label}</strong>
                      <span>{category.hint}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="settings-canvas">
          <header className="settings-canvas-header">
            <div>
              <h2>{activeMeta.label}</h2>
              <p>{activeMeta.hint}</p>
            </div>
            <div className="settings-canvas-actions">
              {message ? (
                <span className={`settings-status settings-status-${message.tone}`} role="status">
                  {message.tone === "success" ? <CheckCircle2 size={14} aria-hidden /> : null}
                  {message.tone === "error" ? <XCircle size={14} aria-hidden /> : null}
                  {message.text}
                </span>
              ) : null}
              <button className="primary-button" disabled={busy} onClick={save} type="button">
                {busy ? "저장 중…" : "저장"}
              </button>
            </div>
          </header>

          <div className="settings-canvas-body">
            {activeCategory === "templates" ? (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>Runner Templates</h3>
                  <p className="muted">기존 role preset과 새 AI 연결/작업별 선택 기본값을 함께 적용합니다.</p>
                </div>
                {templates.length === 0 ? (
                  <p className="muted">사용 가능한 template이 없습니다.</p>
                ) : (
                  <div className="template-grid">
                    {templates.map((template) => (
                      <article className="template-card" key={template.id}>
                        <div>
                          <strong>{template.label}</strong>
                          <p>{template.description}</p>
                        </div>
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => applyTemplate(template.id)}
                          type="button"
                        >
                          적용
                        </button>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            ) : null}

            {activeCategory === "connections" ? (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>AI 연결</h3>
                  <p className="muted">각 AI 도구를 연결 단위로 등록하고 health check를 확인합니다.</p>
                </div>
                <div className="settings-actions">
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => addConnection("codex")}
                    type="button"
                  >
                    + Codex
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => addConnection("claude")}
                    type="button"
                  >
                    + Claude
                  </button>
                </div>
                <div className="connection-list">
                  {aiConnections.length === 0 ? (
                    <p className="settings-empty">
                      등록된 AI 연결이 없습니다. template을 적용하거나 연결을 추가하세요.
                    </p>
                  ) : (
                    aiConnections.map((connection) => {
                      const check = connectionChecks[connection.id];
                      return (
                        <article className="connection-card" key={connection.id}>
                          <div className="connection-card-header">
                            <label className="toggle-switch">
                              <input
                                checked={connection.enabled}
                                onChange={(event) =>
                                  updateConnection(connection.id, { enabled: event.target.checked })
                                }
                                type="checkbox"
                              />
                              <span className="toggle-switch-track" aria-hidden />
                              <span className="toggle-switch-label">{connection.label}</span>
                            </label>
                            <div className="connection-card-meta">
                              <span className="provider-pill">{connection.provider}</span>
                              {check ? (
                                <span className={check.available ? "check-pass" : "check-fail"}>
                                  {check.available ? "사용 가능" : "확인 필요"}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <div className="connection-fields">
                            <label>
                              <span>이름</span>
                              <input
                                value={connection.label}
                                onChange={(event) =>
                                  updateConnection(connection.id, { label: event.target.value })
                                }
                              />
                            </label>
                            <label>
                              <span>기본 모델</span>
                              <input
                                placeholder={defaultModelPlaceholder(connection.provider)}
                                value={connection.defaultModel ?? ""}
                                onChange={(event) =>
                                  updateConnection(connection.id, {
                                    defaultModel: event.target.value.trim() ? event.target.value.trim() : null,
                                  })
                                }
                              />
                            </label>
                            <label>
                              <span>모델 목록</span>
                              <input
                                placeholder="쉼표로 구분"
                                value={(connection.availableModels ?? []).join(", ")}
                                onChange={(event) =>
                                  updateConnection(connection.id, {
                                    availableModels: splitModelList(event.target.value),
                                  })
                                }
                              />
                            </label>
                            <label>
                              <span>Timeout (s)</span>
                              <input
                                min={1}
                                type="number"
                                value={connection.timeoutSeconds}
                                onChange={(event) =>
                                  updateConnection(connection.id, {
                                    timeoutSeconds: Math.max(1, Number(event.target.value) || 1),
                                  })
                                }
                              />
                            </label>
                          </div>
                          <code className="command-preview">
                            {connection.commandArgs.join(" ") || "command 없음"}
                          </code>
                          {check?.message ? <p className="muted">{check.message}</p> : null}
                          <div className="connection-card-actions">
                            <button
                              className="secondary-button"
                              disabled={busy}
                              onClick={() => checkConnection(connection)}
                              type="button"
                            >
                              연결 확인
                            </button>
                            <button
                              className="secondary-button danger"
                              disabled={busy}
                              onClick={() => removeConnection(connection.id)}
                              type="button"
                            >
                              삭제
                            </button>
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>
              </section>
            ) : null}

            {activeCategory === "assignments" ? (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>작업별 AI 선택</h3>
                  <p className="muted">계획/구현은 단일 선택, 검수/테스트는 다중 선택으로 저장합니다.</p>
                </div>
                {enabledConnections.length === 0 ? (
                  <p className="settings-empty">
                    활성화된 AI 연결이 없습니다. <strong>AI 연결</strong> 탭에서 먼저 등록하세요.
                  </p>
                ) : (
                  <div className="role-assignment-list">
                    {ROLE_DEFINITIONS.map((role) => {
                      const assignment = normalizeRoleAssignments(roleAssignments).find(
                        (item) => item.roleId === role.roleId,
                      );
                      const selections = assignment?.selections ?? [];
                      const selected = selections.map((selection) => selection.connectionId);
                      return (
                        <article className="role-assignment-row" key={role.roleId}>
                          <div>
                            <strong>{role.label}</strong>
                            <span>
                              {role.group}
                              <span className="role-mode-pill">
                                {role.selectionMode === "single" ? "단일" : "다중 · all_pass"}
                              </span>
                            </span>
                          </div>
                          <div className="role-connection-options">
                            {enabledConnections.map((connection) => {
                              const roleModel =
                                selections.find((selection) => selection.connectionId === connection.id)?.model ??
                                connection.defaultModel ??
                                "";
                              const isSelected = selected.includes(connection.id);
                              return (
                                <div className="role-runner-option" key={connection.id}>
                                  <label className="inline-check">
                                    <input
                                      checked={isSelected}
                                      name={`role-${role.roleId}`}
                                      onChange={(event) =>
                                        setRoleConnection(role.roleId, connection.id, event.target.checked)
                                      }
                                      type={role.selectionMode === "single" ? "radio" : "checkbox"}
                                    />
                                    <span>{connection.label}</span>
                                  </label>
                                  {isSelected ? (
                                    <select
                                      aria-label={`${role.label} ${connection.label} 모델`}
                                      value={roleModel}
                                      onChange={(event) => setRoleModel(role.roleId, connection.id, event.target.value)}
                                    >
                                      <option value="">CLI 기본 모델</option>
                                      {modelOptions(connection, roleModel).map((model) => (
                                        <option key={model} value={model}>
                                          {model}
                                        </option>
                                      ))}
                                    </select>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            ) : null}

            {activeCategory === "worktree" ? (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>Worktree</h3>
                  <p className="muted">병렬 작업용 git worktree가 만들어질 디렉터리입니다.</p>
                </div>
                <label className="settings-field">
                  <span>Worktree root</span>
                  <input
                    placeholder="기본값: <repo>/.helm/worktrees"
                    value={worktreeRoot}
                    onChange={(event) => setWorktreeRoot(event.target.value)}
                  />
                  <small className="muted">비워두면 프로젝트 내 <code>.helm/worktrees</code>가 사용됩니다.</small>
                </label>
              </section>
            ) : null}

            {activeCategory === "app" ? (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>앱 업데이트</h3>
                  <p className="muted">자동 확인 대신 필요할 때 Helm updater를 수동으로 실행합니다.</p>
                </div>
                <div className="update-check-panel">
                  <div>
                    <strong>Helm</strong>
                    <span>현재 버전 {currentVersion ?? "확인 전"}</span>
                  </div>
                  <button className="secondary-button" disabled={updaterBusy} onClick={checkUpdates} type="button">
                    <RefreshCw size={14} aria-hidden />
                    {updaterBusy ? "확인 중…" : "업데이트 확인"}
                  </button>
                </div>
                {pendingUpdate ? (
                  <article className="update-card">
                    <div>
                      <strong>새 버전 {pendingUpdate.version}</strong>
                      <span>{pendingUpdate.date ? formatDate(pendingUpdate.date) : "배포일 정보 없음"}</span>
                    </div>
                    {pendingUpdate.body ? <p>{pendingUpdate.body}</p> : null}
                    <button className="primary-button" disabled={updaterBusy} onClick={installUpdate} type="button">
                      <Download size={14} aria-hidden />
                      다운로드 및 설치
                    </button>
                  </article>
                ) : null}
              </section>
            ) : null}

            {activeCategory === "advanced" ? (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>고급</h3>
                  <p className="muted">일반적으로 template과 AI 연결 탭만으로 충분합니다.</p>
                </div>
                <details className="settings-disclosure">
                  <summary>Role presets JSON 직접 편집</summary>
                  <p className="muted">기존 host runner 호환을 위해 JSON 편집을 유지합니다.</p>
                  <label className="settings-field">
                    <span>Role presets</span>
                    <textarea
                      spellCheck={false}
                      value={rolePresets}
                      onChange={(event) => setRolePresets(event.target.value)}
                    />
                  </label>
                </details>
                <details className="settings-disclosure">
                  <summary>기존 runner health check</summary>
                  <p className="muted">role preset에 등록된 명령이 현재 실행 가능한지 확인합니다.</p>
                  <button className="secondary-button" disabled={busy} onClick={checkRunners} type="button">
                    runner 확인
                  </button>
                  {runnerChecks.length > 0 ? (
                    <ul className="runner-check-list">
                      {runnerChecks.map((check) => (
                        <li key={check.roleId}>
                          <span className={check.available ? "check-pass" : "check-fail"}>
                            {check.available ? "사용 가능" : "확인 필요"}
                          </span>
                          <strong>{roleLabel(check.roleId)}</strong>
                          <span>{check.message}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </details>
              </section>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function normalizeAiConnections(value: unknown): AiConnection[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Partial<AiConnection> => typeof item === "object" && item !== null)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
      label: typeof item.label === "string" ? item.label : "AI 연결",
      provider: typeof item.provider === "string" ? item.provider : "custom",
      commandArgs: Array.isArray(item.commandArgs) ? item.commandArgs.filter(isString) : [],
      healthCheckArgs: Array.isArray(item.healthCheckArgs) ? item.healthCheckArgs.filter(isString) : undefined,
      timeoutSeconds: typeof item.timeoutSeconds === "number" ? item.timeoutSeconds : 1800,
      enabled: typeof item.enabled === "boolean" ? item.enabled : true,
      defaultModel: typeof item.defaultModel === "string" ? item.defaultModel : null,
      availableModels: Array.isArray(item.availableModels) ? item.availableModels.filter(isString) : [],
      defaultEffort: typeof item.defaultEffort === "string" ? item.defaultEffort : null,
    }));
}

function normalizeRoleAssignments(value: unknown): RoleAssignment[] {
  const incoming = Array.isArray(value) ? value : [];
  return ROLE_DEFINITIONS.map((role) => {
    const match = incoming.find(
      (item) => typeof item === "object" && item !== null && (item as { roleId?: unknown }).roleId === role.roleId,
    ) as Partial<RoleAssignment> | undefined;
    const selections = normalizeSelections(match);
    return {
      roleId: role.roleId,
      selectionMode: role.selectionMode,
      selections,
      connectionIds: selections.map((selection) => selection.connectionId),
      aggregationPolicy: role.selectionMode === "multiple" ? "all_pass" : null,
    };
  });
}

function normalizeSelections(assignment: Partial<RoleAssignment> | undefined) {
  if (Array.isArray(assignment?.selections)) {
    return assignment.selections
      .filter((item) => typeof item === "object" && item !== null && typeof item.connectionId === "string")
      .map((item) => ({
        connectionId: item.connectionId,
        model: typeof item.model === "string" ? item.model : null,
        effort: typeof item.effort === "string" ? item.effort : null,
      }));
  }
  if (!Array.isArray(assignment?.connectionIds)) return [];
  return assignment.connectionIds.filter(isString).map((connectionId) => ({
    connectionId,
    model: null,
    effort: null,
  }));
}

function withLegacyConnectionIds(assignment: RoleAssignment): RoleAssignment {
  return {
    ...assignment,
    connectionIds: assignment.selections.map((selection) => selection.connectionId),
  };
}

function roleSelection(connectionId: string, model?: string | null) {
  return { connectionId, model: model ?? null, effort: null };
}

function upsertSelection<T extends { connectionId: string }>(items: T[], next: T): T[] {
  const without = items.filter((item) => item.connectionId !== next.connectionId);
  return [...without, next];
}

function modelForConnection(connectionId: string, connections: AiConnection[]): string | null {
  return connections.find((connection) => connection.id === connectionId)?.defaultModel ?? null;
}

function splitModelList(raw: string): string[] {
  return Array.from(new Set(raw.split(",").map((item) => item.trim()).filter(Boolean)));
}

function defaultModelPlaceholder(provider: string): string {
  if (provider === "codex") return "예: gpt-5.2";
  if (provider === "claude") return "예: sonnet";
  return "선택 사항";
}

function modelOptions(connection: AiConnection, selectedModel: string): string[] {
  return Array.from(
    new Set([...(connection.availableModels ?? []), connection.defaultModel ?? "", selectedModel].filter(Boolean)),
  );
}

function codexConnection(): AiConnection {
  return {
    id: "codex-local",
    label: "Codex CLI",
    provider: "codex",
    commandArgs: [
      "codex",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--cd",
      "{worktreePath}",
      "--",
      "Read {contextPackPath}, perform the {roleId} role, then write {summaryPath} and {resultPath} following {schemaPath}.",
    ],
    healthCheckArgs: ["codex", "--version"],
    timeoutSeconds: 1800,
    enabled: true,
    defaultModel: "gpt-5.2",
    availableModels: ["gpt-5.2", "gpt-5.4", "gpt-5.4-mini"],
  };
}

function claudeConnection(): AiConnection {
  return {
    id: "claude-local",
    label: "Claude CLI",
    provider: "claude",
    commandArgs: [
      "claude",
      "-p",
      "Read {contextPackPath}, perform the {roleId} role, then write {summaryPath} and {resultPath} following {schemaPath}.",
    ],
    healthCheckArgs: ["claude", "--version"],
    timeoutSeconds: 1800,
    enabled: true,
    defaultModel: "sonnet",
    availableModels: ["sonnet", "opus"],
  };
}

function roleLabel(roleId: string): string {
  const labels: Record<string, string> = {
    planner: "설계자",
    coder: "구현자",
    plan_verifier: "계획 검토자",
    code_reviewer: "코드 리뷰어",
    tester: "테스트 담당자",
  };
  return labels[roleId] ?? roleId;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}
