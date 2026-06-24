import { File, FolderOpen, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { useToast } from "../components/ToastProvider";
import { api } from "../lib/api";
import type { ProjectSnapshot, TerminalDirectoryEntry } from "../lib/types";

interface EditorScreenProps {
  snapshot: ProjectSnapshot | null;
  onOpenProject: () => void;
}

export function EditorScreen({ snapshot, onOpenProject }: EditorScreenProps) {
  const { showToast } = useToast();
  const projectId = snapshot?.project.id ?? null;
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<TerminalDirectoryEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);

  const dirty = content !== original;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api
      .listEditorEntries(projectId, cwd)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err) => showToast({ title: "폴더를 열지 못했습니다.", description: String(err?.message ?? err), tone: "error" }));
    return () => {
      cancelled = true;
    };
  }, [projectId, cwd, showToast]);

  const openFile = useCallback(
    (path: string) => {
      if (!projectId) return;
      if (dirty && !window.confirm("저장하지 않은 변경 사항이 있습니다. 그래도 다른 파일을 여시겠습니까?")) return;
      api
        .readEditorFile(projectId, path)
        .then((text) => {
          setSelectedPath(path);
          setContent(text);
          setOriginal(text);
        })
        .catch((err) => showToast({ title: "파일을 읽지 못했습니다.", description: String(err?.message ?? err), tone: "error" }));
    },
    [projectId, dirty, showToast],
  );

  const save = useCallback(() => {
    if (!projectId || !selectedPath || saving || !dirty) return;
    setSaving(true);
    api
      .writeEditorFile(projectId, selectedPath, content)
      .then(() => {
        setOriginal(content);
        showToast({ title: "저장했습니다.", tone: "success" });
      })
      .catch((err) => showToast({ title: "저장하지 못했습니다.", description: String(err?.message ?? err), tone: "error" }))
      .finally(() => setSaving(false));
  }, [projectId, selectedPath, saving, dirty, content, showToast]);

  // 한글 등 IME 조합 중에는 Cmd/Ctrl+S 단축키를 무시해 입력이 끊기지 않게 한다.
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      }
    },
    [save],
  );

  if (!snapshot || !projectId) {
    return (
      <section className="empty-state">
        <h2>에디터</h2>
        <p>프로젝트를 열면 파일을 편집할 수 있습니다.</p>
        <button className="primary-button" onClick={onOpenProject} type="button">
          <FolderOpen size={16} aria-hidden /> 프로젝트 열기
        </button>
      </section>
    );
  }

  return (
    <div className="editor-screen">
      <aside className="editor-tree">
        <ul className="editor-entry-list">
          {entries.map((entry) => (
            <li key={`${entry.kind}:${entry.path}`}>
              {entry.kind === "file" ? (
                <button
                  className={`editor-entry editor-entry-file${selectedPath === entry.path ? " active" : ""}`}
                  onClick={() => openFile(entry.path)}
                  type="button"
                >
                  <File size={14} aria-hidden /> {entry.label}
                </button>
              ) : (
                <button className="editor-entry editor-entry-dir" onClick={() => setCwd(entry.path)} type="button">
                  <FolderOpen size={14} aria-hidden /> {entry.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      </aside>
      <section className="editor-pane">
        <header className="editor-toolbar">
          <span className="editor-current-path">{selectedPath ?? "파일을 선택하세요"}</span>
          <div className="editor-toolbar-actions">
            <button
              className="ghost-button"
              disabled={!dirty}
              onClick={() => setContent(original)}
              title="되돌리기"
              type="button"
            >
              <RotateCcw size={14} aria-hidden /> 되돌리기
            </button>
            <button className="primary-button" disabled={!dirty || saving} onClick={save} type="button">
              <Save size={14} aria-hidden /> {saving ? "저장 중…" : "저장"}
            </button>
          </div>
        </header>
        <textarea
          className="editor-textarea"
          disabled={!selectedPath}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={selectedPath ? "" : "왼쪽에서 파일을 선택하세요."}
          spellCheck={false}
          value={content}
        />
      </section>
    </div>
  );
}
