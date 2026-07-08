# Design — Selecionar componente → chat na IDE

Data: 2026-06-18
Repo: OrkestralAI/orkestral (Electron + React, IDE da source em `SourceDetailPage`)

## Objetivo

No Preview da IDE (webview do app rodando), permitir um **modo de seleção**: o usuário
liga um toggle, clica num componente da tela e ele entra como **referência no chat** — para
pedir ajustes apontando direto pro que vê, sem descrever "o botão tal lá em cima".

Resolve três dores:

1. Saber qual componente/arquivo foi clicado dentro do webview.
2. O chat fica em outra rota → clicar não pode tirar o usuário do contexto nem abrir chat novo à força.
3. Multi-seleção: marcar vários componentes sem "voltar pro chat" N vezes.

## Decisões (do brainstorm)

- **Chat dentro da IDE** como **drawer sobreposto** pela direita (toggle, redimensionável).
  Fecha → Preview volta a 100%. Não rouba espaço fixo.
- **Mesmo chat existente**: o usuário escolhe uma sessão antiga (pra ter contexto) ou começa nova.
- **Captura em camadas, framework-aware**: React (`_debugSource` = arquivo:linha) → Vue
  (`__file`/`__vnode`) → **fallback DOM** (tag/classe/texto/seletor). Sempre envia metadados DOM
  junto, mesmo quando o source é detectado. Cobre React, Vue, Svelte e HTML puro.
- **Seleções acumulam** como chips no composer do drawer (persistem mesmo com o drawer fechado);
  envio único na sessão escolhida.

## Decomposição (2 fases entregáveis)

### Fase 1 — Chat drawer na IDE

- **`IdeChatDrawer`** (novo): drawer overlay à direita sobre a área da source, com toggle e
  redimensionamento (espelha o padrão de resize do app). Default fechado.
- **`ChatSurface`** (extração): superfície enxuta de chat = `MessageList` + `ChatPrompt` ligados
  a um `sessionId`, reusando os stores atuais (`chatStore` etc.). NÃO traz a complexidade da
  `SessionPage` (issues/runs/plan/traces) — só conversar.
  - Risco/known issue: `SessionPage` monta o chat inline. A extração deve isolar só lista+composer
    - envio, sem regressão na `SessionPage` (que passa a usar a mesma `ChatSurface` se valer a pena,
      ou fica como está nesta fase pra reduzir risco).
- **Seletor de sessão** no header do drawer: dropdown de sessões recentes + "novo chat".
- **`ideChatStore`** (novo): `{ open: boolean; activeSessionId: string | 'new'; pendingSelections: Selection[] }`
  - ações (toggle, setSession, addSelection, removeSelection, clearSelections).
- Toggle do drawer: ícone na toolbar da source / Preview.

### Fase 2 — Seleção visual no Preview

- **Preload do webview** (`src/preload/webview.ts`, nova entrada de build no electron-vite):
  injetado via `<webview preload="...">`. Roda no contexto do app previewado.
  - Recebe `enable-select`/`disable-select` do host (via `ipcRenderer.on`).
  - Em modo seleção: overlay de highlight no hover + cursor de mira; intercepta o clique
    (capture + preventDefault) e NÃO deixa o app reagir.
  - No clique: **detector em camadas** →
    1. React: sobe os keys `__reactFiber$*` do elemento, lê `_debugSource` (fileName, lineNumber)
       e `_debugOwner`/type.name (componente).
    2. Vue: `el.__vueParentComponent` / `__vnode` → `type.__file` (vite-plugin-vue dev) + nome.
    3. Fallback DOM: tag, id, classes, `textContent` (cortado), seletor CSS único.
  - Sempre monta metadados DOM. `ipcRenderer.sendToHost('element-picked', payload)`.
- **Host (`PreviewPanel`)**: `<webview>` ganha `preload` + listener `ipc-message` →
  `ideChatStore.addSelection(payload)`. Toast "componente adicionado". Toggle de seleção na toolbar.
- **Composer (drawer)**: renderiza `pendingSelections` como chips removíveis acima do input.
  No envio, serializa cada chip como referência na mensagem:
  `@<relPath>:<linha> (<Componente>)` quando há source; senão `[<tag> "<texto>"]` (DOM).
  Manda tudo junto na sessão ativa do drawer; limpa as seleções.

## Tipos

```ts
interface Selection {
  id: string; // nonce local
  framework: 'react' | 'vue' | 'dom';
  file?: string; // relativo à source quando dá pra resolver
  line?: number;
  component?: string; // nome do componente
  tag: string; // tag DOM
  selector: string; // seletor CSS único (fallback/contexto)
  text?: string; // trecho de texto visível (cortado)
}
```

## Fluxo de dados

clique no preview → preload detecta (React→Vue→DOM) → `sendToHost('element-picked')`
→ `PreviewPanel` (ipc-message) → `ideChatStore.addSelection` → chips no composer do drawer
→ usuário escolhe sessão + digita + envia → pipeline de chat atual (com referências).

## IPC / build

- Nova entrada de preload no `electron.vite.config.ts` (`build.rollupOptions.input` com
  `index` + `webview`), gerando `out/preload/webview.mjs`. `<webview preload>` aponta pra ela
  (via `file://` resolvido no renderer/main).
- Comunicação webview↔host: `ipcRenderer.sendToHost` (guest→host) e `webview.send` (host→guest);
  host escuta `webview.addEventListener('ipc-message', …)`.
- `webviewTag: true` já está ligado.

## Tratamento de erro

- Source não detectado → chip só com DOM (label = tag + texto).
- App sem suporte / preload não injeta → toast "este preview não suporta seleção"; modo desliga.
- Modo seleção OFF → cliques passam normais pro app (sem interceptação).
- Resolver `file` relativo à raiz da source: o `_debugSource.fileName` é caminho absoluto do
  dev server; converter pra relativo ao `source.path` (quando bater) pra virar `@relPath` válido;
  senão manda o caminho cru.

## Fora de escopo (YAGNI por ora)

- Plugin build-time tipo Onlook (data-attrs) — só se a precisão em prod virar necessidade.
- Edição visual direta (mexer no DOM/estilos pelo preview) — isto é só "selecionar → referenciar".
- Multi-cursor/seleção de múltiplos no mesmo clique.

## Ordem de implementação

Fase 1 (drawer + ChatSurface + ideChatStore) → Fase 2 (preload webview + detector + chips no composer).
Gate: typecheck + eslint (sem test runner no projeto).
