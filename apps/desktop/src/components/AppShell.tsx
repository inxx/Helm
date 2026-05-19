import { Plus } from "lucide-react";
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
  busy,
  children,
}: AppShellProps<T>) {
  return (
    <div className="grid h-screen min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background text-foreground">
      <header
        className="flex items-stretch border-b border-border bg-background"
        role="tablist"
        aria-label="도메인 탭"
      >
        <div className="flex w-[232px] flex-shrink-0 items-center gap-2.5 border-r border-border bg-sidebar px-3.5">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-slate-900 font-mono text-sm font-semibold text-emerald-400">
            H
          </span>
          <span className="text-sm font-semibold tracking-tight">Helm</span>
        </div>
        <div className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto px-3 pt-1">
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
                className={cn(
                  "inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 pt-2 pb-2.5 text-sm font-medium tracking-tight transition-colors",
                  isActive
                    ? "border-primary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon size={15} className={cn("flex-shrink-0", isActive && "text-primary")} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </header>

      <div className="grid min-h-0 grid-cols-[232px_minmax(0,1fr)] overflow-hidden">
        <aside className="flex flex-col gap-3 border-r border-border bg-sidebar p-3.5">
          <div className="flex min-h-0 flex-col gap-1.5">
            <h3 className="px-1 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">
              프로젝트
            </h3>
            {recents.length === 0 ? (
              <p className="mt-0.5 px-1 text-xs text-muted-foreground">
                아직 열린 프로젝트가 없습니다.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-0.5 overflow-y-auto p-0">
                {recents.map((project) => {
                  const isActive = project.id === activeProjectId;
                  const isDisabled = busy && !isActive;
                  return (
                    <li key={project.id}>
                      <button
                        type="button"
                        onClick={() => onSwitchProject(project.id)}
                        title={project.rootPath}
                        disabled={isDisabled}
                        className={cn(
                          "flex w-full flex-col items-start gap-px rounded-md px-2.5 py-1.5 text-left transition-colors",
                          isActive
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground",
                          isDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                        )}
                      >
                        <span className="max-w-full truncate text-sm font-semibold tracking-tight">
                          {project.name}
                        </span>
                        <span
                          className={cn(
                            "max-w-full truncate font-mono text-[10.5px]",
                            isActive ? "text-foreground/60" : "text-muted-foreground/80",
                          )}
                        >
                          {shortenPath(project.rootPath)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="mt-auto border-t border-border/60 pt-2.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onOpenProject}
              className="w-full border-dashed font-medium"
            >
              <Plus className="size-3.5" />
              <span>{busy ? "처리 중" : "프로젝트 추가"}</span>
            </Button>
          </div>
        </aside>

        <main className="main flex min-h-0 min-w-0 flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
