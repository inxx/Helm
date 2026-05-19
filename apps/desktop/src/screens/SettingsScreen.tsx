import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ProjectSnapshot } from "../lib/types";

interface SettingsScreenProps {
  snapshot: ProjectSnapshot | null;
  onRefresh: () => Promise<void>;
}

export function SettingsScreen({ snapshot, onRefresh }: SettingsScreenProps) {
  const [rolePresets, setRolePresets] = useState("");
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!snapshot) return;
    setRolePresets(JSON.stringify(snapshot.settings.rolePresets, null, 2));
    setWorktreeRoot(snapshot.settings.worktreeRoot ?? "");
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

  return (
    <section className="content-panel">
      <h2>설정</h2>
      {snapshot ? (
        <div className="settings-form">
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
      ) : (
        <p className="muted">프로젝트를 열면 설정 skeleton이 표시됩니다.</p>
      )}
    </section>
  );
}
