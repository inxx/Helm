import { ChevronDown, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppLanguage } from "../lib/i18n";
import { shortenPath, type RecentProject } from "../lib/recents";
import type { ProjectSnapshot } from "../lib/types";

export function ProjectSwitcher({
  snapshot,
  recents,
  onSwitchProject,
  onOpenProject,
  language,
}: {
  snapshot: ProjectSnapshot;
  recents: RecentProject[];
  onSwitchProject: (projectId: string) => void;
  onOpenProject: () => void;
  language: AppLanguage;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className="git-repo-switcher" ref={wrapRef}>
      <button
        className="git-repo-title"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="git-repo-title-text">
          <h2>{snapshot.project.name}</h2>
          <p title={snapshot.project.rootPath}>{snapshot.project.rootPath}</p>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="git-repo-menu" role="menu">
          {recents.map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitem"
              className={project.id === snapshot.project.id ? "active" : ""}
              onClick={() => {
                setOpen(false);
                if (project.id !== snapshot.project.id) onSwitchProject(project.id);
              }}
            >
              <strong>{project.name}</strong>
              <span>{shortenPath(project.rootPath)}</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="git-repo-menu-open"
            onClick={() => {
              setOpen(false);
              onOpenProject();
            }}
          >
            <FolderOpen size={14} aria-hidden="true" />
            <span>{language === "ko" ? "프로젝트 열기" : "Open project"}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
