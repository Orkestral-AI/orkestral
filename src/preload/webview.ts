import { ipcRenderer } from 'electron';

interface Selection {
  framework: 'react' | 'vue' | 'dom';
  file?: string;
  line?: number;
  component?: string;
  tag: string;
  selector: string;
  text?: string;
}

let selecting = false;
let overlay: HTMLElement | null = null;

function ensureOverlay(): HTMLElement {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #a78bfa;' +
    'background:rgba(167,139,250,0.12);border-radius:3px;transition:all .04s;display:none;';
  document.documentElement.appendChild(overlay);
  return overlay;
}

function moveOverlay(el: Element): void {
  const r = el.getBoundingClientRect();
  const o = ensureOverlay();
  o.style.display = 'block';
  o.style.left = `${r.left}px`;
  o.style.top = `${r.top}px`;
  o.style.width = `${r.width}px`;
  o.style.height = `${r.height}px`;
}

function fromReact(el: Element): Partial<Selection> | null {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  if (!key) return null;
  let fiber = (el as unknown as Record<string, unknown>)[key] as
    | {
        _debugSource?: { fileName: string; lineNumber: number };
        type?: unknown;
        return?: unknown;
      }
    | undefined;
  let file: string | undefined;
  let line: number | undefined;
  let component: string | undefined;
  for (let i = 0; fiber && i < 30; i++) {
    if (!file && fiber._debugSource) {
      file = fiber._debugSource.fileName;
      line = fiber._debugSource.lineNumber;
    }
    const tp = fiber.type as { name?: string; displayName?: string } | string | undefined;
    if (!component && tp && typeof tp !== 'string' && (tp.displayName || tp.name)) {
      component = tp.displayName || tp.name;
    }
    if (file && component) break;
    fiber = fiber.return as typeof fiber;
  }
  if (!file && !component) return null;
  return { framework: 'react', file, line, component };
}

function fromVue(el: Element): Partial<Selection> | null {
  const inst = (
    el as unknown as { __vueParentComponent?: { type?: { __file?: string; name?: string } } }
  ).__vueParentComponent;
  const type = inst?.type;
  if (!type?.__file && !type?.name) return null;
  return { framework: 'vue', file: type?.__file, component: type?.name };
}

function cssSelector(el: Element): string {
  if (el.id) return `#${el.id}`;
  const parts: string[] = [];
  let node: Element | null = el;
  for (let i = 0; node && i < 4 && node.nodeType === 1; i++) {
    let part = node.tagName.toLowerCase();
    const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) part += '.' + cls.join('.');
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

function describe(el: Element): Selection {
  const base = fromReact(el) ?? fromVue(el) ?? { framework: 'dom' as const };
  return {
    framework: base.framework ?? 'dom',
    file: base.file,
    line: base.line,
    component: base.component,
    tag: el.tagName.toLowerCase(),
    selector: cssSelector(el),
    text: (el.textContent || '').trim().slice(0, 80) || undefined,
  };
}

function onMove(e: MouseEvent): void {
  if (!selecting) return;
  const el = e.target as Element | null;
  if (el) moveOverlay(el);
}

function onClick(e: MouseEvent): void {
  if (!selecting) return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.target as Element | null;
  if (el) ipcRenderer.sendToHost('element-picked', describe(el));
}

ipcRenderer.on('set-select', (_e, on: boolean) => {
  selecting = on;
  document.documentElement.style.cursor = on ? 'crosshair' : '';
  if (!on && overlay) overlay.style.display = 'none';
});

window.addEventListener('mousemove', onMove, true);
window.addEventListener('click', onClick, true);
