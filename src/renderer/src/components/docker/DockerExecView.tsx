import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * Shell (exec) dentro de um container Docker, reusando xterm. Self-contained:
 * abre uma sessão `docker:exec-start` no mount e mata no unmount. O I/O passa
 * pelos eventos `docker:exec-data` / `docker:exec-exit` (mesmo padrão do terminal).
 */
export function DockerExecView({ id }: { id: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      theme: { background: '#16181a' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let execId: string | null = null;
    let disposed = false;

    // Escuta antes de abrir o exec; filtra pelo execId quando ele chegar.
    const offData = window.orkestralEvents.onDockerExecData((e) => {
      if (e.execId === execId) term.write(e.data);
    });
    const offExit = window.orkestralEvents.onDockerExecExit((e) => {
      if (e.execId === execId) term.write('\r\n\x1b[90m[sessão encerrada]\x1b[0m\r\n');
    });

    term.onData((data) => {
      if (execId) window.orkestral['docker:exec-input']({ execId, data }).catch(() => undefined);
    });

    window.orkestral['docker:exec-start']({ id, cols: term.cols, rows: term.rows })
      .then((r) => {
        if (disposed) {
          // Componente desmontou antes do start resolver — mata na hora.
          window.orkestral['docker:exec-kill']({ execId: r.execId }).catch(() => undefined);
          return;
        }
        execId = r.execId;
      })
      .catch(() => term.write('\r\n\x1b[31mNão foi possível abrir o shell.\x1b[0m\r\n'));

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (execId) {
          window.orkestral['docker:exec-resize']({
            execId,
            cols: term.cols,
            rows: term.rows,
          }).catch(() => undefined);
        }
      } catch {
        // host pode estar sumindo — ignora
      }
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      offData();
      offExit();
      if (execId) window.orkestral['docker:exec-kill']({ execId }).catch(() => undefined);
      term.dispose();
    };
  }, [id]);

  return <div ref={hostRef} className="h-full w-full" />;
}
