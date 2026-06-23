import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface NavItem<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
}

interface AppShellProps<T extends string> {
  navItems: NavItem<T>[];
  activeScreen: T;
  onNavigate: (screen: T) => void;
  children: ReactNode;
}

export function AppShell<T extends string>({
  navItems,
  activeScreen,
  onNavigate,
  children,
}: AppShellProps<T>) {
  const { t } = useI18n();

  return (
    <div className="app-shell">
      <header className="app-topbar" role="tablist" aria-label={t("shell.domainTabs")}>
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

      <div className="app-body no-sidebar">
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
