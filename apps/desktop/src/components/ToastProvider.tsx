import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { Toast as RadixToast } from "radix-ui";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type ToastTone = "success" | "error" | "info";

interface ToastMessage {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
}

type ToastInput = Omit<ToastMessage, "id">;

interface ToastContextValue {
  showToast: (toast: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((toast: ToastInput) => {
    setToasts((current) => [
      ...current.slice(-3),
      {
        ...toast,
        id: crypto.randomUUID(),
      },
    ]);
  }, []);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      <RadixToast.Provider duration={4200} swipeDirection="right">
        {children}
        {toasts.map((toast) => {
          const Icon = toast.tone === "success" ? CheckCircle2 : toast.tone === "error" ? XCircle : Info;
          return (
            <RadixToast.Root
              className={`toast-root toast-${toast.tone}`}
              key={toast.id}
              onOpenChange={(open) => {
                if (!open) dismissToast(toast.id);
              }}
              open
            >
              <Icon className="toast-icon" size={16} aria-hidden />
              <div className="toast-content">
                <RadixToast.Title className="toast-title">{toast.title}</RadixToast.Title>
                {toast.description ? (
                  <RadixToast.Description className="toast-description">
                    {toast.description}
                  </RadixToast.Description>
                ) : null}
              </div>
              <RadixToast.Close className="toast-close" aria-label="토스트 닫기">
                <X size={14} aria-hidden />
              </RadixToast.Close>
            </RadixToast.Root>
          );
        })}
        <RadixToast.Viewport className="toast-viewport" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast는 ToastProvider 내부에서만 사용할 수 있습니다.");
  }
  return context;
}
