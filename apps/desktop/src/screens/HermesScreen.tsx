import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  GitBranch,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Wrench,
} from "lucide-react";
import { api } from "../lib/api";
import {
  ACTION_LABELS,
  COLUMN_LABELS,
  HERMES_COLUMNS,
  attentionNeeded,
  availableActions,
  groupByStatus,
  isGated,
} from "../lib/hermesBoard";
import type {
  HermesBoardCard,
  HermesKanbanAction,
  HermesProfile,
  HermesSessionNode,
} from "../lib/types";

// Hermes-native control plane: build a deterministic multi-stage pipeline (each stage =
// a Hermes profile = a model), run it through the kanban dispatcher, then observe the
// board + per-task session/tool-call evidence. See docs/hermes-native-acp-architecture.md.

interface StageDraft {
  id: string;
  label: string;
  profile: string;
}

const DEFAULT_STAGE_LABELS = ["설계", "코딩"];

export function HermesScreen() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [cards, setCards] = useState<HermesBoardCard[]>([]);
  const [goal, setGoal] = useState("");
  const [stages, setStages] = useState<StageDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tree, setTree] = useState<HermesSessionNode[]>([]);
  const stagesInitialized = useRef(false);

  const loadBoard = useCallback(async () => {
    try {
      const next = await api.listHermesBoard(200);
      setCards(next);
      setAvailable(true);
      setError(null);
    } catch (err) {
      setAvailable(false);
      setError(messageFromError(err, "Hermes 보드를 불러오지 못했습니다."));
    }
  }, []);

  // initial load: profiles + board, seed default stage drafts once profiles arrive.
  useEffect(() => {
    void api
      .listHermesProfiles()
      .then((items) => {
        setProfiles(items);
        if (!stagesInitialized.current) {
          stagesInitialized.current = true;
          setStages(seedStages(items));
        }
      })
      .catch(() => setProfiles([]));
    void loadBoard();
  }, [loadBoard]);

  // live refresh while the dispatcher runs.
  useEffect(() => {
    const timer = window.setInterval(() => void loadBoard(), 5_000);
    return () => window.clearInterval(timer);
  }, [loadBoard]);

  // evidence for the selected card.
  useEffect(() => {
    if (!selectedId) {
      setTree([]);
      return;
    }
    let disposed = false;
    void api
      .getHermesTaskTree(selectedId)
      .then((nodes) => !disposed && setTree(nodes))
      .catch(() => !disposed && setTree([]));
    return () => {
      disposed = true;
    };
  }, [selectedId, cards]);

  const grouped = useMemo(() => groupByStatus(cards), [cards]);
  const selected = selectedId ? cards.find((card) => card.id === selectedId) ?? null : null;
  const canRun = goal.trim().length > 0 && stages.length > 0 && stages.every((s) => s.profile) && !busy;

  async function runPipeline() {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    try {
      const text = goal.trim();
      const payload = stages.map((stage) => ({
        title: `${stage.label}: ${text}`,
        assignee: stage.profile,
      }));
      await api.createHermesStageChain(text, payload);
      setGoal("");
      await loadBoard();
    } catch (err) {
      setError(messageFromError(err, "파이프라인 생성에 실패했습니다."));
    } finally {
      setBusy(false);
    }
  }

  async function runAction(action: HermesKanbanAction, taskId: string) {
    // confirm state-changing/destructive gate actions before applying.
    const needsConfirm: HermesKanbanAction[] = ["archive", "complete", "block"];
    if (needsConfirm.includes(action) && !window.confirm(`이 작업을 "${ACTION_LABELS[action]}" 처리할까요?`)) {
      return;
    }
    setActioningId(taskId);
    setError(null);
    try {
      await api.hermesKanbanAction(action, taskId);
      await loadBoard();
    } catch (err) {
      setError(messageFromError(err, "작업 액션에 실패했습니다."));
    } finally {
      setActioningId(null);
    }
  }

  if (available === false) {
    return <HermesSetup error={error} onRetry={() => void loadBoard()} />;
  }

  return (
    <div className="sessions-layout">
      <section className="session-chat" aria-label="Hermes pipeline board">
        <header className="session-chat-header">
          <div>
            <h1>Hermes</h1>
            <p>단계별 프로필(=모델)로 결정적 파이프라인을 실행하고 보드·근거를 관찰합니다.</p>
          </div>
          <button className="session-context-link" onClick={() => void loadBoard()} type="button" aria-label="새로고침">
            <RefreshCw size={13} aria-hidden /> 새로고침
          </button>
        </header>

        {error ? (
          <div className="error-banner compact" role="alert">
            {error}
          </div>
        ) : null}

        <StageBuilder
          goal={goal}
          stages={stages}
          profiles={profiles}
          busy={busy}
          canRun={canRun}
          onGoalChange={setGoal}
          onStagesChange={setStages}
          onRun={() => void runPipeline()}
        />

        <div className="session-chat-scroll" aria-label="board">
          {cards.length === 0 ? (
            <p className="session-context-empty">
              아직 작업이 없습니다. 위에 목표를 입력하고 “파이프라인 실행”을 누르세요.
              실제 실행에는 <code>hermes gateway run</code>이 필요합니다.
            </p>
          ) : (
            <div className="hermes-board">
              {HERMES_COLUMNS.map((column) => (
                <div className="hermes-column" key={column}>
                  <div className="hermes-column-head">
                    <span>{COLUMN_LABELS[column]}</span>
                    <strong>{grouped[column].length}</strong>
                  </div>
                  {grouped[column].map((card) => (
                    <BoardCard
                      key={card.id}
                      card={card}
                      active={card.id === selectedId}
                      actioning={actioningId === card.id}
                      onSelect={() => setSelectedId(card.id)}
                      onAction={(action) => void runAction(action, card.id)}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <EvidencePanel card={selected} tree={tree} />
    </div>
  );
}

function seedStages(profiles: HermesProfile[]): StageDraft[] {
  const pick = (preferred: string, index: number) =>
    profiles.find((p) => p.name === preferred)?.name ??
    profiles[index]?.name ??
    profiles[0]?.name ??
    "default";
  return DEFAULT_STAGE_LABELS.map((label, i) => ({
    id: `stage-${i}`,
    label,
    profile: pick(label === "설계" ? "designer" : "coder", i),
  }));
}

function StageBuilder({
  goal,
  stages,
  profiles,
  busy,
  canRun,
  onGoalChange,
  onStagesChange,
  onRun,
}: {
  goal: string;
  stages: StageDraft[];
  profiles: HermesProfile[];
  busy: boolean;
  canRun: boolean;
  onGoalChange: (value: string) => void;
  onStagesChange: (stages: StageDraft[]) => void;
  onRun: () => void;
}) {
  const noProfiles = profiles.length === 0;

  function updateStage(id: string, patch: Partial<StageDraft>) {
    onStagesChange(stages.map((stage) => (stage.id === id ? { ...stage, ...patch } : stage)));
  }
  function addStage() {
    const id = `stage-${Date.now()}`;
    onStagesChange([...stages, { id, label: `단계${stages.length + 1}`, profile: profiles[0]?.name ?? "default" }]);
  }
  function removeStage(id: string) {
    onStagesChange(stages.filter((stage) => stage.id !== id));
  }

  return (
    <div className="hermes-builder">
      {noProfiles ? (
        <p className="session-context-empty">
          Hermes 프로필이 없습니다. <code>hermes profile create &lt;name&gt;</code>로 단계별 프로필을 만드세요.
        </p>
      ) : null}
      <div className="hermes-stages">
        {stages.map((stage, index) => (
          <div className="hermes-stage" key={stage.id}>
            <span className="hermes-stage-index">{index + 1}</span>
            <input
              aria-label={`단계 ${index + 1} 이름`}
              className="hermes-stage-label"
              onChange={(event) => updateStage(stage.id, { label: event.target.value })}
              placeholder="단계 이름"
              value={stage.label}
            />
            <select
              aria-label={`단계 ${index + 1} 프로필`}
              disabled={noProfiles}
              onChange={(event) => updateStage(stage.id, { profile: event.target.value })}
              value={stage.profile}
            >
              {profiles.map((profile) => (
                <option key={profile.name} value={profile.name}>
                  {profile.name}
                  {profile.model ? ` · ${shortModel(profile.model)}` : ""}
                </option>
              ))}
            </select>
            <button
              aria-label={`단계 ${index + 1} 삭제`}
              className="hermes-stage-remove"
              disabled={stages.length <= 1}
              onClick={() => removeStage(stage.id)}
              type="button"
            >
              <Trash2 size={13} aria-hidden />
            </button>
            {index < stages.length - 1 ? <span className="hermes-stage-arrow" aria-hidden>→</span> : null}
          </div>
        ))}
        <button className="hermes-stage-add" onClick={addStage} type="button" disabled={noProfiles}>
          <Plus size={13} aria-hidden /> 단계 추가
        </button>
      </div>
      <form
        className="session-orchestrator-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onRun();
        }}
      >
        <textarea
          aria-label="파이프라인 목표"
          disabled={busy || noProfiles}
          onChange={(event) => onGoalChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            onRun();
          }}
          placeholder="목표를 입력하면 위 단계 순서대로 의존성 체인을 만듭니다"
          rows={2}
          value={goal}
        />
        <button className="primary-button loading-button" disabled={!canRun} type="submit">
          {busy ? <Loader2 className="loading-icon" size={14} aria-hidden /> : <Send size={14} aria-hidden />}
          <span>{busy ? "생성 중" : "파이프라인 실행"}</span>
        </button>
      </form>
    </div>
  );
}

function BoardCard({
  card,
  active,
  actioning,
  onSelect,
  onAction,
}: {
  card: HermesBoardCard;
  active: boolean;
  actioning: boolean;
  onSelect: () => void;
  onAction: (action: HermesKanbanAction) => void;
}) {
  const needsAttention = attentionNeeded(card);
  const gated = isGated(card);
  return (
    <div className={`hermes-card${active ? " active" : ""}${needsAttention ? " attention" : ""}`}>
      <button className="hermes-card-main" onClick={onSelect} type="button">
        <div className="hermes-card-title">
          {needsAttention ? <AlertTriangle size={12} className="hermes-attention-dot" aria-label="확인 필요" /> : null}
          {gated ? <Lock size={11} aria-label="의존성 대기" /> : null}
          <strong>{card.title}</strong>
        </div>
        <div className="hermes-card-meta">
          <span>{card.assignee ?? "미할당"}</span>
          {card.runStatus ? <span>· run:{card.runStatus}</span> : null}
          {card.runOutcome ? <span>({card.runOutcome})</span> : null}
          {card.branchName ? (
            <span className="hermes-card-branch">
              <GitBranch size={10} aria-hidden /> {card.branchName}
            </span>
          ) : null}
        </div>
      </button>
      <div className="hermes-card-actions">
        {availableActions(card).map((action) => (
          <button
            disabled={actioning}
            key={action}
            onClick={() => onAction(action)}
            type="button"
            className="hermes-card-action"
          >
            {actioning ? <Loader2 size={11} className="loading-icon" aria-hidden /> : ACTION_LABELS[action]}
          </button>
        ))}
      </div>
    </div>
  );
}

function EvidencePanel({ card, tree }: { card: HermesBoardCard | null; tree: HermesSessionNode[] }) {
  const totalCost = tree.reduce((sum, node) => sum + (node.actualCostUsd ?? 0), 0);
  return (
    <aside className="session-context-panel" aria-label="evidence">
      <h3>Evidence</h3>
      {!card ? (
        <p className="session-context-empty">작업을 선택하면 세션 트리와 tool call이 보입니다.</p>
      ) : (
        <>
          <ContextRow label="Task" value={card.title} />
          <ContextRow
            label="Status"
            value={`${card.status}${card.runStatus ? ` · ${card.runStatus}` : ""}${card.runOutcome ? ` (${card.runOutcome})` : ""}`}
          />
          <ContextRow label="Assignee" value={card.assignee ?? "-"} />
          <ContextRow label="Branch" value={card.branchName ?? "-"} />
          {card.runSummary ? <ContextRow label="Summary" value={card.runSummary} /> : null}
          {totalCost > 0 ? <ContextRow label="Cost" value={`$${totalCost.toFixed(4)}`} /> : null}
          <div className="session-context-section">
            <div className="session-context-section-title">
              <span>Session tree</span>
              <strong>{tree.length}</strong>
            </div>
            {tree.length === 0 ? (
              <p className="session-context-empty">아직 실행 세션이 없습니다 (gateway 실행 후 생성).</p>
            ) : (
              tree.map((node) => <SessionNode key={node.id} node={node} />)
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function SessionNode({ node }: { node: HermesSessionNode }) {
  return (
    <div className="hermes-session-node">
      <div className="hermes-session-head">
        <strong>
          {node.kind === "root" ? "● " : "└ "}
          {node.title ?? shortModel(node.model ?? node.id)}
        </strong>
        <small>
          {node.model ? shortModel(node.model) : "model?"} · {node.toolCallCount} tools · in {node.inputTokens}/out{" "}
          {node.outputTokens}
          {node.actualCostUsd != null ? ` · $${node.actualCostUsd.toFixed(4)}` : ""}
        </small>
      </div>
      {node.toolCalls.length > 0 ? (
        <details className="hermes-tools">
          <summary>
            <ChevronDown size={11} aria-hidden /> tool calls ({node.toolCalls.length})
          </summary>
          {node.toolCalls.map((tc, idx) => (
            <div className="hermes-tool-row" key={idx}>
              <span className="hermes-tool-name">
                <Wrench size={10} aria-hidden /> {tc.toolName ?? tc.role}
              </span>
              <code title={tc.content ?? ""}>{(tc.content ?? "").slice(0, 120)}</code>
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}

function HermesSetup({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="session-chat-empty" role="region" aria-label="Hermes setup">
      <Bot size={22} aria-hidden />
      <h2>Hermes를 찾을 수 없습니다</h2>
      <p>로컬 Hermes를 설치/초기화한 뒤 사용할 수 있습니다.</p>
      <ol className="hermes-setup-steps">
        <li>
          Hermes 설치 후 <code>hermes kanban init</code>로 보드를 초기화
        </li>
        <li>
          단계별 프로필 생성: <code>hermes profile create designer</code>, <code>… coder</code>
        </li>
        <li>
          각 프로필 모델 설정(예: 설계=Opus, 코딩=Sonnet): <code>hermes model</code>
        </li>
        <li>
          실행 디스패처 시작: <code>hermes gateway run</code>
        </li>
      </ol>
      {error ? <p className="session-context-empty">{error}</p> : null}
      <button className="primary-button" onClick={onRetry} type="button">
        <RefreshCw size={14} aria-hidden /> 다시 확인
      </button>
    </div>
  );
}

function ContextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="session-context-row">
      <span>{label}</span>
      <strong className="full-value" title={value}>
        {value}
      </strong>
    </div>
  );
}

function shortModel(model: string): string {
  const tail = model.split("/").pop() ?? model;
  return tail.length > 28 ? `${tail.slice(0, 28)}…` : tail;
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}
