import { create } from 'zustand';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  key?: string;
  tone: ToastTone;
  title: string;
  description?: string;
  progress?: number;
  /** Botão de ação primária (ex.: "Aprovar e criar"). */
  action?: ToastAction;
  /** Clique no corpo do toast (ex.: ir pra Caixa de entrada). */
  onClick?: () => void;
}

type ToastInput = Omit<ToastItem, 'id'> & { durationMs?: number | null };

interface ToastState {
  toasts: ToastItem[];
  push: (t: ToastInput) => string;
  dismiss: (id: string) => void;
  dismissKey: (key: string) => void;
}

let seq = 0;
const TTL_MS = 4200;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    if (t.key) {
      let existingId: string | null = null;
      set((s) => {
        const existing = s.toasts.find((x) => x.key === t.key);
        if (!existing) return s;
        existingId = existing.id;
        return {
          toasts: s.toasts.map((x) =>
            x.key === t.key
              ? {
                  ...x,
                  tone: t.tone,
                  title: t.title,
                  description: t.description,
                  progress: t.progress,
                  action: t.action,
                  onClick: t.onClick,
                }
              : x,
          ),
        };
      });
      if (existingId) return existingId;
    }
    const id = `toast-${++seq}`;
    const { durationMs, ...toast } = t;
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
    const ttl = durationMs === undefined ? TTL_MS : durationMs;
    if (ttl !== null) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
      }, ttl);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  dismissKey: (key) => set((s) => ({ toasts: s.toasts.filter((x) => x.key !== key) })),
}));

/** Helper imperativo — chame de qualquer lugar: `toast.success('Plano aprovado')`. */
export const toast = {
  success: (
    title: string,
    description?: string,
    options?: Omit<ToastInput, 'tone' | 'title' | 'description'>,
  ) => useToastStore.getState().push({ tone: 'success', title, description, ...options }),
  error: (
    title: string,
    description?: string,
    options?: Omit<ToastInput, 'tone' | 'title' | 'description'>,
  ) => useToastStore.getState().push({ tone: 'error', title, description, ...options }),
  info: (
    title: string,
    description?: string,
    options?: Omit<ToastInput, 'tone' | 'title' | 'description'>,
  ) => useToastStore.getState().push({ tone: 'info', title, description, ...options }),
  /** Toast rico com ação/clique (ex.: proposta do inbox). */
  custom: (opts: ToastInput) => useToastStore.getState().push(opts),
  dismissKey: (key: string) => useToastStore.getState().dismissKey(key),
};
