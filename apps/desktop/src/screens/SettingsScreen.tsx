import {
  BrainCircuit,
  CheckCircle2,
  Download,
  FolderTree,
  Info,
  Layers,
  Loader2,
  Plug,
  RefreshCw,
  Workflow,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useToast } from "../components/ToastProvider";
import { api } from "../lib/api";
import { roleLabel, runnerReadinessFor } from "../lib/runnerReadiness";
import { checkForManualUpdate, type ManualUpdateInfo } from "../lib/updater";
import type {
  AiConnection,
  AiConnectionCheckResult,
  AppSettings,
  ConductorConfig,
  JiraConfig,
  OrchestratorSettings,
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

type SettingsCategory =
  | "orchestrator"
  | "templates"
  | "connections"
  | "assignments"
  | "jira"
  | "worktree"
  | "app"
  | "advanced";

const CATEGORIES: Array<{
  id: SettingsCategory;
  label: string;
  hint: string;
  icon: typeof Layers;
}> = [
  { id: "orchestrator", label: "오케스트레이터", hint: "모든 프로젝트에 적용되는 지휘자 AI", icon: BrainCircuit },
  { id: "templates", label: "Runner Templates", hint: "역할 프리셋과 AI CLI 연결을 한 번에 적용", icon: Layers },
  { id: "connections", label: "AI CLI 연결", hint: "Codex · Claude Code · Gemini · 기타 LLM 경로", icon: Plug },
  { id: "assignments", label: "작업별 CLI 선택", hint: "계획 · 구현 · 검수 · 테스트 매핑", icon: Workflow },
  { id: "jira", label: "Jira", hint: "프로젝트 키와 기본 이슈 타입", icon: CheckCircle2 },
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
type ModelRefreshState = { busy: boolean; tone: MessageTone; message: string };

export function SettingsScreen({ snapshot, onRefresh, onOpenProject }: SettingsScreenProps) {
  const { showToast } = useToast();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("orchestrator");
  const [appSettings, setAppSettings] = useState<AppSettings>(() => emptyAppSettings());
  const [appSettingsBusy, setAppSettingsBusy] = useState(false);
  const [appSettingsLoaded, setAppSettingsLoaded] = useState(false);
  const [orchestratorCheck, setOrchestratorCheck] = useState<AiConnectionCheckResult | null>(null);
  const [orchestratorCheckBusy, setOrchestratorCheckBusy] = useState(false);
  const [orchestratorModelRefresh, setOrchestratorModelRefresh] = useState<ModelRefreshState | null>(null);
  const [rolePresets, setRolePresets] = useState("");
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [worktreeSetup, setWorktreeSetup] = useState("");
  const [templates, setTemplates] = useState<RunnerTemplateSummary[]>([]);
  const [runnerChecks, setRunnerChecks] = useState<RunnerCheckResult[]>([]);
  const [connectionChecks, setConnectionChecks] = useState<Record<string, AiConnectionCheckResult>>({});
  const [connectionCheckBusyId, setConnectionCheckBusyId] = useState<string | null>(null);
  const [modelRefreshes, setModelRefreshes] = useState<Record<string, ModelRefreshState>>({});
  const [aiConnections, setAiConnections] = useState<AiConnection[]>([]);
  const [roleAssignments, setRoleAssignments] = useState<RoleAssignment[]>([]);
  const [conductorConfig, setConductorConfig] = useState<ConductorConfig>(emptyConductorConfig());
  const [jiraConfig, setJiraConfig] = useState<JiraConfig>(emptyJiraConfig());
  const [busy, setBusy] = useState(false);
  const [updaterBusy, setUpdaterBusy] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<ManualUpdateInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadAppSettings() {
      try {
        const settings = await api.getAppSettings();
        if (!cancelled) {
          setAppSettings(normalizeAppSettings(settings));
        }
      } catch (error) {
        if (!cancelled) {
          showToast({
            tone: "error",
            title: "전역 설정 로드 실패",
            description: errorMessage(error, "전역 설정을 읽지 못했습니다."),
          });
        }
      } finally {
        if (!cancelled) {
          setAppSettingsLoaded(true);
        }
      }
    }

    void loadAppSettings();
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  useEffect(() => {
    if (!snapshot) return;
    setRolePresets(JSON.stringify(snapshot.settings.rolePresets, null, 2));
    setAiConnections(normalizeAiConnections(snapshot.settings.aiConnections));
    setRoleAssignments(normalizeRoleAssignments(snapshot.settings.roleAssignments));
    setConductorConfig(normalizeConductorConfig(snapshot.settings.conductorConfig));
    setJiraConfig(normalizeJiraConfig(snapshot.settings.jiraConfig));
    setWorktreeRoot(snapshot.settings.worktreeRoot ?? "");
    setWorktreeSetup(snapshot.settings.worktreeSetup ? JSON.stringify(snapshot.settings.worktreeSetup, null, 2) : "");
    void api.listRunnerTemplates(snapshot.project.id).then(setTemplates);
    setRunnerChecks([]);
    setConnectionChecks({});
    setConnectionCheckBusyId(null);
    setModelRefreshes({});
  }, [snapshot]);

  const visibleCategories = useMemo(
    () => (snapshot ? CATEGORIES : CATEGORIES.filter((category) => category.id === "orchestrator" || category.id === "app")),
    [snapshot],
  );

  useEffect(() => {
    if (!visibleCategories.some((category) => category.id === activeCategory)) {
      setActiveCategory("orchestrator");
    }
  }, [activeCategory, visibleCategories]);

  const enabledConnections = useMemo(
    () => aiConnections.filter((connection) => connection.enabled),
    [aiConnections],
  );
  const parsedRolePresets = useMemo(() => parseRolePresets(rolePresets), [rolePresets]);
  const runnerOnboarding = useMemo(() => {
    if (!snapshot) return [];
    const effectiveSettings = {
      ...snapshot.settings,
      rolePresets: parsedRolePresets ?? snapshot.settings.rolePresets,
      aiConnections,
      roleAssignments: normalizeRoleAssignments(roleAssignments),
    };
    return ROLE_DEFINITIONS.map((role) => ({
      ...role,
      readiness: runnerReadinessFor(effectiveSettings, role.roleId),
    }));
  }, [aiConnections, parsedRolePresets, roleAssignments, snapshot]);
  const readyRunnerCount = runnerOnboarding.filter((item) => item.readiness.ready).length;

  async function save() {
    if (!snapshot) return;
    setBusy(true);
    try {
      const parsedRolePresets = JSON.parse(rolePresets);
      const parsedWorktreeSetup = worktreeSetup.trim() ? JSON.parse(worktreeSetup) : null;
      await api.updateProjectSettings(snapshot.project.id, {
        rolePresets: parsedRolePresets,
        aiConnections,
        roleAssignments: normalizeRoleAssignments(roleAssignments),
        worktreeRoot: worktreeRoot.trim() ? worktreeRoot.trim() : null,
        worktreeSetup: parsedWorktreeSetup,
        jiraConfig: normalizeJiraConfig(jiraConfig),
      });
      await onRefresh();
      showToast({
        tone: "success",
        title: "설정 저장 완료",
        description: "변경한 설정이 저장되었습니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "설정 저장 실패",
        description: error instanceof Error ? error.message : "설정 저장에 실패했습니다.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function saveAppSettings() {
    setAppSettingsBusy(true);
    try {
      const saved = await api.updateAppSettings(normalizeAppSettings(appSettings));
      setAppSettings(normalizeAppSettings(saved));
      showToast({
        tone: "success",
        title: "전역 오케스트레이터 저장 완료",
        description: "모든 프로젝트에 적용될 지휘자 AI 설정을 저장했습니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "전역 설정 저장 실패",
        description: errorMessage(error, "전역 설정 저장에 실패했습니다."),
      });
    } finally {
      setAppSettingsBusy(false);
    }
  }

  async function saveActiveSettings() {
    if (activeCategory === "orchestrator") {
      await saveAppSettings();
      return;
    }
    await save();
  }

  async function applyTemplate(templateId: string) {
    if (!snapshot) return;
    setBusy(true);
    try {
      const settings = await api.applyRunnerTemplate(snapshot.project.id, templateId);
      setRolePresets(JSON.stringify(settings.rolePresets, null, 2));
      setAiConnections(normalizeAiConnections(settings.aiConnections));
      setRoleAssignments(normalizeRoleAssignments(settings.roleAssignments));
      setConductorConfig(normalizeConductorConfig(settings.conductorConfig));
      await onRefresh();
      showToast({
        tone: "success",
        title: "Runner Template 적용 완료",
        description: "역할 프리셋과 AI CLI 기본값을 반영했습니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "Runner Template 적용 실패",
        description: errorMessage(error, "runner template 적용에 실패했습니다."),
      });
    } finally {
      setBusy(false);
    }
  }

  async function refreshConnectionModels(connection: AiConnection, options: { silent?: boolean } = {}) {
    if (!snapshot || !canRefreshModels(connection.provider)) return;
    setModelRefreshes((current) => ({
      ...current,
      [connection.id]: { busy: true, tone: "info", message: "모델 목록 확인 중..." },
    }));
    try {
      const result = await api.refreshAiConnectionModels(snapshot.project.id, connection);
      const models = result.availableModels ?? [];
      if (models.length) {
        setAiConnections((current) =>
          current.map((item) =>
            item.id === connection.id
              ? {
                  ...item,
                  availableModels: mergeModelLists(item.provider, item.availableModels ?? [], models),
                }
              : item,
          ),
        );
      }
      const tone: MessageTone = models.length ? "success" : "info";
      setModelRefreshes((current) => ({
        ...current,
        [connection.id]: { busy: false, tone, message: result.message },
      }));
      if (!options.silent) {
        showToast({
          tone,
          title: models.length ? "모델 목록 확인 완료" : "모델 목록 확인 결과",
          description: result.message,
        });
      }
    } catch (error) {
      const text = errorMessage(error, "모델 목록을 불러오지 못했습니다.");
      setModelRefreshes((current) => ({
        ...current,
        [connection.id]: { busy: false, tone: "error", message: text },
      }));
      if (!options.silent) {
        showToast({
          tone: "error",
          title: "모델 목록 확인 실패",
          description: text,
        });
      }
    }
  }

  async function refreshOrchestratorModels(options: { silent?: boolean } = {}) {
    const connection = appSettings.orchestrator.connection;
    if (!connection || !canRefreshModels(connection.provider)) return;
    setOrchestratorModelRefresh({ busy: true, tone: "info", message: "모델 목록 확인 중..." });
    try {
      const result = await api.refreshOrchestratorConnectionModels(connection);
      const models = result.availableModels ?? [];
      if (models.length) {
        updateOrchestratorConnection({
          availableModels: mergeModelLists(connection.provider, connection.availableModels ?? [], models),
        });
      }
      const tone: MessageTone = models.length ? "success" : "info";
      setOrchestratorModelRefresh({ busy: false, tone, message: result.message });
      if (!options.silent) {
        showToast({
          tone,
          title: models.length ? "모델 목록 확인 완료" : "모델 목록 확인 결과",
          description: result.message,
        });
      }
    } catch (error) {
      const text = errorMessage(error, "모델 목록을 불러오지 못했습니다.");
      setOrchestratorModelRefresh({ busy: false, tone: "error", message: text });
      if (!options.silent) {
        showToast({
          tone: "error",
          title: "모델 목록 확인 실패",
          description: text,
        });
      }
    }
  }

  async function checkConnection(connection: AiConnection) {
    if (!snapshot) return;
    if (connectionCheckBusyId) return;
    setConnectionCheckBusyId(connection.id);
    try {
      const result = await api.checkAiConnection(snapshot.project.id, connection);
      setConnectionChecks((current) => ({ ...current, [connection.id]: result }));
      if (result.availableModels?.length) {
        setAiConnections((current) =>
          current.map((item) =>
            item.id === connection.id
              ? {
                  ...item,
                  availableModels: mergeModelLists(
                    item.provider,
                    item.availableModels ?? [],
                    result.availableModels ?? [],
                  ),
                }
              : item,
          ),
        );
      }
      if (result.modelRefreshMessage) {
        setModelRefreshes((current) => ({
          ...current,
          [connection.id]: {
            busy: false,
            tone: result.availableModels?.length ? "success" : "info",
            message: result.modelRefreshMessage ?? "",
          },
        }));
      }
      showToast({
        tone: result.available ? "success" : "error",
        title: result.available ? "AI CLI 연동 확인 완료" : "AI CLI 연동 확인 실패",
        description: result.available ? "AI CLI smoke 실행을 확인했습니다." : result.message || "AI CLI 실행 확인 실패",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "AI CLI 연동 확인 실패",
        description: errorMessage(error, "AI CLI 확인에 실패했습니다."),
      });
    } finally {
      setConnectionCheckBusyId(null);
    }
  }

  async function checkOrchestratorConnection() {
    const connection = appSettings.orchestrator.connection;
    if (!connection || orchestratorCheckBusy) return;
    setOrchestratorCheckBusy(true);
    try {
      const result = await api.checkOrchestratorConnection(connection);
      setOrchestratorCheck(result);
      if (result.availableModels?.length) {
        updateOrchestratorConnection({
          availableModels: mergeModelLists(
            connection.provider,
            connection.availableModels ?? [],
            result.availableModels ?? [],
          ),
        });
      }
      if (result.modelRefreshMessage) {
        setOrchestratorModelRefresh({
          busy: false,
          tone: result.availableModels?.length ? "success" : "info",
          message: result.modelRefreshMessage,
        });
      }
      showToast({
        tone: result.available ? "success" : "error",
        title: result.available ? "오케스트레이터 연동 확인 완료" : "오케스트레이터 연동 확인 실패",
        description: result.available ? "AI CLI smoke 실행을 확인했습니다." : result.message || "AI CLI 실행 확인 실패",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "오케스트레이터 연동 확인 실패",
        description: errorMessage(error, "AI CLI 확인에 실패했습니다."),
      });
    } finally {
      setOrchestratorCheckBusy(false);
    }
  }

  async function checkRunners() {
    if (!snapshot) return;
    setBusy(true);
    try {
      const results = await Promise.all(
        ROLE_DEFINITIONS.map((role) => api.checkRoleRunner(snapshot.project.id, role.roleId)),
      );
      setRunnerChecks(results);
      showToast({
        tone: "info",
        title: "Runner 확인 완료",
        description: "기존 role preset runner 상태를 확인했습니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "Runner 확인 실패",
        description: errorMessage(error, "runner 확인에 실패했습니다."),
      });
    } finally {
      setBusy(false);
    }
  }

  async function checkUpdates() {
    setUpdaterBusy(true);
    try {
      const result = await checkForManualUpdate();
      setCurrentVersion(result.currentVersion);
      setPendingUpdate(result.update);
      if (result.unavailableReason) {
        showToast({
          tone: "info",
          title: "업데이트 확인 불가",
          description: result.unavailableReason,
        });
        return;
      }
      showToast({
        tone: result.update ? "info" : "success",
        title: result.update ? "업데이트 발견" : "최신 버전",
        description: result.update ? `Helm ${result.update.version} 업데이트를 찾았습니다.` : "현재 최신 버전입니다.",
      });
    } catch (error) {
      showToast({
        tone: "error",
        title: "업데이트 확인 실패",
        description: errorMessage(error, "업데이트 확인에 실패했습니다."),
      });
    } finally {
      setUpdaterBusy(false);
    }
  }

  async function installUpdate() {
    if (!pendingUpdate) return;
    setUpdaterBusy(true);
    showToast({
      tone: "info",
      title: "업데이트 설치 중",
      description: "업데이트를 다운로드하고 설치합니다.",
    });
    try {
      await pendingUpdate.install();
      showToast({
        tone: "success",
        title: "업데이트 설치 완료",
        description: "앱을 다시 시작하면 적용됩니다.",
      });
      setPendingUpdate(null);
    } catch (error) {
      showToast({
        tone: "error",
        title: "업데이트 설치 실패",
        description: errorMessage(error, "업데이트 설치에 실패했습니다."),
      });
    } finally {
      setUpdaterBusy(false);
    }
  }

  function addConnection(provider: "codex" | "claude" | "gemini" | "custom") {
    const candidate =
      provider === "custom"
        ? customConnection(nextCustomConnectionId())
        : nextProviderConnection(provider, aiConnections);
    setAiConnections((current) => {
      return [...current, candidate];
    });
    setModelRefreshes((current) => {
      const next = { ...current };
      delete next[candidate.id];
      return next;
    });
  }

  function setOrchestratorConnectionProvider(provider: "codex" | "claude" | "gemini" | "custom") {
    const connection =
      provider === "codex"
        ? codexConnection()
        : provider === "claude"
          ? claudeConnection()
          : provider === "gemini"
            ? geminiConnection()
            : customConnection("orchestrator-custom");
    setAppSettings((current) =>
      normalizeAppSettings({
        ...current,
        orchestrator: {
          ...current.orchestrator,
          enabled: true,
          connection,
          model: connection.defaultModel ?? null,
        },
      }),
    );
    setOrchestratorCheck(null);
    setOrchestratorModelRefresh(null);
  }

  function updateOrchestrator(patch: Partial<OrchestratorSettings>) {
    setAppSettings((current) =>
      normalizeAppSettings({
        ...current,
        orchestrator: {
          ...current.orchestrator,
          ...patch,
        },
      }),
    );
  }

  function updateOrchestratorConnection(patch: Partial<AiConnection>) {
    setAppSettings((current) => {
      const connection = current.orchestrator.connection;
      if (!connection) return current;
      return normalizeAppSettings({
        ...current,
        orchestrator: {
          ...current.orchestrator,
          connection: { ...connection, ...patch },
        },
      });
    });
  }

  function updateOrchestratorCliPath(cliPath: string) {
    const connection = appSettings.orchestrator.connection;
    if (!connection) return;
    updateOrchestratorConnection(connectionWithCliPath(connection, cliPath));
  }

  function clearOrchestratorConnection() {
    updateOrchestrator({ enabled: false, mode: "observe", connection: null, model: null });
    setOrchestratorCheck(null);
    setOrchestratorModelRefresh(null);
  }

  function importLegacyConductor() {
    const connectionId = conductorConfig.connectionId;
    if (!connectionId) return;
    const connection = aiConnections.find((item) => item.id === connectionId);
    if (!connection) return;
    setAppSettings((current) =>
      normalizeAppSettings({
        ...current,
        orchestrator: {
          enabled: true,
          mode: conductorConfig.mode === "gate" ? "gate" : "observe",
          connection,
          model: conductorConfig.model ?? connection.defaultModel ?? null,
        },
      }),
    );
    setOrchestratorCheck(null);
    setOrchestratorModelRefresh(null);
    showToast({
      tone: "success",
      title: "프로젝트 지휘자 설정 가져옴",
      description: "저장하면 이 설정이 모든 프로젝트에 적용됩니다.",
    });
  }

  function updateConnection(id: string, patch: Partial<AiConnection>) {
    setAiConnections((current) =>
      current.map((connection) => (connection.id === id ? { ...connection, ...patch } : connection)),
    );
  }

  function updateConnectionCliPath(connection: AiConnection, cliPath: string) {
    updateConnection(connection.id, connectionWithCliPath(connection, cliPath));
  }

  function removeConnection(id: string) {
    setAiConnections((current) => current.filter((connection) => connection.id !== id));
    setModelRefreshes((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
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

  function updateJiraConfig(patch: Partial<JiraConfig>) {
    setJiraConfig((current) => normalizeJiraConfig({ ...current, ...patch }));
  }

  const activeMeta = visibleCategories.find((category) => category.id === activeCategory) ?? CATEGORIES[0];
  const activeSaveBusy = activeCategory === "orchestrator" ? appSettingsBusy : busy;
  const canSaveActiveSettings = activeCategory === "orchestrator" || (Boolean(snapshot) && activeCategory !== "app");
  const orchestrator = appSettings.orchestrator;
  const orchestratorConnection = orchestrator.connection;
  const orchestratorModelList = orchestratorConnection?.availableModels ?? [];
  const showOrchestratorModelSkeleton =
    Boolean(orchestratorModelRefresh?.busy) && orchestratorModelList.length === 0;
  const conductorConnection =
    conductorConfig.connectionId ? aiConnections.find((connection) => connection.id === conductorConfig.connectionId) : null;
  const canImportLegacyConductor =
    Boolean(snapshot) &&
    conductorConfig.enabled &&
    Boolean(conductorConnection) &&
    !orchestratorSettingsConfigured(orchestrator);

  return (
    <div className="settings-layout">
      <div className="settings-body">
        <aside className="settings-nav">
          <div className="settings-nav-meta">
            <h3>설정</h3>
            <p className="settings-nav-project">{snapshot ? snapshot.project.name : "전역 설정"}</p>
          </div>
          <ul className="settings-nav-list">
            {visibleCategories.map((category) => {
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
              {canSaveActiveSettings ? (
                <button
                  className="primary-button"
                  disabled={activeSaveBusy}
                  onClick={saveActiveSettings}
                  type="button"
                >
                  {activeSaveBusy ? "저장 중…" : activeCategory === "orchestrator" ? "전역 저장" : "저장"}
                </button>
              ) : null}
            </div>
          </header>

          <div className="settings-canvas-body">
            {activeCategory === "orchestrator" ? (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>전역 오케스트레이터</h3>
                  <p className="muted">
                    다음 단계 복구는 Helm supervisor가 맡고, 지휘자 AI는 queued run 시작 전 기록 또는 확인만 맡습니다.
                  </p>
                </div>
                {!appSettingsLoaded ? (
                  <p className="settings-empty">전역 설정을 불러오는 중입니다.</p>
                ) : (
                  <>
                    <div className="runner-onboarding-panel">
                      <div className="runner-onboarding-summary">
                        <div>
                          <strong>적용 범위</strong>
                          <span>이 설정은 현재 프로젝트가 아니라 Helm 앱 전체에 저장됩니다.</span>
                        </div>
                        <span className={orchestrator.enabled && orchestratorConnection ? "check-pass" : "check-info"}>
                          {orchestrator.enabled && orchestratorConnection ? "전역 적용" : "꺼짐"}
                        </span>
                      </div>
                    </div>

                    {canImportLegacyConductor ? (
                      <div className="settings-empty">
                        <strong>현재 프로젝트에 기존 지휘자 설정이 있습니다.</strong>
                        <span>전역 오케스트레이터로 가져오면 다른 프로젝트에서도 같은 설정을 사용합니다.</span>
                        <button className="secondary-button" onClick={importLegacyConductor} type="button">
                          전역으로 가져오기
                        </button>
                      </div>
                    ) : null}

                    <label className="toggle-switch">
                      <input
                        checked={orchestrator.enabled}
                        disabled={!orchestratorConnection}
                        onChange={(event) => updateOrchestrator({ enabled: event.target.checked })}
                        type="checkbox"
                      />
                      <span className="toggle-switch-track" aria-hidden />
                      <span className="toggle-switch-label">오케스트레이터 사용</span>
                    </label>

                    <div className="settings-actions">
                      <button
                        className="secondary-button"
                        disabled={appSettingsBusy}
                        onClick={() => setOrchestratorConnectionProvider("codex")}
                        type="button"
                      >
                        Codex 사용
                      </button>
                      <button
                        className="secondary-button"
                        disabled={appSettingsBusy}
                        onClick={() => setOrchestratorConnectionProvider("claude")}
                        type="button"
                      >
                        Claude Code 사용
                      </button>
                      <button
                        className="secondary-button"
                        disabled={appSettingsBusy}
                        onClick={() => setOrchestratorConnectionProvider("gemini")}
                        type="button"
                      >
                        Gemini 사용
                      </button>
                      <button
                        className="secondary-button"
                        disabled={appSettingsBusy}
                        onClick={() => setOrchestratorConnectionProvider("custom")}
                        type="button"
                      >
                        기타 CLI 사용
                      </button>
                    </div>

                    {!orchestratorConnection ? (
                      <p className="settings-empty">오케스트레이터에 사용할 AI CLI를 선택하세요.</p>
                    ) : (
                      <article
                        aria-busy={orchestratorCheckBusy || orchestratorModelRefresh?.busy ? true : undefined}
                        className={
                          orchestratorCheckBusy || orchestratorModelRefresh?.busy
                            ? "connection-card is-loading"
                            : "connection-card"
                        }
                      >
                        <div className="connection-card-header">
                          <div>
                            <strong>{orchestratorConnection.label}</strong>
                            <p className="muted">전역 지휘자 AI 연결</p>
                          </div>
                          <div className="connection-card-meta">
                            <span className="provider-pill">{providerLabel(orchestratorConnection.provider)}</span>
                            {orchestratorCheck ? (
                              <span className={orchestratorCheck.available ? "check-pass" : "check-fail"}>
                                {orchestratorCheck.available ? "프롬프트 OK" : "확인 필요"}
                              </span>
                            ) : null}
                            {orchestratorModelRefresh?.busy ? <span className="check-info">모델 확인 중</span> : null}
                          </div>
                        </div>
                        <div className="connection-fields">
                          <label>
                            <span>이름</span>
                            <input
                              value={orchestratorConnection.label}
                              onChange={(event) => updateOrchestratorConnection({ label: event.target.value })}
                            />
                          </label>
                          <label>
                            <span>LLM 경로</span>
                            <input
                              placeholder={cliPathPlaceholder(orchestratorConnection.provider)}
                              value={connectionCliPath(orchestratorConnection)}
                              onChange={(event) => updateOrchestratorCliPath(event.target.value)}
                            />
                          </label>
                          <label>
                            <span>기본 모델</span>
                            <input
                              placeholder={defaultModelPlaceholder(orchestratorConnection.provider)}
                              value={orchestratorConnection.defaultModel ?? ""}
                              onChange={(event) =>
                                updateOrchestratorConnection({
                                  defaultModel: event.target.value.trim() ? event.target.value.trim() : null,
                                })
                              }
                            />
                          </label>
                          <label aria-busy={orchestratorModelRefresh?.busy ? true : undefined}>
                            <span>모델 목록</span>
                            {showOrchestratorModelSkeleton ? (
                              <ModelListSkeleton />
                            ) : (
                              <input
                                placeholder="쉼표로 구분"
                                value={orchestratorModelList.join(", ")}
                                onChange={(event) =>
                                  updateOrchestratorConnection({
                                    availableModels: splitModelList(event.target.value),
                                  })
                                }
                              />
                            )}
                          </label>
                          <label>
                            <span>모드</span>
                            <select
                              value={orchestrator.mode}
                              onChange={(event) => updateOrchestrator({ mode: event.target.value })}
                            >
                              <option value="observe">기록만</option>
                              <option value="gate">실행 전 확인</option>
                            </select>
                          </label>
                          <label>
                            <span>사용 모델</span>
                            <select
                              value={orchestrator.model ?? ""}
                              onChange={(event) => updateOrchestrator({ model: event.target.value.trim() || null })}
                            >
                              <option value="">CLI 기본 모델</option>
                              {modelOptions(orchestratorConnection, orchestrator.model ?? "").map((model) => (
                                <option key={model} value={model}>
                                  {model}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="connection-env-field">
                            <span>환경 변수</span>
                            <textarea
                              placeholder={envPlaceholder(orchestratorConnection.provider)}
                              rows={3}
                              value={formatConnectionEnv(orchestratorConnection.env)}
                              onChange={(event) =>
                                updateOrchestratorConnection({
                                  env: parseConnectionEnv(event.target.value),
                                })
                              }
                            />
                          </label>
                        </div>
                        <code className="command-preview">
                          확인/계획: {(orchestratorConnection.planningCommandArgs ?? []).join(" ") || "command 없음"}
                        </code>
                        {orchestratorCheck?.message ? <p className="muted">{orchestratorCheck.message}</p> : null}
                        {orchestratorCheck?.modelRefreshMessage ? (
                          <p className="muted">{orchestratorCheck.modelRefreshMessage}</p>
                        ) : null}
                        {!orchestratorCheck?.modelRefreshMessage && orchestratorModelRefresh?.message ? (
                          <p className={`model-refresh-message model-refresh-message-${orchestratorModelRefresh.tone}`}>
                            {orchestratorModelRefresh.message}
                          </p>
                        ) : null}
                        <div className="connection-card-actions">
                          {canRefreshModels(orchestratorConnection.provider) ? (
                            <button
                              aria-busy={orchestratorModelRefresh?.busy ? true : undefined}
                              className={
                                orchestratorModelRefresh?.busy
                                  ? "secondary-button loading-button is-loading"
                                  : "secondary-button loading-button"
                              }
                              disabled={Boolean(orchestratorModelRefresh?.busy) || orchestratorCheckBusy}
                              onClick={() => refreshOrchestratorModels()}
                              type="button"
                            >
                              <RefreshCw
                                className={orchestratorModelRefresh?.busy ? "loading-icon" : undefined}
                                size={14}
                                aria-hidden
                              />
                              {orchestratorModelRefresh?.busy ? "불러오는 중..." : "모델 불러오기"}
                            </button>
                          ) : null}
                          <button
                            aria-busy={orchestratorCheckBusy ? true : undefined}
                            className={
                              orchestratorCheckBusy
                                ? "secondary-button loading-button is-loading"
                                : "secondary-button loading-button"
                            }
                            disabled={orchestratorCheckBusy || Boolean(orchestratorModelRefresh?.busy)}
                            onClick={checkOrchestratorConnection}
                            type="button"
                          >
                            {orchestratorCheckBusy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
                            {orchestratorCheckBusy ? "확인 중..." : "연동 확인"}
                          </button>
                          <button
                            className="secondary-button danger"
                            disabled={appSettingsBusy || orchestratorCheckBusy || Boolean(orchestratorModelRefresh?.busy)}
                            onClick={clearOrchestratorConnection}
                            type="button"
                          >
                            연결 제거
                          </button>
                        </div>
                      </article>
                    )}
                  </>
                )}
              </section>
            ) : null}

            {activeCategory === "templates" ? (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>Runner Templates</h3>
                  <p className="muted">기존 role preset과 새 AI CLI command/작업별 선택 기본값을 함께 적용합니다.</p>
                </div>
                <div className="runner-onboarding-panel">
                  <div className="runner-onboarding-summary">
                    <div>
                      <strong>Runner 준비 상태</strong>
                      <span>
                        {readyRunnerCount}/{ROLE_DEFINITIONS.length} 역할 준비됨 · 활성 CLI 연결 {enabledConnections.length}개
                      </span>
                    </div>
                    <span className={readyRunnerCount === ROLE_DEFINITIONS.length ? "check-pass" : "check-fail"}>
                      {readyRunnerCount === ROLE_DEFINITIONS.length ? "준비 완료" : "설정 필요"}
                    </span>
                  </div>
                  <ul className="runner-onboarding-roles">
                    {runnerOnboarding.map((item) => (
                      <li key={item.roleId}>
                        <span className={item.readiness.ready ? "check-pass" : "check-fail"}>
                          {item.readiness.ready ? "ready" : "missing"}
                        </span>
                        <strong>{item.label}</strong>
                        <span>{item.readiness.ready ? item.readiness.label : item.readiness.description}</span>
                      </li>
                    ))}
                  </ul>
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
                  <h3>AI CLI 연결</h3>
                  <p className="muted">Codex, Claude Code, Gemini, 기타 로컬 LLM CLI를 이름과 실행 경로로 등록합니다.</p>
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
                    + Claude Code
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => addConnection("gemini")}
                    type="button"
                  >
                    + Gemini
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => addConnection("custom")}
                    type="button"
                  >
                    + 기타
                  </button>
                </div>
                <div className="connection-list">
                  {aiConnections.length === 0 ? (
                    <p className="settings-empty">
                      등록된 AI CLI 연결이 없습니다. template을 적용하거나 CLI 연결을 추가하세요.
                    </p>
                  ) : (
                    aiConnections.map((connection) => {
                        const check = connectionChecks[connection.id];
                        const modelRefresh = modelRefreshes[connection.id];
                        const isChecking = connectionCheckBusyId === connection.id;
                        const isModelRefreshing = Boolean(modelRefresh?.busy);
                        const isConnectionBusy = isChecking || isModelRefreshing;
                        const modelList = connection.availableModels ?? [];
                        const showModelSkeleton = isModelRefreshing && modelList.length === 0;
                        return (
                          <article
                            aria-busy={isConnectionBusy ? true : undefined}
                            className={isConnectionBusy ? "connection-card is-loading" : "connection-card"}
                            key={connection.id}
                          >
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
                                <span className="provider-pill">{providerLabel(connection.provider)}</span>
                                {check ? (
                                  <span className={check.available ? "check-pass" : "check-fail"}>
                                    {check.available ? "프롬프트 OK" : "확인 필요"}
                                  </span>
                                ) : null}
                                {modelRefresh?.busy ? <span className="check-info">모델 확인 중</span> : null}
                                {isChecking ? <span className="check-info">프롬프트 확인 중</span> : null}
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
                                <span>LLM 경로</span>
                                <input
                                  placeholder={cliPathPlaceholder(connection.provider)}
                                  value={connectionCliPath(connection)}
                                  onChange={(event) => updateConnectionCliPath(connection, event.target.value)}
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
                              <label aria-busy={modelRefresh?.busy ? true : undefined}>
                                <span>모델 목록</span>
                                {showModelSkeleton ? (
                                  <ModelListSkeleton />
                                ) : (
                                  <input
                                    placeholder="쉼표로 구분"
                                    value={modelList.join(", ")}
                                    onChange={(event) =>
                                      updateConnection(connection.id, {
                                        availableModels: splitModelList(event.target.value),
                                      })
                                    }
                                  />
                                )}
                                {modelRefresh?.busy && modelList.length > 0 ? (
                                  <span className="model-list-inline-loading" role="status">
                                    최신 모델 확인 중
                                  </span>
                                ) : null}
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
                              <label className="connection-env-field">
                                <span>환경 변수</span>
                                <textarea
                                  placeholder={envPlaceholder(connection.provider)}
                                  rows={3}
                                  value={formatConnectionEnv(connection.env)}
                                  onChange={(event) =>
                                    updateConnection(connection.id, {
                                      env: parseConnectionEnv(event.target.value),
                                    })
                                  }
                                />
                              </label>
                            </div>
                            <code className="command-preview">
                              실행: {connection.commandArgs.join(" ") || "command 없음"}
                            </code>
                            {connection.planningCommandArgs?.length ? (
                              <code className="command-preview">
                                확인/계획: {connection.planningCommandArgs.join(" ")}
                              </code>
                            ) : null}
                            {check?.message ? <p className="muted">{check.message}</p> : null}
                            {check?.modelRefreshMessage ? <p className="muted">{check.modelRefreshMessage}</p> : null}
                            {!check?.modelRefreshMessage && modelRefresh?.message ? (
                              <p className={`model-refresh-message model-refresh-message-${modelRefresh.tone}`}>
                                {modelRefresh.message}
                              </p>
                            ) : null}
                            <div className="connection-card-actions">
                              {canRefreshModels(connection.provider) ? (
                                <button
                                  aria-busy={isModelRefreshing ? true : undefined}
                                  className={isModelRefreshing ? "secondary-button loading-button is-loading" : "secondary-button loading-button"}
                                  disabled={isModelRefreshing || isChecking}
                                  onClick={() => refreshConnectionModels(connection)}
                                  type="button"
                                >
                                  <RefreshCw className={isModelRefreshing ? "loading-icon" : undefined} size={14} aria-hidden />
                                  {isModelRefreshing ? "불러오는 중..." : "모델 불러오기"}
                                </button>
                              ) : null}
                              <button
                                aria-busy={isChecking ? true : undefined}
                                className={isChecking ? "secondary-button loading-button is-loading" : "secondary-button loading-button"}
                                disabled={busy || isChecking || isModelRefreshing}
                                onClick={() => checkConnection(connection)}
                                type="button"
                              >
                                {isChecking ? <Loader2 className="loading-icon" size={14} aria-hidden /> : null}
                                {isChecking ? "확인 중..." : "연동 확인"}
                              </button>
                              <button
                                className="secondary-button danger"
                                disabled={busy || isChecking || isModelRefreshing}
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
                  <h3>작업별 CLI 선택</h3>
                  <p className="muted">계획/구현은 단일 선택, 검수/테스트는 다중 선택으로 저장합니다.</p>
                </div>
                {enabledConnections.length === 0 ? (
                  <p className="settings-empty">
                    활성화된 AI CLI 연결이 없습니다. <strong>AI CLI 연결</strong> 탭에서 먼저 등록하세요.
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

            {activeCategory === "jira" ? (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>Jira</h3>
                  <p className="muted">Planning과 host runner가 공통으로 참조할 Jira 기본값입니다.</p>
                </div>
                <label className="toggle-switch">
                  <input
                    checked={jiraConfig.enabled}
                    onChange={(event) => updateJiraConfig({ enabled: event.target.checked })}
                    type="checkbox"
                  />
                  <span className="toggle-switch-track" aria-hidden />
                  <span className="toggle-switch-label">Jira 연동 정보 사용</span>
                </label>
                <div className="connection-fields">
                  <label>
                    <span>Site URL</span>
                    <input
                      placeholder="https://nugu.atlassian.net"
                      value={jiraConfig.siteUrl ?? ""}
                      onChange={(event) => updateJiraConfig({ siteUrl: nullableText(event.target.value) })}
                    />
                  </label>
                  <label>
                    <span>Project key</span>
                    <input
                      placeholder="예: NC"
                      value={jiraConfig.projectKey ?? ""}
                      onChange={(event) => updateJiraConfig({ projectKey: normalizeJiraProjectKey(event.target.value) })}
                    />
                  </label>
                  <label>
                    <span>Epic issue type</span>
                    <input
                      placeholder="Epic"
                      value={jiraConfig.epicIssueType ?? ""}
                      onChange={(event) => updateJiraConfig({ epicIssueType: nullableText(event.target.value) })}
                    />
                  </label>
                  <label>
                    <span>Task issue type</span>
                    <input
                      placeholder="Task"
                      value={jiraConfig.taskIssueType ?? ""}
                      onChange={(event) => updateJiraConfig({ taskIssueType: nullableText(event.target.value) })}
                    />
                  </label>
                </div>
                <p className="muted">
                  Host runner에는 <code>HELM_JIRA_PROJECT_KEY</code>, <code>HELM_JIRA_SITE_URL</code> 등으로 전달됩니다.
                </p>
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
                <label className="settings-field">
                  <span>Setup config JSON</span>
                  <textarea
                    spellCheck={false}
                    placeholder={'{ "steps": [{ "name": "install", "command": "pnpm install" }] }'}
                    value={worktreeSetup}
                    onChange={(event) => setWorktreeSetup(event.target.value)}
                  />
                  <small className="muted">
                    비워두면 <code>.helm/worktree-setup.json</code>이 있으면 사용합니다. Helm은 자동 실행하지 않고 Context Pack에만 포함합니다.
                  </small>
                </label>
              </section>
            ) : null}

            {activeCategory === "app" ? (
              <section className="settings-section">
                <div className="settings-section-head">
                  <h3>앱 업데이트</h3>
                  <p className="muted">자동 확인 대신 필요할 때 Helm updater를 수동으로 실행합니다.</p>
                </div>
                {!snapshot ? (
                  <div className="settings-empty">
                    <strong>프로젝트별 설정은 프로젝트를 연 뒤 표시됩니다.</strong>
                    <span>전역 오케스트레이터와 앱 업데이트는 프로젝트 없이도 관리할 수 있습니다.</span>
                    <button className="secondary-button" onClick={onOpenProject} type="button">
                      프로젝트 열기
                    </button>
                  </div>
                ) : null}
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
                  <p className="muted">일반적으로 template과 AI CLI 연결 탭만으로 충분합니다.</p>
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

function ModelListSkeleton() {
  return (
    <div className="model-list-skeleton" role="status">
      <span className="settings-skeleton" />
      <span className="settings-skeleton" />
      <span className="settings-skeleton" />
    </div>
  );
}

function emptyAppSettings(): AppSettings {
  return {
    version: 1,
    orchestrator: emptyOrchestratorSettings(),
  };
}

function emptyOrchestratorSettings(): OrchestratorSettings {
  return {
    enabled: false,
    mode: "observe",
    connection: null,
    model: null,
  };
}

function normalizeAppSettings(value: unknown): AppSettings {
  if (typeof value !== "object" || value === null) return emptyAppSettings();
  const record = value as Partial<AppSettings>;
  return {
    version: 1,
    orchestrator: normalizeOrchestratorSettings(record.orchestrator),
  };
}

function normalizeOrchestratorSettings(value: unknown): OrchestratorSettings {
  if (typeof value !== "object" || value === null) return emptyOrchestratorSettings();
  const record = value as Partial<OrchestratorSettings>;
  const connection =
    typeof record.connection === "object" && record.connection !== null
      ? normalizeAiConnections([record.connection])[0] ?? null
      : null;
  return {
    enabled: Boolean(record.enabled) && Boolean(connection),
    mode: record.mode === "gate" ? "gate" : "observe",
    connection,
    model: typeof record.model === "string" && record.model.trim() ? record.model.trim() : null,
  };
}

function orchestratorSettingsConfigured(settings: OrchestratorSettings): boolean {
  return Boolean(settings.connection || settings.enabled || settings.model || settings.mode === "gate");
}

function emptyJiraConfig(): JiraConfig {
  return {
    enabled: false,
    siteUrl: null,
    projectKey: null,
    epicIssueType: "Epic",
    taskIssueType: "Task",
  };
}

function normalizeJiraConfig(value: unknown): JiraConfig {
  if (typeof value !== "object" || value === null) return emptyJiraConfig();
  const config = value as Partial<JiraConfig>;
  return {
    enabled: typeof config.enabled === "boolean" ? config.enabled : false,
    siteUrl: typeof config.siteUrl === "string" && config.siteUrl.trim() ? config.siteUrl.trim() : null,
    projectKey:
      typeof config.projectKey === "string" && config.projectKey.trim()
        ? normalizeJiraProjectKey(config.projectKey)
        : null,
    epicIssueType:
      typeof config.epicIssueType === "string" && config.epicIssueType.trim()
        ? config.epicIssueType.trim()
        : "Epic",
    taskIssueType:
      typeof config.taskIssueType === "string" && config.taskIssueType.trim()
        ? config.taskIssueType.trim()
        : "Task",
  };
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeJiraProjectKey(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  return trimmed ? trimmed : null;
}

function parseRolePresets(raw: string): unknown | null {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeAiConnections(value: unknown): AiConnection[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Partial<AiConnection> => typeof item === "object" && item !== null)
    .map((item) => {
      const provider = typeof item.provider === "string" ? item.provider : "custom";
      return {
        id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
        label: typeof item.label === "string" ? item.label : "AI CLI 연결",
        provider,
        runnerAdapter: typeof item.runnerAdapter === "string" ? item.runnerAdapter : null,
        commandArgs: normalizeCliArgs(
          provider,
          Array.isArray(item.commandArgs) ? item.commandArgs.filter(isString) : [],
        ),
        planningCommandArgs: Array.isArray(item.planningCommandArgs)
          ? normalizeCliArgs(provider, item.planningCommandArgs.filter(isString))
          : undefined,
        env: normalizeConnectionEnv(item.env),
        planningMode: typeof item.planningMode === "string" ? item.planningMode : undefined,
        planningModel: typeof item.planningModel === "string" ? item.planningModel : null,
        healthCheckArgs: Array.isArray(item.healthCheckArgs) ? item.healthCheckArgs.filter(isString) : undefined,
        timeoutSeconds: typeof item.timeoutSeconds === "number" ? item.timeoutSeconds : 1800,
        planningTimeoutSeconds:
          typeof item.planningTimeoutSeconds === "number" ? item.planningTimeoutSeconds : undefined,
        enabled: typeof item.enabled === "boolean" ? item.enabled : true,
        defaultModel: typeof item.defaultModel === "string" ? normalizeModelName(provider, item.defaultModel) : null,
        availableModels: Array.isArray(item.availableModels)
          ? normalizeModelList(provider, item.availableModels.filter(isString))
          : [],
        defaultEffort: typeof item.defaultEffort === "string" ? item.defaultEffort : null,
        approvalPolicy: typeof item.approvalPolicy === "string" ? item.approvalPolicy : null,
        sandbox: typeof item.sandbox === "string" ? item.sandbox : null,
      };
    });
}

function normalizeConnectionEnv(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => key.trim() && typeof item === "string")
      .map(([key, item]) => [key.trim(), item]),
  );
}

function formatConnectionEnv(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseConnectionEnv(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator === -1) return [line, ""];
        return [line.slice(0, separator).trim(), line.slice(separator + 1)];
      })
      .filter(([key]) => key.length > 0),
  );
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

function emptyConductorConfig(): ConductorConfig {
  return {
    enabled: false,
    connectionId: null,
    model: null,
    mode: "observe",
  };
}

function normalizeConductorConfig(value: unknown): ConductorConfig {
  if (typeof value !== "object" || value === null) return emptyConductorConfig();
  const record = value as Partial<ConductorConfig>;
  const connectionId = typeof record.connectionId === "string" && record.connectionId.trim()
    ? record.connectionId.trim()
    : null;
  const mode = record.mode === "gate" ? "gate" : "observe";
  return {
    enabled: Boolean(record.enabled) && Boolean(connectionId),
    connectionId,
    model: typeof record.model === "string" && record.model.trim() ? record.model.trim() : null,
    mode,
  };
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

function mergeModelLists(provider: string, current: string[], incoming: string[]): string[] {
  return normalizeModelList(provider, [...current, ...incoming]);
}

function normalizeModelList(provider: string, models: string[]): string[] {
  return Array.from(
    new Set(
      models
        .map((item) => normalizeModelName(provider, item))
        .filter((model) => isKnownProviderModel(provider, model)),
    ),
  ).sort();
}

function normalizeModelName(provider: string, model: string): string {
  const trimmed = model.trim();
  if (provider === "codex" || provider === "claude" || provider === "gemini") {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

function isKnownProviderModel(provider: string, model: string): boolean {
  if (!model) return false;
  if (provider === "codex") {
    return (
      model.startsWith("gpt-") ||
      model.startsWith("o1") ||
      model.startsWith("o3") ||
      model.startsWith("o4")
    );
  }
  if (provider === "claude") {
    return (
      model === "sonnet" ||
      model === "opus" ||
      (model.startsWith("claude-") &&
        model.split(/[-._]/).some((part) => part === "sonnet" || part === "opus" || part === "haiku"))
    );
  }
  if (provider === "gemini") {
    return model.startsWith("gemini-") || model.startsWith("gemma-");
  }
  return true;
}

function canRefreshModels(provider: string): boolean {
  return provider === "codex" || provider === "claude" || provider === "gemini";
}

function defaultModelPlaceholder(provider: string): string {
  if (provider === "codex") return "예: gpt-5.2";
  if (provider === "claude") return "예: sonnet";
  if (provider === "gemini") return "예: gemini-2.5-pro";
  return "선택 사항";
}

function modelOptions(connection: AiConnection, selectedModel: string): string[] {
  return Array.from(
    new Set([...(connection.availableModels ?? []), connection.defaultModel ?? "", selectedModel].filter(Boolean)),
  );
}

function providerLabel(provider: string): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude Code";
  if (provider === "gemini") return "Gemini";
  if (provider === "custom") return "기타";
  if (provider === "fixture") return "Fixture";
  return provider;
}

function cliPathPlaceholder(provider: string): string {
  if (provider === "codex") return "codex 또는 /path/to/codex";
  if (provider === "claude") return "claude 또는 /path/to/claude";
  if (provider === "gemini") return "gemini 또는 /path/to/gemini";
  return "/path/to/llm";
}

function envPlaceholder(provider: string): string {
  if (provider === "codex") return "CODEX_HOME=/path/to/.codex";
  if (provider === "gemini") return "GEMINI_API_KEY=...";
  return "KEY=value";
}

function connectionCliPath(connection: AiConnection): string {
  return (
    firstNonEmpty([
      connection.commandArgs[0],
      connection.planningCommandArgs?.[0],
      connection.healthCheckArgs?.[0],
      defaultCliPath(connection.provider),
    ]) ?? ""
  );
}

function connectionWithCliPath(connection: AiConnection, rawCliPath: string): Partial<AiConnection> {
  const cliPath = rawCliPath.trim() || defaultCliPath(connection.provider);
  const fallback = defaultsForProvider(connection.provider, cliPath);
  const fallbackPlanningCommandArgs = fallback.planningCommandArgs ?? [cliPath, "{planPrompt}"];
  const fallbackHealthCheckArgs = fallback.healthCheckArgs ?? [cliPath, "--version"];
  return {
    commandArgs: replaceCliPath(connection.commandArgs, cliPath, fallback.commandArgs),
    planningCommandArgs: replaceCliPath(connection.planningCommandArgs ?? [], cliPath, fallbackPlanningCommandArgs),
    healthCheckArgs: replaceCliPath(connection.healthCheckArgs ?? [], cliPath, fallbackHealthCheckArgs),
  };
}

function replaceCliPath(args: string[], cliPath: string, fallback: string[]): string[] {
  if (args.length === 0) return fallback;
  return [cliPath, ...args.slice(1)];
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  return values.find((value) => typeof value === "string" && value.trim()) ?? null;
}

function defaultCliPath(provider: string): string {
  if (provider === "codex") return "codex";
  if (provider === "claude") return "claude";
  if (provider === "gemini") return "gemini";
  if (provider === "fixture") return "node";
  return "llm";
}

function defaultsForProvider(provider: string, cliPath: string) {
  const path = cliPath || defaultCliPath(provider);
  if (provider === "codex") return codexConnection(path);
  if (provider === "claude") return claudeConnection(path);
  if (provider === "gemini") return geminiConnection(path);
  return customConnection("custom-template", path);
}

function nextProviderConnection(provider: "codex" | "claude" | "gemini", connections: AiConnection[]): AiConnection {
  const connection =
    provider === "codex" ? codexConnection() : provider === "claude" ? claudeConnection() : geminiConnection();
  if (!connections.some((item) => item.id === connection.id)) {
    return connection;
  }
  let nextIndex = 2;
  while (connections.some((item) => item.id === `${provider}-local-${nextIndex}`)) {
    nextIndex += 1;
  }
  return {
    ...connection,
    id: `${provider}-local-${nextIndex}`,
    label: `${connection.label} ${nextIndex}`,
  };
}

function codexConnection(cliPath = "codex"): AiConnection {
  return {
    id: "codex-local",
    label: "Codex CLI",
    provider: "codex",
    commandArgs: [
      cliPath,
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--cd",
      "{worktreePath}",
      "--",
      "Read {contextPackPath}, perform the {roleId} role, then write {summaryPath} and {resultPath} following {schemaPath}.",
    ],
    planningCommandArgs: [
      cliPath,
      "exec",
      "--sandbox",
      "read-only",
      "--cd",
      "{projectRoot}",
      "--",
      "{planPrompt}",
    ],
    planningMode: "prompt_guarded",
    planningModel: null,
    env: {},
    healthCheckArgs: [cliPath, "--version"],
    timeoutSeconds: 1800,
    planningTimeoutSeconds: 600,
    enabled: true,
    defaultModel: "gpt-5.2",
    availableModels: ["gpt-5.2", "gpt-5.4", "gpt-5.4-mini"],
    runnerAdapter: "codex_app_server",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  };
}

function normalizeCliArgs(provider: string, args: string[]): string[] {
  if (provider !== "codex") return args;

  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--ask-for-approval") {
      const next = args[index + 1];
      if (next === "never" || next === "on-request" || next === "on-failure" || next === "untrusted") {
        index += 1;
      }
      continue;
    }
    normalized.push(args[index]);
  }
  return normalized;
}

function claudeConnection(cliPath = "claude"): AiConnection {
  return {
    id: "claude-local",
    label: "Claude Code",
    provider: "claude",
    commandArgs: [
      cliPath,
      "-p",
      "Read {contextPackPath}, perform the {roleId} role, then write {summaryPath} and {resultPath} following {schemaPath}.",
    ],
    planningCommandArgs: [cliPath, "--permission-mode", "plan", "-p", "{planPrompt}"],
    planningMode: "native_plan",
    planningModel: null,
    env: {},
    healthCheckArgs: [cliPath, "--version"],
    timeoutSeconds: 1800,
    planningTimeoutSeconds: 600,
    enabled: true,
    defaultModel: "sonnet",
    availableModels: ["sonnet", "opus"],
  };
}

function geminiConnection(cliPath = "gemini"): AiConnection {
  return {
    id: "gemini-local",
    label: "Gemini CLI",
    provider: "gemini",
    commandArgs: [
      cliPath,
      "--skip-trust",
      "--approval-mode",
      "yolo",
      "--include-directories",
      "{artifactDir}",
      "--prompt",
      "Read {contextPackPath}, perform the {roleId} role, then write {summaryPath} and {resultPath} following {schemaPath}.",
    ],
    planningCommandArgs: [
      cliPath,
      "--skip-trust",
      "--approval-mode",
      "plan",
      "--prompt",
      "{planPrompt}",
    ],
    planningMode: "native_plan",
    planningModel: null,
    env: {},
    healthCheckArgs: [cliPath, "--version"],
    timeoutSeconds: 1800,
    planningTimeoutSeconds: 600,
    enabled: true,
    defaultModel: null,
    availableModels: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
  };
}

function customConnection(id: string, cliPath = "llm"): AiConnection {
  return {
    id,
    label: "기타 LLM",
    provider: "custom",
    commandArgs: [
      cliPath,
      "Read {contextPackPath}, perform the {roleId} role, then write {summaryPath} and {resultPath} following {schemaPath}.",
    ],
    planningCommandArgs: [cliPath, "{planPrompt}"],
    planningMode: "prompt_guarded",
    planningModel: null,
    env: {},
    healthCheckArgs: [cliPath, "--version"],
    timeoutSeconds: 1800,
    planningTimeoutSeconds: 600,
    enabled: true,
    defaultModel: null,
    availableModels: [],
  };
}

function nextCustomConnectionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `custom-${crypto.randomUUID()}`;
  }
  return `custom-${Date.now()}`;
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
