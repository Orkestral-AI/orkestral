import { useEffect, useRef, useState } from 'react';
import {
  RotateCw,
  ExternalLink,
  Monitor,
  Tablet,
  Smartphone,
  Globe,
  MousePointerClick,
  Bug,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent } from '@renderer/components/ui/tooltip';
import { useT } from '@renderer/i18n';
import { usePreviewStore, previewUrlFor } from '@renderer/stores/previewStore';
import { useIdeChatStore } from '@renderer/stores/ideChatStore';

/** Métodos do <webview> do Electron que usamos. */
interface WebviewEl extends HTMLElement {
  src: string;
  reload(): void;
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
  getWebContentsId(): number;
}

/**
 * Script injetado no guest (via executeJavaScript no dom-ready) — não depende de
 * preload (que não carrega no contexto sandbox do webview). No modo seleção:
 * borda no hover, bloqueia o clique e reporta o elemento via console.log('ORK_PICK:…')
 * que o host captura no evento console-message. Detecta React (_debugSource) → Vue → DOM.
 */
const INJECT = `(function(){
  if (window.__orkSelInit) return; window.__orkSelInit = true;
  var selecting=false, overlay=null;
  function ov(){ if(overlay) return overlay; overlay=document.createElement('div');
    overlay.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #a78bfa;background:rgba(167,139,250,0.15);border-radius:3px;transition:all .04s;display:none'; document.documentElement.appendChild(overlay); return overlay; }
  function move(el){ var r=el.getBoundingClientRect(), o=ov(); o.style.display='block'; o.style.left=r.left+'px'; o.style.top=r.top+'px'; o.style.width=r.width+'px'; o.style.height=r.height+'px'; }
  function fromReact(el){ var k=Object.keys(el).find(function(x){return x.indexOf('__reactFiber$')===0}); if(!k) return null; var f=el[k], file,line,comp; for(var i=0; f && i<30; i++){ if(!file && f._debugSource){file=f._debugSource.fileName; line=f._debugSource.lineNumber;} var tp=f.type; if(!comp && tp && typeof tp!=='string' && (tp.displayName||tp.name)) comp=tp.displayName||tp.name; if(file&&comp) break; f=f.return;} if(!file&&!comp) return null; return {framework:'react',file:file,line:line,component:comp}; }
  function fromVue(el){ var inst=el.__vueParentComponent; var tp=inst&&inst.type; if(!tp||(!tp.__file&&!tp.name)) return null; return {framework:'vue',file:tp.__file,component:tp.name}; }
  function sel(el){ if(el.id) return '#'+el.id; var parts=[],n=el; for(var i=0;n&&i<4&&n.nodeType===1;i++){ var p=n.tagName.toLowerCase(); var c=(n.getAttribute('class')||'').trim().split(/\\s+/).filter(Boolean).slice(0,2); if(c.length) p+='.'+c.join('.'); parts.unshift(p); n=n.parentElement;} return parts.join(' > '); }
  function describe(el){ var b=fromReact(el)||fromVue(el)||{framework:'dom'}; return {framework:b.framework||'dom',file:b.file,line:b.line,component:b.component,tag:el.tagName.toLowerCase(),selector:sel(el),text:(el.textContent||'').trim().slice(0,80)||undefined}; }
  window.__orkSetSelect=function(on){ selecting=!!on; document.documentElement.style.cursor=on?'crosshair':''; if(!on&&overlay) overlay.style.display='none'; };
  window.addEventListener('mousemove',function(e){ if(!selecting) return; if(e.target&&e.target.nodeType===1) move(e.target); },true);
  window.addEventListener('click',function(e){ if(!selecting) return; e.preventDefault(); e.stopPropagation(); if(e.target&&e.target.nodeType===1) console.log('ORK_PICK:'+JSON.stringify(describe(e.target))); },true);
})();`;

type Device = 'desktop' | 'tablet' | 'mobile';
const DEVICES: Array<{ key: Device; icon: typeof Monitor; width: number | null }> = [
  { key: 'desktop', icon: Monitor, width: null },
  { key: 'tablet', icon: Tablet, width: 834 },
  { key: 'mobile', icon: Smartphone, width: 390 },
];

/**
 * Painel de Preview (tab Preview da source) — mostra o dev server rodando num
 * <webview> isolado. A URL vem auto-detectada do terminal (Vite "Local: …") ou
 * digitada na barra. Toolbar: reload, abrir externo, tamanhos responsivos, seleção de elemento.
 */
export function PreviewPanel({ sourceId, sourceRoot }: { sourceId: string; sourceRoot?: string }) {
  const { t } = useT();
  const detected = usePreviewStore((s) => s.detected);
  const manual = usePreviewStore((s) => s.manual);
  const setManual = usePreviewStore((s) => s.setManual);
  const url = previewUrlFor({ detected, manual }, sourceId);

  const selecting = useIdeChatStore((s) => s.selecting);
  const setSelecting = useIdeChatStore((s) => s.setSelecting);

  const [device, setDevice] = useState<Device>('desktop');
  const [loading, setLoading] = useState(false);
  const webviewRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);

  // O agente do chat editou um arquivo de FATO (tool_result sem erro) → recarrega o preview
  // (o HMR do dev server nem sempre pega). Fecha o loop visual mesmo quando o dev server não
  // recarrega sozinho.
  useEffect(() => {
    // Guarda defensiva: o preload pode estar dessincronizado do renderer (dev sem restart,
    // ou build antigo) e não expor o método ainda — sem isto, um preload velho QUEBRAVA a UI
    // inteira com "onPreviewReload is not a function".
    if (typeof window.orkestralEvents?.onPreviewReload !== 'function') return;
    return window.orkestralEvents.onPreviewReload(() => {
      try {
        (webviewRef.current as WebviewEl | null)?.reload();
      } catch {
        /* webview ainda não montado/pronto — ignora */
      }
    });
  }, []);

  // Loading + barra acompanha navegação interna. No dom-ready injeta o script de
  // seleção e ressincroniza o estado. Captura os picks via console-message (ORK_PICK:…).
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const start = () => setLoading(true);
    const stop = () => setLoading(false);
    const nav = (e: Event) => {
      const u = (e as unknown as { url?: string }).url;
      if (u && inputRef.current) inputRef.current.value = u;
    };
    const onDomReady = () => {
      const el = wv as unknown as WebviewEl;
      try {
        el.executeJavaScript(INJECT)
          .then(() =>
            el.executeJavaScript(
              `window.__orkSetSelect && window.__orkSetSelect(${useIdeChatStore.getState().selecting})`,
            ),
          )
          .catch(() => undefined);
      } catch {
        /* webview detachou entre o dom-ready e a injeção — ignora */
      }
    };
    const onConsole = (e: Event) => {
      const msg = (e as unknown as { message?: string }).message ?? '';
      if (!msg.startsWith('ORK_PICK:')) return;
      let sel: {
        framework: 'react' | 'vue' | 'dom';
        file?: string;
        line?: number;
        component?: string;
        tag: string;
        selector: string;
        text?: string;
      };
      try {
        sel = JSON.parse(msg.slice('ORK_PICK:'.length));
      } catch {
        return;
      }
      const root = sourceRoot
        ? sourceRoot.endsWith('/')
          ? sourceRoot.slice(0, -1)
          : sourceRoot
        : undefined;
      const file =
        sel.file && root && sel.file.startsWith(root) ? sel.file.slice(root.length + 1) : sel.file;
      useIdeChatStore.getState().addSelection({ ...sel, file });
    };
    wv.addEventListener('did-start-loading', start);
    wv.addEventListener('did-stop-loading', stop);
    wv.addEventListener('did-navigate', nav);
    wv.addEventListener('did-navigate-in-page', nav);
    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('console-message', onConsole);
    return () => {
      wv.removeEventListener('did-start-loading', start);
      wv.removeEventListener('did-stop-loading', stop);
      wv.removeEventListener('did-navigate', nav);
      wv.removeEventListener('did-navigate-in-page', nav);
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('console-message', onConsole);
    };
  }, [url, sourceRoot]);

  // Toggle do modo seleção → empurra pro guest. dom-ready ressincroniza no load.
  // try/catch SÍNCRONO: `executeJavaScript` LANÇA na hora (não rejeita a Promise)
  // se o webview ainda não está anexado/dom-ready — sem isso o app crashava ao
  // abrir o preview antes do guest carregar. O onDomReady ressincroniza no load.
  useEffect(() => {
    const wv = webviewRef.current as unknown as WebviewEl | null;
    if (!wv) return;
    try {
      wv.executeJavaScript(`window.__orkSetSelect && window.__orkSetSelect(${selecting})`).catch(
        () => undefined,
      );
    } catch {
      /* webview ainda não pronto — ignora */
    }
  }, [selecting]);

  const reload = () => (webviewRef.current as unknown as WebviewEl | null)?.reload();

  // DevTools em janela própria (mode:'detach'). Embed via 2º <webview> não rola: o
  // inspector de um webview-guest não casa com um webview-host no Electron (frontend
  // carrega mas Elements/Styles ficam vazios). Janela separada mostra o DOM real.
  const toggleDevTools = () => {
    const wv = webviewRef.current as unknown as WebviewEl | null;
    if (!wv) return;
    try {
      void window.orkestral['webview:set-devtools']({
        targetId: wv.getWebContentsId(),
        open: !devtoolsOpen,
      });
    } catch {
      // webview ainda não anexado — ignora
    }
    setDevtoolsOpen((v) => !v);
  };
  const deviceWidth = DEVICES.find((d) => d.key === device)?.width ?? null;
  const deviceLabel = (k: Device) =>
    k === 'desktop'
      ? t('layout.codeIde.preview.device.desktop')
      : k === 'tablet'
        ? t('layout.codeIde.preview.device.tablet')
        : t('layout.codeIde.preview.device.mobile');

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline-soft px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={reload}
              disabled={!url}
              aria-label={t('layout.codeIde.preview.reload')}
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-text-muted transition-colors hover:bg-surface-subtle hover:text-text-primary disabled:opacity-40"
            >
              <RotateCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('layout.codeIde.preview.reload')}
          </TooltipContent>
        </Tooltip>

        <form
          className="flex h-7 min-w-0 flex-1 items-center rounded border border-hairline bg-surface-1 px-2 focus-within:border-accent-purple/40"
          onSubmit={(e) => {
            e.preventDefault();
            setManual(sourceId, (inputRef.current?.value ?? '').trim());
          }}
        >
          <Globe className="mr-1.5 h-3.5 w-3.5 shrink-0 text-text-faint" />
          {/* Não-controlado + key={url}: reflete a URL efetiva (auto-detect) sem
              setState-em-effect; o usuário edita livre e confirma no Enter. */}
          <input
            key={url}
            ref={inputRef}
            defaultValue={url}
            placeholder={t('layout.codeIde.preview.urlPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text-primary outline-none placeholder:text-text-faint"
          />
        </form>

        <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-surface-subtle p-0.5">
          {DEVICES.map(({ key, icon: Icon }) => (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setDevice(key)}
                  aria-pressed={device === key}
                  aria-label={deviceLabel(key)}
                  className={cn(
                    'grid h-6 w-7 place-items-center rounded transition-colors',
                    device === key
                      ? 'bg-surface-1 text-text-primary shadow-sm'
                      : 'text-text-faint hover:text-text-secondary',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {deviceLabel(key)}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setSelecting(!selecting)}
              aria-pressed={selecting}
              aria-label={t('layout.codeIde.preview.select')}
              className={cn(
                'grid h-7 w-7 shrink-0 place-items-center rounded transition-colors',
                selecting
                  ? 'bg-surface-1 text-text-primary shadow-sm'
                  : 'text-text-muted hover:bg-surface-subtle hover:text-text-primary',
              )}
            >
              <MousePointerClick className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('layout.codeIde.preview.select')}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleDevTools}
              disabled={!url}
              aria-pressed={devtoolsOpen}
              aria-label={t('layout.codeIde.preview.devtools')}
              className={cn(
                'grid h-7 w-7 shrink-0 place-items-center rounded transition-colors disabled:opacity-40',
                devtoolsOpen
                  ? 'bg-surface-1 text-text-primary shadow-sm'
                  : 'text-text-muted hover:bg-surface-subtle hover:text-text-primary',
              )}
            >
              <Bug className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('layout.codeIde.preview.devtools')}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')}
              disabled={!url}
              aria-label={t('layout.codeIde.preview.openExternal')}
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-text-muted transition-colors hover:bg-surface-subtle hover:text-text-primary disabled:opacity-40"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('layout.codeIde.preview.openExternal')}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Corpo */}
      {url ? (
        <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-surface-faint p-0">
          <div
            className="h-full bg-white"
            style={{ width: deviceWidth ?? '100%', maxWidth: '100%' }}
          >
            <webview
              ref={webviewRef}
              src={url}
              className="h-full w-full"
              style={{ display: 'inline-flex', width: '100%', height: '100%' }}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-text-muted">
          <Globe className="h-7 w-7 opacity-50" />
          <p className="text-[13px]">{t('layout.codeIde.preview.emptyTitle')}</p>
          <p className="max-w-xs text-[11.5px] text-text-faint">
            {t('layout.codeIde.preview.emptyHint')}
          </p>
        </div>
      )}
    </div>
  );
}
