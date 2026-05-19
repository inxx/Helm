import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

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
  projectName: string | null;
  busy: boolean;
  children: ReactNode;
}

export function AppShell<T extends string>({
  navItems,
  activeScreen,
  onNavigate,
  onOpenProject,
  projectName,
  busy,
  children,
}: AppShellProps<T>) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">H</span>
          <span>Helm</span>
        </div>
        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={item.id === activeScreen ? "nav-item active" : "nav-item"}
                onClick={() => onNavigate(item.id)}
                type="button"
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <div className="eyebrow">현재 프로젝트</div>
            <h1>{projectName ?? "프로젝트 없음"}</h1>
          </div>
          <button className="primary-button" disabled={busy} onClick={onOpenProject} type="button">
            {busy ? "처리 중" : "프로젝트 열기"}
          </button>
        </header>
        {children}
      </main>
    </div>
  );
}
