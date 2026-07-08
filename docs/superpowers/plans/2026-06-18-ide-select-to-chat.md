# Select-to-Chat na IDE — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans pra implementar tarefa-a-tarefa. Steps usam checkbox (`- [ ]`).

**Goal:** No Preview da IDE, ligar um modo de seleção, clicar num componente do app rodando e mandá-lo como referência pro chat — que vive num drawer sobreposto dentro da própria IDE.

**Architecture:** Drawer de chat sobreposto (overlay direito) reusando o chat existente via `ChatSurface` extraída; um `ideChatStore` guarda sessão ativa do drawer + seleções pendentes. No Preview, um preload injetado no `<webview>` detecta o elemento clicado (React `_debugSource` → Vue `__file` → fallback DOM) e manda via `ipc-message` pro host, que vira chip no composer do drawer.

**Tech Stack:** Electron + React + zustand + @tanstack/react-query + xterm/webview. **Sem test runner** — gate é `npm run typecheck` + `npx eslint` + checagem manual no app (`npm run dev`). Regra do projeto: NÃO criar testes.

**Convenções deste plano:**

- "Verificar" = rodar `npm run typecheck` e `npx eslint <arquivos>` (ambos limpos) + o check manual descrito.
- Commits são do Luccas — os steps de commit ficam como sugestão; não rodar `git commit` sem ele pedir.
- i18n: toda string nova entra em `pt-BR/layout.json` e `en/layout.json` (chaves espelhadas).

---

## File Structure

**Fase 1 (drawer):**

- Create `src/renderer/src/stores/ideChatStore.ts` — estado do drawer (open, sessão ativa, seleções pendentes).
- Create `src/renderer/src/components/chat/ChatSurface.tsx` — superfície enxuta: `MessageList` + `ChatPrompt` ligados a um `sessionId`, com envio via `chat:send`.
- Create `src/renderer/src/components/code-ide/IdeChatDrawer.tsx` — drawer overlay + header com seletor de sessão; renderiza `ChatSurface`.
- Modify `src/renderer/src/pages/SourceDetailPage.tsx` — montar o `IdeChatDrawer` + botão toggle no header.

**Fase 2 (seleção):**

- Create `src/preload/webview.ts` — preload do `<webview>`: detector + ponte ipc.
- Modify `electron.vite.config.ts` — adicionar entrada de preload `webview`.
- Modify `src/renderer/src/components/code-ide/PreviewPanel.tsx` — `preload` no webview, toggle de seleção, listener `ipc-message`.
- Modify `src/renderer/src/stores/ideChatStore.ts` — ações de seleção (já criadas na Fase 1, usadas aqui).
- Modify `src/renderer/src/components/chat/ChatSurface.tsx` — render dos chips de seleção acima do input + serialização no envio.

---

## FASE 1 — Chat drawer na IDE

### Task 1: `ideChatStore`

**Files:** Create `src/renderer/src/stores/ideChatStore.ts`

- [ ] **Step 1: Criar o store**

```ts
import { create } from 'zustand';

export interface IdeSelection {
  id: string;
  framework: 'react' | 'vue' | 'dom';
  file?: string;
  line?: number;
  component?: string;
  tag: string;
  selector: string;
  text?: string;
}

interface IdeChatState {
  open: boolean;
  /** Sessão aberta no drawer; 'new' = compositor de chat novo. */
  activeSessionId: string | 'new';
  /** Modo de seleção do Preview ligado. */
  selecting: boolean;
  pendingSelections: IdeSelection[];
  seq: number;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  setSession: (id: string | 'new') => void;
  setSelecting: (on: boolean) => void;
  addSelection: (s: Omit<IdeSelection, 'id'>) => void;
  removeSelection: (id: string) => void;
  clearSelections: () => void;
}

export const useIdeChatStore = create<IdeChatState>((set) => ({
  open: false,
  activeSessionId: 'new',
  selecting: false,
  pendingSelections: [],
  seq: 0,
  openDrawer: () => set({ open: true }),
  closeDrawer: () => set({ open: false }),
  toggleDrawer: () => set((s) => ({ open: !s.open })),
  setSession: (activeSessionId) => set({ activeSessionId }),
  setSelecting: (selecting) => set({ selecting }),
  addSelection: (s) =>
    set((st) => {
      const n = st.seq + 1;
      return {
        seq: n,
        pendingSelections: [...st.pendingSelections, { ...s, id: `sel_${n}` }],
        open: true, // abre o drawer ao selecionar
      };
    }),
  removeSelection: (id) =>
    set((st) => ({ pendingSelections: st.pendingSelections.filter((x) => x.id !== id) })),
  clearSelections: () => set({ pendingSelections: [] }),
}));
```

- [ ] **Step 2: Verificar** — `npm run typecheck` + `npx eslint src/renderer/src/stores/ideChatStore.ts` limpos.
- [ ] **Step 3: Commit (sugestão)** — `feat(ide): ideChatStore (drawer + seleções)`.

---

### Task 2: `ChatSurface` (extração do chat reusável)

**Files:** Create `src/renderer/src/components/chat/ChatSurface.tsx`
**Referência canônica:** `src/renderer/src/pages/SessionPage.tsx` — o handler de envio chama
`window.orkestral['chat:send']({...})` (~linha 384) e usa `useChatStore`/`addOptimisticUserMessage`.
Replicar SÓ o caminho mínimo: render de mensagens + composer + envio.

- [ ] **Step 1: Ler o fluxo de envio na SessionPage**

Run: abrir `src/renderer/src/pages/SessionPage.tsx`, localizar o handler que chama
`window.orkestral['chat:send']` (~384) e como ele monta o payload (sessionId, content, attachments,
workspaceId, agent). Anotar o shape exato do request de `chat:send` no contrato
(`src/shared/ipc-contract.ts`, buscar `'chat:send'`).

- [ ] **Step 2: Escrever `ChatSurface`**

Componente recebe `sessionId: string | 'new'`. Renderiza:

- `MessageList` com as mensagens de `useChatStore(s => s.sessions[sessionId]?.messages)` (vazio se 'new').
- `ChatPrompt` com `draftKey={sessionId === 'new' ? HOME_DRAFT_KEY : sessionId}` e
  `onSubmit={(content, attachments) => onSend(content, attachments)}`.
- `onSend`: replica o caminho do `chat:send` da SessionPage (mesmo payload). Se `sessionId === 'new'`,
  segue o fluxo de criação de sessão da SessionPage/Home (criar e setar `activeSessionId` no `ideChatStore`
  com o id retornado). Usar `useWorkspaceStore` pro workspaceId, como a SessionPage faz.

```tsx
import { MessageList } from '@renderer/components/chat/MessageList';
import { ChatPrompt } from '@renderer/components/chat/ChatPrompt';
import { HOME_DRAFT_KEY } from '@renderer/stores/draftStore';
import { useChatStore } from '@renderer/stores/chatStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import type { ChatAttachment } from '@shared/types';

export function ChatSurface({
  sessionId,
  onSessionCreated,
  composerExtras,
  transformContent,
}: {
  sessionId: string | 'new';
  onSessionCreated?: (id: string) => void;
  /** Conteúdo extra acima do input (chips de seleção na Fase 2). */
  composerExtras?: React.ReactNode;
  /** Hook pra prefixar/serializar as seleções no envio (Fase 2). */
  transformContent?: (content: string) => string;
}) {
  const messages = useChatStore((s) =>
    sessionId === 'new' ? [] : (s.sessions[sessionId]?.messages ?? []),
  );
  const workspace = useWorkspaceStore((s) => s.active);

  const onSend = async (content: string, attachments?: ChatAttachment[]) => {
    const finalContent = transformContent ? transformContent(content) : content;
    // Espelhar EXATAMENTE o caminho de SessionPage (chat:send + optimistic). Se 'new',
    // criar a sessão como a Home faz e chamar onSessionCreated(id).
    // (preencher com o payload real lido no Step 1)
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MessageList messages={messages} /* + props mínimas que MessageList exige */ />
      </div>
      {composerExtras}
      <ChatPrompt
        onSubmit={onSend}
        draftKey={sessionId === 'new' ? HOME_DRAFT_KEY : sessionId}
        expand
      />
    </div>
  );
}
```

- [ ] **Step 3: Ajustar props obrigatórias** — abrir `MessageList.tsx` (assinatura na linha ~30) e
      `ChatPrompt` (props `ChatPromptProps`, linha 36) e passar SÓ as props obrigatórias; remover as opcionais
      não usadas. Não inventar props — usar as que existem.

- [ ] **Step 4: Verificar** — typecheck + eslint limpos no arquivo.
- [ ] **Step 5: Commit (sugestão)** — `feat(chat): ChatSurface reusável (lista + composer por sessionId)`.

---

### Task 3: `IdeChatDrawer`

**Files:** Create `src/renderer/src/components/code-ide/IdeChatDrawer.tsx`

- [ ] **Step 1: Escrever o drawer**

Overlay à direita, animado (framer-motion, já no projeto), largura redimensionável (persistir em
`uiStore` como `ideChatWidth`, espelhando `codeSidebarWidth`). Header: seletor de sessão
(dropdown com `useChatStore(s => s.list)` recentes + "novo chat") + botão fechar. Corpo: `ChatSurface`.

```tsx
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';
import { useIdeChatStore } from '@renderer/stores/ideChatStore';
import { useChatStore } from '@renderer/stores/chatStore';
import { ChatSurface } from '@renderer/components/chat/ChatSurface';

export function IdeChatDrawer() {
  const { t } = useT();
  const open = useIdeChatStore((s) => s.open);
  const close = useIdeChatStore((s) => s.closeDrawer);
  const sessionId = useIdeChatStore((s) => s.activeSessionId);
  const setSession = useIdeChatStore((s) => s.setSession);
  const sessions = useChatStore((s) => s.list);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', stiffness: 320, damping: 34 }}
          className="absolute inset-y-0 right-0 z-30 flex w-[420px] max-w-[90%] flex-col border-l border-border bg-background shadow-2xl shadow-black/40"
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline-soft px-2">
            {/* seletor de sessão: usa DSSelect ou um dropdown simples com sessions + 'new' */}
            {/* ...select com value=sessionId onChange=setSession... */}
            <button
              type="button"
              onClick={close}
              aria-label={t('layout.codeIde.ideChat.close')}
              className="ml-auto grid h-7 w-7 place-items-center rounded text-text-muted hover:bg-surface-subtle hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <ChatSurface sessionId={sessionId} onSessionCreated={setSession} />
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 2: Seletor de sessão** — usar `DSSelect` (`@renderer/components/ui/ds-select`, já usado na
      SourceDetailPage) com opções `[{value:'new', label: t('...newChat')}, ...sessions.map(s => ({value:s.id, label:s.title}))]`,
      `value={sessionId}`, `onChange={setSession}`.

- [ ] **Step 3: Verificar** — typecheck + eslint.
- [ ] **Step 4: Commit (sugestão)** — `feat(ide): IdeChatDrawer overlay com seletor de sessão`.

---

### Task 4: Montar o drawer + toggle na SourceDetailPage

**Files:** Modify `src/renderer/src/pages/SourceDetailPage.tsx`

- [ ] **Step 1: Renderizar o drawer** — dentro do `<Shell>`, como ÚLTIMO filho do container relativo
      (pra sobrepor): `<IdeChatDrawer />`. O `<Shell>` já é `relative`/`overflow-hidden`; confirmar que o
      container que envolve header+body é `relative` (se não, adicionar `relative`).

- [ ] **Step 2: Botão toggle** — no header (grupo de botões à direita, perto de Configurações), um botão
      ícone (`MessageSquare` do lucide) que chama `useIdeChatStore.getState().toggleDrawer()`, com Tooltip
      `t('layout.codeIde.ideChat.toggle')`. Estado ativo quando `open`.

- [ ] **Step 3: i18n** — adicionar em `layout.json` (pt + en): `codeIde.ideChat.{toggle, close, newChat}`.

- [ ] **Step 4: Verificar** — typecheck + eslint + `npm run dev`: abrir source → clicar o ícone →
      drawer desliza da direita; trocar sessão; enviar mensagem numa sessão existente (deve cair no chat real);
      fechar volta o Preview a 100%.

- [ ] **Step 5: Commit (sugestão)** — `feat(ide): drawer de chat na source (Fase 1)`.

---

## FASE 2 — Seleção visual no Preview

### Task 5: Preload do webview (detector + ponte)

**Files:** Create `src/preload/webview.ts`

- [ ] **Step 1: Escrever o preload**

```ts
import { ipcRenderer } from 'electron';

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

function moveOverlay(el: Element) {
  const r = el.getBoundingClientRect();
  const o = ensureOverlay();
  o.style.display = 'block';
  o.style.left = `${r.left}px`;
  o.style.top = `${r.top}px`;
  o.style.width = `${r.width}px`;
  o.style.height = `${r.height}px`;
}

// React fiber: arquivo:linha + nome do componente.
function fromReact(el: Element): Partial<Selection> | null {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  if (!key) return null;
  let fiber = (el as unknown as Record<string, unknown>)[key] as
    | {
        _debugSource?: { fileName: string; lineNumber: number };
        _debugOwner?: unknown;
        type?: unknown;
        return?: unknown;
      }
    | undefined;
  // sobe até achar _debugSource / um componente nomeado
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

// Vue: __vnode/__vueParentComponent → type.__file + nome.
function fromVue(el: Element): Partial<Selection> | null {
  const inst = (
    el as unknown as { __vueParentComponent?: { type?: { __file?: string; name?: string } } }
  ).__vueParentComponent;
  const type = inst?.type;
  if (!type?.__file && !type?.name) return null;
  return { framework: 'vue', file: type?.__file, component: type?.name };
}

interface Selection {
  framework: 'react' | 'vue' | 'dom';
  file?: string;
  line?: number;
  component?: string;
  tag: string;
  selector: string;
  text?: string;
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

function onMove(e: MouseEvent) {
  if (!selecting) return;
  const el = e.target as Element;
  if (el) moveOverlay(el);
}
function onClick(e: MouseEvent) {
  if (!selecting) return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.target as Element;
  if (el) ipcRenderer.sendToHost('element-picked', describe(el));
}

ipcRenderer.on('set-select', (_e, on: boolean) => {
  selecting = on;
  document.documentElement.style.cursor = on ? 'crosshair' : '';
  if (!on && overlay) overlay.style.display = 'none';
});

window.addEventListener('mousemove', onMove, true);
window.addEventListener('click', onClick, true);
```

- [ ] **Step 2: Verificar** — `npm run typecheck` (o preload entra no tsconfig.node). eslint no arquivo.

- [ ] **Step 3: Commit (sugestão)** — `feat(ide): preload do webview (detector React/Vue/DOM)`.

---

### Task 6: Build — entrada de preload do webview

**Files:** Modify `electron.vite.config.ts`

- [ ] **Step 1: Adicionar input** — na seção `preload.build.rollupOptions.input`, transformar pra objeto
      com duas entradas:

```ts
preload: {
  plugins: [externalizeDepsPlugin()],
  build: {
    rollupOptions: {
      input: {
        index: resolve('src/preload/index.ts'),
        webview: resolve('src/preload/webview.ts'),
      },
      output: { entryFileNames: '[name].mjs' },
    },
  },
},
```

(Confirmar o caminho atual do preload `index` antes de editar; manter igual ao existente.)

- [ ] **Step 2: Verificar** — `npm run build` (ou `npm run typecheck` + conferir que `out/preload/webview.mjs`
      é gerado num build). Anotar o caminho final do arquivo gerado (usado no Task 7).

- [ ] **Step 3: Commit (sugestão)** — `build(ide): entrada de preload do webview`.

---

### Task 7: PreviewPanel — preload no webview, toggle, ipc-message

**Files:** Modify `src/renderer/src/components/code-ide/PreviewPanel.tsx`

- [ ] **Step 1: `preload` no `<webview>`** — resolver o caminho do `webview.mjs` gerado. Em dev e prod o
      caminho difere; usar o mesmo padrão do preload principal (ver `src/main/index.ts` `webPreferences.preload`
      = `join(__dirname, '../preload/index.mjs')`). Para o webview, expor o caminho via um IPC simples
      `app:webview-preload-path` (handler no main retornando `pathToFileURL(join(__dirname,'../preload/webview.mjs')).href`)
      e ler no PreviewPanel com `useQuery`/`useEffect`; setar `preload={path}` no webview. (Webview exige `file://`.)

- [ ] **Step 2: Toggle de seleção** — novo botão na toolbar do PreviewPanel (ícone `MousePointerClick`),
      ligado a `useIdeChatStore(s=>s.selecting)`/`setSelecting`. Ao mudar, enviar pro guest:
      `(webviewRef.current as unknown as { send(ch:string, ...a:unknown[]):void }).send('set-select', on)`.
      Reenviar no evento `dom-ready` do webview (garante após reload/navegação).

- [ ] **Step 3: Listener `ipc-message`** — no effect que já adiciona listeners do webview:

```ts
const onIpc = (e: Event) => {
  const ev = e as unknown as { channel: string; args: unknown[] };
  if (ev.channel === 'element-picked') {
    useIdeChatStore.getState().addSelection(ev.args[0] as Omit<IdeSelection, 'id'>);
  }
};
wv.addEventListener('ipc-message', onIpc);
// remover no cleanup
```

- [ ] **Step 4: Resolver `file` relativo** — ao adicionar a seleção, se `file` for caminho absoluto que
      começa com o `source.path`, converter pra relativo (`file.slice(source.path.length+1)`) pra virar
      `@relPath`. PreviewPanel recebe `sourceId`; obter `source.path` via a query de sources (como o SourceCodeInner faz)
      ou passar `cwd`/`sourceRoot` por prop. Adicionar prop `sourceRoot?: string` ao PreviewPanel e passar da SourceDetailPage.

- [ ] **Step 5: i18n** — `codeIde.preview.select` (pt/en) pro tooltip do toggle.

- [ ] **Step 6: Verificar** — typecheck + eslint + `npm run dev`: ligar seleção → hover destaca no preview →
      clicar adiciona chip (drawer abre); cliques fora do modo passam normais; desligar limpa o cursor.

- [ ] **Step 7: Commit (sugestão)** — `feat(ide): modo seleção no Preview (host)`.

---

### Task 8: Chips de seleção no composer + serialização no envio

**Files:** Modify `src/renderer/src/components/chat/ChatSurface.tsx`

- [ ] **Step 1: Render dos chips** — em `composerExtras` (passado pelo IdeChatDrawer ou lido direto do
      store), listar `useIdeChatStore(s=>s.pendingSelections)` como chips removíveis (ícone + label
      `component ?? tag` + `:linha`), com X chamando `removeSelection(id)`.

- [ ] **Step 2: Serializar no envio** — `transformContent`: prefixar a mensagem com as referências e
      limpar as seleções:

```ts
const sels = useIdeChatStore.getState().pendingSelections;
const refs = sels
  .map((s) =>
    s.file
      ? `@${s.file}${s.line ? `:${s.line}` : ''} (${s.component ?? s.tag})`
      : `[${s.tag}${s.text ? ` "${s.text}"` : ''}]`,
  )
  .join('\n');
const finalContent = refs ? `${refs}\n\n${content}` : content;
// após enviar: useIdeChatStore.getState().clearSelections();
```

- [ ] **Step 3: IdeChatDrawer passa os chips** — `IdeChatDrawer` renderiza `ChatSurface` com
      `composerExtras={<SelectionChips />}` (componente inline lendo o store) e `transformContent` acima.

- [ ] **Step 4: i18n** — `codeIde.ideChat.{selectionsTitle, removeSelection}`.

- [ ] **Step 5: Verificar** — typecheck + eslint + `npm run dev`: selecionar 3 componentes (sem voltar),
      abrir drawer → 3 chips → digitar e enviar → a mensagem chega no chat com as 3 referências; seleções limpam.

- [ ] **Step 6: Commit (sugestão)** — `feat(ide): chips de seleção no composer + envio único (Fase 2)`.

---

## Self-Review (cobertura do spec)

- Drawer overlay reusando chat + seletor de sessão → Tasks 2,3,4. ✓
- Captura React→Vue→DOM + metadados DOM → Task 5 (`describe`/`fromReact`/`fromVue`). ✓
- ipc guest→host + host→guest → Tasks 5,7 (`sendToHost`/`set-select`/`ipc-message`). ✓
- Multi-seleção sem voltar (chips persistem no store) → Tasks 1,8. ✓
- Envio único na sessão escolhida → Task 8. ✓
- Resolver `file` relativo à source → Task 7 Step 4. ✓
- webviewTag já ligado; build de preload extra → Task 6. ✓
- Erros (source não detectado → chip DOM; modo off → cliques normais) → Task 5 (fallback + guarda `selecting`). ✓

## Riscos / atenção

- `_debugSource` só existe em dev (plugin jsx-source, default no Vite React dev). Em prod React não vem →
  cai pro fallback DOM. OK (preview é dev).
- Extração do `ChatSurface`: não regredir a `SessionPage`. Se o envio for muito acoplado, manter SessionPage
  como está e só replicar o caminho mínimo no ChatSurface (duplicação controlada aceitável nesta fase).
- Caminho do `preload` do webview em prod (empacotado) — validar no build, não só em dev.
