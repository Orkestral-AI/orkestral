import { app, BrowserWindow } from '../../platform/electron';
import { registerHandler } from '../register';

/**
 * Handlers de integração com o SO / janela que não pertencem ao registro de
 * settings em si, mas são disparados pelo renderer quando o usuário muda uma
 * configuração de Sistema/Aparência.
 *
 * Tudo é best-effort e nunca lança — em ambientes onde a API não existe
 * (alguns Linux/dev) simplesmente ignora.
 */
export function registerSystemHandlers(): void {
  // Zoom global — o lever real pra "Tamanho de fonte" + "Densidade" num app com
  // px hardcoded. setZoomFactor escala TODA a UI (texto + espaçamento juntos).
  registerHandler('system:set-zoom', (req) => {
    try {
      const factor = Number.isFinite(req.factor) ? req.factor : 1;
      const clamped = Math.min(1.4, Math.max(0.7, factor));
      // Headless (sem Electron): não há janela — no-op, coerente com o "nunca lança".
      for (const win of BrowserWindow?.getAllWindows() ?? []) {
        try {
          win.webContents.setZoomFactor(clamped);
        } catch {
          // ignore janela individual
        }
      }
    } catch {
      // ignore
    }
    return { ok: true as const };
  });

  // Traz a janela principal pro foreground. Disparado pelo clique numa
  // notificação nativa: `window.focus()` no renderer só foca o webContents, não
  // levanta a janela do background — quem faz isso é o main (show()/focus() +
  // app.focus no macOS). Best-effort, nunca lança.
  registerHandler('system:focus-window', () => {
    try {
      const win = BrowserWindow?.getAllWindows().find((w) => !w.isDestroyed()) ?? undefined;
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      if (process.platform === 'darwin') {
        void app?.dock?.show().catch(() => {});
        app?.focus({ steal: true });
      }
    } catch {
      // ignore
    }
    return { ok: true as const };
  });

  // Visibilidade no Dock (macOS). Tray completo está fora de escopo; aqui
  // fazemos a parte viável: 'status'-only esconde o Dock; demais mostram.
  registerHandler('system:apply-visibility', (req) => {
    try {
      if (process.platform === 'darwin') {
        if (req.showAppIn === 'status') {
          app?.dock?.hide();
        } else {
          void app?.dock?.show().catch(() => {});
        }
      }
    } catch {
      // ignore
    }
    return { ok: true as const };
  });
}
