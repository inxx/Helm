import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ProjectSnapshot, RunnerCheckResult, RunnerTemplateSummary } from "../lib/types";

interface SettingsScreenProps {
  snapshot: ProjectSnapshot | null;
  onRefresh: () => Promise<void>;
  onOpenProject: () => void;
}

export function SettingsScreen({ snapshot, onRefresh, onOpenProject }: SettingsScreenProps) {
  const [rolePresets, setRolePresets] = useState("");
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [templates, setTemplates] = useState<RunnerTemplateSummary[]>([]);
  const [checks, setChecks] = useState<RunnerCheckResult[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!snapshot) return;
    setRolePresets(JSON.stringify(snapshot.settings.rolePresets, null, 2));
    setWorktreeRoot(snapshot.settings.worktreeRoot ?? "");
    void api.listRunnerTemplates(snapshot.project.id).then(setTemplates);
    setMessage(null);
  }, [snapshot]);

  async function save() {
    if (!snapshot) return;
    setBusy(true);
    setMessage(null);
    try {
      const parsedRolePresets = JSON.parse(rolePresets);
      await api.updateProjectSettings(snapshot.project.id, {
        rolePresets: parsedRolePresets,
        worktreeRoot: worktreeRoot.trim() ? worktreeRoot.trim() : null,
      });
      await onRefresh();
      setMessage("저장됨");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "설정 저장에 실패했습니다.");
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
      await onRefresh();
      setMessage("runner template 적용됨");
    } catch (error) {
      setMessage(errorMessage(error, "runner template 적용에 실패했습니다."));
    } finally {
      setBusy(false);
    }
  }

  async function checkRunners() {
    if (!snapshot) return;
    setBusy(true);
    setMessage(null);
    try {
      const roleIds = ["planner", "coder", "plan_verifier", "code_reviewer", "tester"];
      const results = await Promise.all(
        roleIds.map((roleId) => api.checkRoleRunner(snapshot.project.id, roleId)),
      );
      setChecks(results);
      setMessage("runner 확인 완료");
    } catch (error) {
      setMessage(errorMessage(error, "runner 확인에 실패했습니다."));
    } finally {
      setBusy(false);
    }
  }

  if (!snapshot) {
    return (
      <section className="empty-state">
        <h2>설정</h2>
        <p>프로젝트를 열면 runner, worktree, role preset 설정이 표시됩니다.</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          프로젝트 열기
        </button>
      </section>
    );
  }

  return (
    <section className="content-panel">
      <h2>설정</h2>
      <div className="settings-form">
          <section className="settings-section">
            <div>
              <h3>Runner Templates</h3>
              <p className="muted">host runner를 바로 실행할 수 있도록 역할별 command preset을 적용합니다.</p>
            </div>
            <div className="template-grid">
              {templates.map((template) => (
                <article className="template-card" key={template.id}>
                  <div>
                    <strong>{template.label}</strong>
                    <p>{template.description}</p>
                  </div>
                  <button disabled={busy} onClick={() => applyTemplate(template.id)} type="button">
                    적용
                  </button>
                </article>
              ))}
            </div>
            <button className="secondary-button" disabled={busy} onClick={checkRunners} type="button">
              runner 확인
            </button>
            {checks.length > 0 ? (
              <ul className="runner-check-list">
                {checks.map((check) => (
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
          </section>

          <label>
            <span>Worktree root</span>
            <input
              placeholder="기본값: <repo>/.helm/worktrees"
              value={worktreeRoot}
              onChange={(event) => setWorktreeRoot(event.target.value)}
            />
          </label>
          <label>
            <span>Role presets JSON</span>
            <textarea
              spellCheck={false}
              value={rolePresets}
              onChange={(event) => setRolePresets(event.target.value)}
            />
          </label>
          <button disabled={busy} onClick={save} type="button">
            저장
          </button>
        {message ? <p className="muted">{message}</p> : null}
      </div>
    </section>
  );
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

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}
