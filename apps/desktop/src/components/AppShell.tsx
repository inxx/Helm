import { Plus, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { shortenPath, type RecentProject } from "@/lib/recents";

interface NavItem<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
}

interface AppShellProps<T extends string> {
  navItems: NavItem<T>[];
  activeScreen: T;
  onNavigate: (screen: T) => void;
  onOpenProject: () => void;
  recents: RecentProject[];
  activeProjectId: string | null;
  onSwitchProject: (projectId: string) => void;
  onForgetProject: (projectId: string) => void;
  busy: boolean;
  children: ReactNode;
}

export function AppShell<T extends string>({
  navItems,
  activeScreen,
  onNavigate,
  onOpenProject,
  recents,
  activeProjectId,
  onSwitchProject,
  onForgetProject,
  busy,
  children,
}: AppShellProps<T>) {
  return (
    <div className="app-shell">
      <header className="app-topbar" role="tablist" aria-label="도메인 탭">
        <div className="app-topbar-brand">
          <span className="brand-mark">H</span>
          <span className="brand-name">Helm</span>
        </div>
        <div className="app-tabs">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === activeScreen;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onNavigate(item.id)}
                className={cn("app-tab", isActive && "active")}
              >
                <Icon size={15} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-projects">
            <h3 className="sidebar-title">프로젝트</h3>
            {recents.length === 0 ? (
              <p className="sidebar-empty">아직 열린 프로젝트가 없습니다.</p>
            ) : (
              <ul className="sidebar-project-list">
                {recents.map((project) => {
                  const isActive = project.id === activeProjectId;
                  const isDisabled = busy && !isActive;
                  return (
                    <li key={project.id} className="sidebar-project-row">
                      <button
                        type="button"
                        onClick={() => onSwitchProject(project.id)}
                        title={project.rootPath}
                        disabled={isDisabled}
                        className={cn(
                          "sidebar-project-button",
                          isActive && "active",
                          isDisabled && "disabled",
                        )}
                      >
                        <span className="sidebar-project-name">{project.name}</span>
                        <span className="sidebar-project-path">{shortenPath(project.rootPath)}</span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={busy}
                        onClick={() => onForgetProject(project.id)}
                        className="sidebar-project-delete"
                        title="프로젝트 목록에서 삭제"
                        aria-label={`${project.name} 프로젝트 목록에서 삭제`}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="sidebar-footer">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onOpenProject}
              className="sidebar-add-project"
            >
              <Plus size={14} aria-hidden="true" />
              <span>{busy ? "처리 중" : "프로젝트 추가"}</span>
            </Button>
          </div>
        </aside>

        <main className="main">{children}</main>
      </div>
    </div>
  );
}
