import { useSettingsStore } from '@renderer/stores/settingsStore';
import { useUIStore } from '@renderer/stores/uiStore';
import { translate, resolveLanguage } from '@renderer/i18n';

/**
 * Traz o app pro foreground via main (BrowserWindow.focus). `window.focus()` no
 * renderer só foca o webContents — não levanta a janela do background. Disparado
 * no clique da notificação, antes de navegar. Best-effort; nunca lança.
 */
function focusAppWindow(): void {
  try {
    (
      window as Window & {
        orkestral?: { 'system:focus-window'?: () => Promise<unknown> };
      }
    ).orkestral?.['system:focus-window']?.();
  } catch {
    // ignore
  }
}

const chatCompletionNotifications = new Set<string>();

function systemNotificationPrefs(): {
  notifications: boolean;
  notificationSound: boolean;
  inboxNotifications: boolean;
} {
  const system = useSettingsStore.getState().settings?.system;
  return {
    notifications: system?.notifications ?? true,
    notificationSound: system?.notificationSound ?? true,
    inboxNotifications: system?.inboxNotifications ?? true,
  };
}

export function armChatCompletionNotification(sessionId: string): void {
  chatCompletionNotifications.add(sessionId);
}

export function consumeChatCompletionNotification(sessionId: string): boolean {
  if (!chatCompletionNotifications.has(sessionId)) return false;
  chatCompletionNotifications.delete(sessionId);
  return true;
}

/**
 * Notificações de "agente respondeu".
 *
 * Tudo aqui é best-effort e SEMPRE gated pelas settings do sistema:
 *  - `system.notifications` liga a notificação nativa (Notification API, que o
 *    renderer do Electron suporta direto).
 *  - `system.notificationSound` liga um blip curto via WebAudio (zero asset).
 *
 * Nunca lança: se a API não existir ou der erro, simplesmente ignora.
 */

/** Toca um blip suave de duas notas (660Hz → 880Hz) via WebAudio. */
export function playNotificationSound(): void {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;

    const playTone = (freq: number, start: number, dur: number): void => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // Envelope rápido e baixo pra ficar agradável (não estridente).
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.05, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    };

    playTone(660, 0, 0.15);
    playTone(880, 0.08, 0.15);

    // Fecha o contexto depois do som pra não vazar.
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 400);
  } catch {
    // ignore
  }
}

/**
 * Dispara notificação (nativa + som) quando um agente termina de responder.
 * Lê as settings internamente e respeita os toggles. Só notifica quando a
 * janela NÃO está em foco — o caller já garante que a sessão não é a ativa.
 */
export function notifyAgentReply({ title, sessionId }: { title: string; sessionId: string }): void {
  try {
    const system = systemNotificationPrefs();

    const windowUnfocused =
      typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
    if (!windowUnfocused) return;

    if (system.notifications && typeof Notification !== 'undefined') {
      try {
        const lang = resolveLanguage(useSettingsStore.getState().settings?.appearance.language);
        const notif = new Notification('Orkestral', {
          body: translate(lang, 'layout.notify.agentReplied', { title }),
        });
        notif.onclick = () => {
          try {
            focusAppWindow();
            window.focus();
            window.location.hash = `#/session/${sessionId}`;
          } catch {
            // ignore
          }
        };
      } catch {
        // ignore — Notification pode não estar disponível
      }
    }

    if (system.notificationSound) {
      playNotificationSound();
    }
  } catch {
    // ignore
  }
}

export function notifyChatTaskDone({
  title,
  sessionId,
}: {
  title: string;
  sessionId: string;
}): void {
  try {
    const system = systemNotificationPrefs();

    if (system.notifications && typeof Notification !== 'undefined') {
      try {
        const lang = resolveLanguage(useSettingsStore.getState().settings?.appearance.language);
        const notif = new Notification('Orkestral', {
          body: translate(lang, 'layout.notify.agentReplied', { title }),
        });
        notif.onclick = () => {
          try {
            focusAppWindow();
            window.focus();
            window.location.hash = `#/session/${sessionId}`;
          } catch {
            // ignore
          }
        };
      } catch {
        // ignore
      }
    }

    if (system.notificationSound) {
      playNotificationSound();
    }
  } catch {
    // ignore
  }
}

/**
 * Alerta de trabalho (issue nova, item novo no Inbox, proposta) — notificação
 * nativa + som. Dispara SEMPRE que houver item novo, MESMO com o app em foco:
 * o trabalho do agente é assíncrono e o usuário pode estar em outra tela do app
 * (ex: editando um objetivo) quando um plano cai pra aprovar. Gated por
 * `system.inboxNotifications` (master de alertas de trabalho),
 * `system.notifications` (visual) e `system.notificationSound` (som).
 * `route` = pra onde o clique leva.
 */
function fireWorkAlert(title: string, route: string): void {
  try {
    const system = systemNotificationPrefs();
    if (!system.inboxNotifications) return;

    if (system.notifications && typeof Notification !== 'undefined') {
      try {
        const notif = new Notification('Orkestral', { body: title });
        notif.onclick = () => {
          try {
            focusAppWindow();
            window.focus();
            window.location.hash = route;
          } catch {
            // ignore
          }
        };
      } catch {
        // ignore
      }
    }
    if (system.notificationSound) {
      playNotificationSound();
    }
  } catch {
    // ignore
  }
}

/** Tarefa nova no Inbox (proposta, plano p/ aprovar, revisão, bloqueio). */
export function notifyInboxTask(title: string): void {
  fireWorkAlert(title, '#/inbox');
}

/** Issue nova criada (geralmente por um agente). Leva pra lista de Issues. */
export function notifyNewIssue(title: string): void {
  fireWorkAlert(title, '#/issues');
}

/** Issue principal (épica) concluída — todos os filhos terminaram. */
export function notifyIssueDone(message: string): void {
  fireWorkAlert(message, '#/issues');
}

export function notifyDataCleanupSuggested(message: string): void {
  try {
    const system = systemNotificationPrefs();

    if (system.notifications && typeof Notification !== 'undefined') {
      try {
        const notif = new Notification('Orkestral', { body: message });
        notif.onclick = () => {
          try {
            focusAppWindow();
            window.focus();
            useUIStore.getState().openSettings('data');
          } catch {
            // ignore
          }
        };
      } catch {
        // ignore
      }
    }
    if (system.notificationSound) {
      playNotificationSound();
    }
  } catch {
    // ignore
  }
}

export function notifyKnowledgeIndexed(message: string): void {
  fireWorkAlert(message, '#/knowledge');
}
