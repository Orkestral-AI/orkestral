import { useEffect } from 'react';
import { useUIStore } from '@renderer/stores/uiStore';

/**
 * Atalhos de teclado do app — FONTE ÚNICA de verdade.
 *
 * O array `SHORTCUTS` lista APENAS atalhos que estão de fato implementados, e é
 * consumido tanto por este hook (que registra os que faltam) quanto pelo painel
 * de Configurações → Atalhos. Assim a lista exibida nunca diverge do que existe.
 *
 * Onde cada um é wired:
 *  - ⌘K  (command palette) → CommandPalette.tsx (listener próprio)
 *  - ⌘,  (configurações)   → SettingsModal.tsx (listener próprio)
 *  - Enter / Shift+Enter   → Composer.tsx (envio / nova linha)
 *  - Esc                   → modais/overlays (CommandPalette, dialogs)
 *  - ⌘N  (nova conversa)   → ESTE hook
 *  - ⌘B  (sidebar)         → ESTE hook
 */

export type ShortcutGroup = 'Navegação' | 'Chat' | 'Geral';

export interface ShortcutDef {
  id: string;
  /** Teclas já formatadas pra exibição (uma por chip). */
  keys: string[];
  label: string;
  group: ShortcutGroup;
}

const MOD = '⌘';

export const SHORTCUTS: ShortcutDef[] = [
  // Navegação
  {
    id: 'command-palette',
    keys: [MOD, 'K'],
    label: 'Abrir paleta de comandos',
    group: 'Navegação',
  },
  {
    id: 'toggle-sidebar',
    keys: [MOD, 'B'],
    label: 'Mostrar/ocultar a barra lateral',
    group: 'Navegação',
  },
  // Chat
  { id: 'new-chat', keys: [MOD, 'N'], label: 'Nova conversa', group: 'Chat' },
  { id: 'send-message', keys: ['Enter'], label: 'Enviar mensagem', group: 'Chat' },
  { id: 'newline', keys: ['Shift', 'Enter'], label: 'Quebra de linha no editor', group: 'Chat' },
  // Geral
  { id: 'settings', keys: [MOD, ','], label: 'Abrir configurações', group: 'Geral' },
  { id: 'close', keys: ['Esc'], label: 'Fechar diálogo / paleta', group: 'Geral' },
];

/** Ordem de exibição dos grupos no painel. */
export const SHORTCUT_GROUP_ORDER: ShortcutGroup[] = ['Navegação', 'Chat', 'Geral'];

/** True quando o foco está num campo editável (não disparar atalhos de ação). */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * Registra os atalhos globais que ainda não têm dono (⌘N, ⌘B). Os demais
 * (⌘K, ⌘,, Enter, Esc) já são tratados nos seus próprios componentes — não
 * duplicamos aqui pra evitar double-fire.
 *
 * Montar UMA vez (no AppShell). Idempotente em re-render via deps estáveis.
 */
export function useKeyboardShortcuts(): void {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      // ⌘B — mostrar/ocultar barra lateral. Funciona mesmo digitando.
      if (key === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // ⌘N — nova conversa. Não rouba o atalho de campos editáveis.
      if (key === 'n' && !isEditableTarget(e.target)) {
        e.preventDefault();
        window.location.hash = '#/';
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);
}
