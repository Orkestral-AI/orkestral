import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  Plus,
  X,
  Terminal as TerminalIcon,
  Trash2,
  Copy,
  ClipboardPaste,
  Eraser,
  ArrowDownToLine,
  TextSelect,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import {
  useContextMenu,
  ContextMenu,
  type ContextMenuItem,
} from '@renderer/components/ui/context-menu';
import { useT } from '@renderer/i18n';
import { useUIStore } from '@renderer/stores/uiStore';
import { useCodeIdeStore } from '@renderer/stores/codeIdeStore';
import { useTerminalStore } from '@renderer/stores/terminalStore';
import { usePreviewStore } from '@renderer/stores/previewStore';

/** Copia/cola/limpa via teclado, estilo VS Code (Mac: Cmd; Win/Linux: Ctrl+Shift). */
function attachShortcuts(term: Terminal, id: string): void {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    const copy = (e.metaKey && k === 'c') || (e.ctrlKey && e.shiftKey && k === 'c');
    const paste = (e.metaKey && k === 'v') || (e.ctrlKey && e.shiftKey && k === 'v');
    const clear = (e.metaKey || e.ctrlKey) && !e.shiftKey && k === 'k';
    if (copy) {
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => undefined);
        e.preventDefault();
        return false;
      }
      return true; // nada selecionado → deixa o terminal lidar (ex.: Ctrl+C = interrupt)
    }
    if (paste) {
      navigator.clipboard
        .readText()
        .then((txt) => window.orkestral['terminal:input']({ id, data: txt }))
        .catch(() => undefined);
      e.preventDefault();
      return false;
    }
    if (clear) {
      term.clear();
      e.preventDefault();
      e.stopPropagation(); // não deixa o Cmd+K abrir a busca global do app
      return false;
    }
    return true;
  });
}

/** Lê o tema do xterm a partir dos tokens do app (respeita dark/light). */
function readXtermTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--color-background', '#111213'),
    foreground: v('--color-text-primary', '#f4f4f5'),
    cursor: v('--color-accent-purple', '#a78bfa'),
    cursorAccent: v('--color-background', '#111213'),
    selectionBackground: 'rgba(120,150,255,0.28)',
  };
}

/**
 * Um terminal (xterm). NÃO cria o pty — o painel cria via `terminal:create` e passa
 * o id pronto. Aqui só monta o xterm, registra a instância no painel (pra receber
 * o output bufferizado), manda input/resize e ajusta o tamanho (fit) ao container.
 */
function XtermView({
  id,
  active,
  onReady,
  onUnready,
  onLink,
}: {
  id: string;
  active: boolean;
  onReady: (id: string, term: Terminal) => void;
  onUnready: (id: string) => void;
  onLink: (uri: string) => void;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: true,
      scrollback: 5000,
      theme: readXtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Links clicáveis (Cmd/Ctrl+click). localhost vai pro Preview; resto pro
    // navegador (quem decide é o onLink do painel). Sem modificador, clique seleciona.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.metaKey || event.ctrlKey) onLink(uri);
      }),
    );
    term.open(el);
    attachShortcuts(term, id);
    termRef.current = term;
    fitRef.current = fit;

    const syncSize = () => {
      try {
        fit.fit();
      } catch {
        // container ainda sem tamanho — ignora
      }
      window.orkestral['terminal:resize']({ id, cols: term.cols, rows: term.rows }).catch(
        () => undefined,
      );
    };

    requestAnimationFrame(syncSize);
    const dataSub = term.onData((data) =>
      window.orkestral['terminal:input']({ id, data }).catch(() => undefined),
    );
    onReady(id, term);

    const ro = new ResizeObserver(() => syncSize());
    ro.observe(el);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      onUnready(id);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Uma instância por id; handlers são estáveis (useCallback no painel).
  }, [id, onReady, onUnready, onLink]);

  // Ao virar ativo (sai do display:none), re-fit + foca.
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // ignora
      }
      const t = termRef.current;
      if (t) {
        window.orkestral['terminal:resize']({ id, cols: t.cols, rows: t.rows }).catch(
          () => undefined,
        );
        t.focus();
      }
    });
  }, [active, id]);

  return <div ref={elRef} className={cn('h-full w-full', { hidden: !active })} />;
}

export function TerminalPanel({ sourceId, cwd }: { sourceId: string; cwd: string }) {
  const { t } = useT();
  const terminals = useTerminalStore((s) => s.terminals);
  const activeBySource = useTerminalStore((s) => s.activeBySource);
  const setActive = useTerminalStore((s) => s.setActive);

  // Terminais deste source (repo) + qual está ativo aqui.
  const mine = terminals.filter((tm) => tm.sourceId === sourceId);
  const activeFromStore = activeBySource[sourceId] ?? null;
  const activeId = mine.some((tm) => tm.id === activeFromStore)
    ? activeFromStore
    : (mine[0]?.id ?? null);

  const height = useUIStore((s) => s.terminalHeight);
  const setHeight = useUIStore((s) => s.setTerminalHeight);
  const toggleTerminal = useCodeIdeStore((s) => s.toggleTerminal);

  const areaMenu = useContextMenu();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');

  // Instâncias xterm vivas + buffer de output que chega antes do xterm registrar.
  const instances = useRef<Map<string, Terminal>>(new Map());
  const pending = useRef<Map<string, string[]>>(new Map());
  // Sources já auto-inicializados (guarda contra duplo-mount do StrictMode e
  // garante 1 terminal automático por source na 1ª abertura).
  const initedSources = useRef<Set<string>>(new Set());

  const onReady = useCallback((id: string, term: Terminal) => {
    instances.current.set(id, term);
    const buf = pending.current.get(id);
    if (buf) {
      for (const chunk of buf) term.write(chunk);
      pending.current.delete(id);
    }
  }, []);

  const onUnready = useCallback((id: string) => {
    instances.current.delete(id);
  }, []);

  const createTerminal = useCallback(async () => {
    try {
      // meta = sourceId: marca o PTY no main pra o re-attach (terminal:list) reassociar a aba.
      const { id } = await window.orkestral['terminal:create']({ cwd, meta: sourceId });
      useTerminalStore.getState().addTerminal(sourceId, id);
    } catch {
      // falha ao spawnar — silencioso por ora
    }
  }, [cwd, sourceId]);

  const closeTerminal = useCallback((id: string) => {
    window.orkestral['terminal:kill']({ id }).catch(() => undefined);
    useTerminalStore.getState().removeTerminal(id);
  }, []);

  // Cmd/Ctrl+click num link: localhost abre no Preview (desta source); resto no navegador.
  const onLink = useCallback(
    (uri: string) => {
      const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)/i.test(uri);
      if (local) usePreviewStore.getState().requestOpen(sourceId, uri);
      else window.open(uri, '_blank', 'noopener,noreferrer');
    },
    [sourceId],
  );

  const commitRename = (id: string) => {
    const name = renameVal.trim();
    if (name) useTerminalStore.getState().renameTerminal(id, name);
    setRenamingId(null);
  };

  // Menu de clique-direito na área do terminal — atua no terminal ativo.
  const activeTerm = () => (activeId ? instances.current.get(activeId) : null);
  const ICON = 'h-3.5 w-3.5';
  const areaItems: ContextMenuItem[] = [
    {
      label: t('layout.codeIde.terminalCopy'),
      icon: <Copy className={ICON} />,
      onSelect: () => {
        const sel = activeTerm()?.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => undefined);
        }
      },
    },
    {
      label: t('layout.codeIde.terminalPaste'),
      icon: <ClipboardPaste className={ICON} />,
      onSelect: () => {
        if (!activeId) return;
        navigator.clipboard
          .readText()
          .then((txt) => window.orkestral['terminal:input']({ id: activeId, data: txt }))
          .catch(() => undefined);
      },
    },
    {
      label: t('layout.codeIde.terminalSelectAll'),
      icon: <TextSelect className={ICON} />,
      onSelect: () => activeTerm()?.selectAll(),
    },
    { type: 'separator' },
    {
      label: t('layout.codeIde.terminalClear'),
      icon: <Eraser className={ICON} />,
      onSelect: () => activeTerm()?.clear(),
    },
    {
      label: t('layout.codeIde.terminalScrollBottom'),
      icon: <ArrowDownToLine className={ICON} />,
      onSelect: () => activeTerm()?.scrollToBottom(),
    },
    { type: 'separator' },
    {
      label: t('layout.codeIde.terminalKill'),
      icon: <Trash2 className={ICON} />,
      danger: true,
      onSelect: () => activeId && closeTerminal(activeId),
    },
  ];

  // Listeners globais de output/exit — montados antes de qualquer create, então
  // o prompt inicial nunca se perde (vai pro buffer até o xterm registrar).
  useEffect(() => {
    const offData = window.orkestralEvents.onTerminalData(({ id, data }) => {
      const term = instances.current.get(id);
      if (term) {
        term.write(data);
      } else {
        const buf = pending.current.get(id) ?? [];
        buf.push(data);
        pending.current.set(id, buf);
      }
    });
    const offExit = window.orkestralEvents.onTerminalExit(({ id }) => {
      useTerminalStore.getState().removeTerminal(id);
    });
    return () => {
      offData();
      offExit();
    };
  }, []);

  // RE-ATTACH pós-reload + 1ª abertura. O PTY vive no main e SOBREVIVE ao reload do renderer;
  // o store, não. Sem re-attach, ao recarregar o app o terminal "sumia" e o processo (ex.: dev
  // server) virava FANTASMA — rodando no main, sem aba pra ver/matar. Aqui redescobrimos os
  // PTYs vivos deste source (terminal:list), restauramos as abas + replayamos o buffer; só
  // criamos um novo se não houver nenhum.
  useEffect(() => {
    if (initedSources.current.has(sourceId)) return;
    initedSources.current.add(sourceId);
    let cancelled = false;
    void (async () => {
      try {
        const live = await window.orkestral['terminal:list']();
        if (cancelled) return;
        const mineLive = live.filter((tm) => tm.meta === sourceId);
        if (mineLive.length > 0) {
          // Replay do buffer assim que o xterm da aba montar (onReady drena o pending).
          for (const tm of mineLive) if (tm.buffer) pending.current.set(tm.id, [tm.buffer]);
          useTerminalStore.getState().hydrate(mineLive.map((tm) => ({ id: tm.id, sourceId })));
          return;
        }
      } catch {
        // build sem terminal:list → segue criando do zero.
      }
      if (cancelled) return;
      const has = useTerminalStore.getState().terminals.some((tm) => tm.sourceId === sourceId);
      if (!has) createTerminal();
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId, createTerminal]);

  // Terminal criado pelo AGENTE (via MCP run_in_orkestral_terminal) → aparece ao vivo
  // na aba deste source. O buffer/output entra pelo onTerminalData global (pending)
  // até o xterm da aba montar. Guarda defensiva: preload pode estar defasado em dev.
  useEffect(() => {
    if (typeof window.orkestralEvents?.onTerminalCreated !== 'function') return;
    return window.orkestralEvents.onTerminalCreated(({ id, sourceId: sid }) => {
      if (sid !== sourceId) return;
      const has = useTerminalStore.getState().terminals.some((tm) => tm.id === id);
      if (!has) useTerminalStore.getState().addTerminal(sourceId, id);
    });
  }, [sourceId]);

  // Drag da borda de cima → ajusta altura (arrastar pra cima aumenta).
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: MouseEvent) => setHeight(startH - (ev.clientY - startY));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div className="relative flex shrink-0 flex-col border-t border-border" style={{ height }}>
      {/* Borda arrastável de cima */}
      <div
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={startResize}
        className="group absolute inset-x-0 -top-1 z-10 flex h-2 cursor-ns-resize items-center justify-center"
      >
        <span className="h-[3px] w-full bg-transparent transition-colors group-hover:bg-accent/40" />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Área dos terminais (xterm) */}
        <div className="relative min-w-0 flex-1 px-2 py-1" onContextMenu={areaMenu.open}>
          {mine.map((term) => (
            <XtermView
              key={term.id}
              id={term.id}
              active={term.id === activeId}
              onReady={onReady}
              onUnready={onUnready}
              onLink={onLink}
            />
          ))}
          {areaMenu.state && (
            <ContextMenu
              x={areaMenu.state.x}
              y={areaMenu.state.y}
              items={areaItems}
              onClose={areaMenu.close}
            />
          )}
        </div>

        {/* Lista de terminais à direita (estilo VS Code) */}
        <div className="flex w-44 shrink-0 flex-col border-l border-hairline-soft">
          <div className="flex h-7 shrink-0 items-center gap-1 px-2 text-[10.5px] font-semibold uppercase tracking-wider text-text-faint">
            <span className="flex-1 truncate">{t('layout.codeIde.terminal')}</span>
            <button
              type="button"
              onClick={createTerminal}
              title={t('layout.codeIde.terminalNew')}
              aria-label={t('layout.codeIde.terminalNew')}
              className="grid h-5 w-5 place-items-center rounded text-text-faint hover:bg-surface-6 hover:text-text-primary"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={toggleTerminal}
              title={t('layout.codeIde.tabClose')}
              aria-label={t('layout.codeIde.tabClose')}
              className="grid h-5 w-5 place-items-center rounded text-text-faint hover:bg-surface-6 hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {mine.map((term) => (
              <div
                key={term.id}
                onClick={() => setActive(sourceId, term.id)}
                className={cn(
                  'group flex h-7 cursor-pointer items-center gap-1.5 px-2 text-[12px] transition-colors',
                  {
                    'bg-surface-active text-text-primary': term.id === activeId,
                    'text-text-secondary hover:bg-surface-hover hover:text-text-primary':
                      term.id !== activeId,
                  },
                )}
              >
                <TerminalIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                {renamingId === term.id ? (
                  <input
                    autoFocus
                    value={renameVal}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(term.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(term.id);
                      else if (e.key === 'Escape') setRenamingId(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-accent-purple/50 bg-surface-1 px-1 text-[12px] text-text-primary outline-none"
                  />
                ) : (
                  <span
                    className="min-w-0 flex-1 truncate"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenameVal(term.name);
                      setRenamingId(term.id);
                    }}
                  >
                    {term.name}
                  </span>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(term.id);
                  }}
                  title={t('layout.codeIde.terminalKill')}
                  aria-label={t('layout.codeIde.terminalKill')}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded text-text-faint opacity-0 transition-opacity hover:bg-surface-strong hover:text-text-primary group-hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
