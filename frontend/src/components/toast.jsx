import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

// Small toast stack for phase-2 screens (409s and other server messages,
// contract §11). Success toasts are only ever pushed after a real 2xx.

const ToastContext = createContext(() => {});

export const useToast = () => useContext(ToastContext);

const KIND_STYLES = {
  error: 'border-red-200 bg-red-50 text-red-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  info: 'border-slate-200 bg-white text-slate-700',
};

const KIND_ICONS = {
  error: AlertTriangle,
  success: CheckCircle2,
  info: Info,
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const push = useCallback((message, kind = 'info') => {
    if (!message) return;
    const id = ++idRef.current;
    setToasts((list) => [...list, { id, message: String(message), kind }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 5500);
  }, []);

  const dismiss = (id) => setToasts((list) => list.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="no-print pointer-events-none fixed inset-x-0 top-3 z-[80] flex flex-col items-center gap-2 px-4">
        {toasts.map(({ id, message, kind }) => {
          const Icon = KIND_ICONS[kind] || Info;
          return (
            <div
              key={id}
              role="alert"
              className={`pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${
                KIND_STYLES[kind] || KIND_STYLES.info
              }`}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1 break-words font-medium">{message}</div>
              <button
                type="button"
                onClick={() => dismiss(id)}
                className="rounded p-0.5 opacity-60 hover:opacity-100"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
