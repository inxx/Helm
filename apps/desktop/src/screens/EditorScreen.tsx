import { langs, loadLanguage, type LanguageName } from "@uiw/codemirror-extensions-langs";
import CodeMirror, { keymap, Prec } from "@uiw/react-codemirror";
import { ChevronDown, ChevronRight, File, FolderOpen, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ProjectSwitcher } from "../components/ProjectSwitcher";
import { useToast } from "../components/ToastProvider";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { RecentProject } from "../lib/recents";
import type { ProjectSnapshot, TerminalDirectoryEntry } from "../lib/types";

interface EditorScreenProps {
  snapshot: ProjectSnapshot | null;
  onOpenProject: () => void;
  recents: RecentProject[];
  onSwitchProject: (projectId: string) => void;
}

// langs의 키는 대부분 확장자와 동일하다. 확장자가 키로 존재하면 그 언어를, 없으면 plain text.
const EXTENSION_ALIAS: Record<string, LanguageName> = { mjs: "js", cjs: "js", zsh: "sh", cc: "cpp", h: "c" };

function languageForPath(path: string | null) {
  if (!path) return null;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const name = EXTENSION_ALIAS[ext] ?? (ext in langs ? (ext as LanguageName) : null);
  return name ? loadLanguage(name) : null;
}

interface TreeNodeProps {
  projectId: string;
  entry: TerminalDirectoryEntry;
  depth: number;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
}

function TreeNode({ projectId, entry, depth, selectedPath, onOpenFile }: TreeNodeProps) {
  const { showToast } = useToast();
  const isDir = entry.kind === "child";
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<TerminalDirectoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(() => {
    if (!isDir) {
      onOpenFile(entry.path);
      return;
    }
    const next = !expanded;
    setExpanded(next);
    if (next && children === null && !loading) {
      setLoading(true);
      api
        .listEditorEntries(projectId, entry.path)
        // projectRoot/parent 항목은 트리에서 제외하고 실제 자식만 남긴다.
        .then((list) => setChildren(list.filter((item) => item.kind === "child" || item.kind === "file")))
        .catch((err) => showToast({ title: "폴더를 열지 못했습니다.", description: String(err?.message ?? err), tone: "error" }))
        .finally(() => setLoading(false));
    }
  }, [isDir, expanded, children, loading, projectId, entry.path, onOpenFile, showToast]);

  return (
    <li>
      <button
        className={`editor-entry${!isDir && selectedPath === entry.path ? " active" : ""}${isDir ? " editor-entry-dir" : ""}`}
        onClick={toggle}
        style={{ paddingLeft: 8 + depth * 14 }}
        type="button"
      >
        {isDir ? (
          expanded ? (
            <ChevronDown size={14} aria-hidden />
          ) : (
            <ChevronRight size={14} aria-hidden />
          )
        ) : (
          <File size={14} aria-hidden />
        )}
        {entry.label}
      </button>
      {isDir && expanded && children && (
        <ul className="editor-entry-list">
          {children.map((child) => (
            <TreeNode
              key={`${child.kind}:${child.path}`}
              projectId={projectId}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function EditorScreen({ snapshot, onOpenProject, recents, onSwitchProject }: EditorScreenProps) {
  const { showToast } = useToast();
  const { language } = useI18n();
  const projectId = snapshot?.project.id ?? null;
  const [roots, setRoots] = useState<TerminalDirectoryEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);

  const dirty = content !== original;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api
      .listEditorEntries(projectId, "")
      .then((list) => {
        if (!cancelled) setRoots(list.filter((item) => item.kind === "child" || item.kind === "file"));
      })
      .catch((err) => showToast({ title: "폴더를 열지 못했습니다.", description: String(err?.message ?? err), tone: "error" }));
    return () => {
      cancelled = true;
    };
  }, [projectId, showToast]);

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

  const extensions = useMemo(() => {
    // CodeMirror가 IME 조합을 직접 처리하므로 keymap만으로 한글 입력 중에도 안전하다.
    const saveKey = Prec.highest(keymap.of([{ key: "Mod-s", run: () => (save(), true) }]));
    const lang = languageForPath(selectedPath);
    return lang ? [saveKey, lang] : [saveKey];
  }, [selectedPath, save]);

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
        <header className="editor-tree-header">
          <ProjectSwitcher
            snapshot={snapshot}
            recents={recents}
            onSwitchProject={onSwitchProject}
            onOpenProject={onOpenProject}
            language={language}
          />
        </header>
        <ul className="editor-entry-list">
          {roots.map((entry) => (
            <TreeNode
              key={`${entry.kind}:${entry.path}`}
              projectId={projectId}
              entry={entry}
              depth={0}
              selectedPath={selectedPath}
              onOpenFile={openFile}
            />
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
        {selectedPath ? (
          <CodeMirror
            className="editor-codemirror"
            extensions={extensions}
            height="100%"
            onChange={setContent}
            value={content}
          />
        ) : (
          <div className="editor-placeholder">왼쪽에서 파일을 선택하세요.</div>
        )}
      </section>
    </div>
  );
}
