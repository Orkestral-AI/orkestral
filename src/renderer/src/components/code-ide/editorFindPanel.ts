import { EditorView, type Panel } from '@codemirror/view';
import {
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  closeSearchPanel,
} from '@codemirror/search';

// Widget compacto de busca/substituição DENTRO do arquivo (Cmd+F), estilo
// editor do VS Code: input + toggles em glyph (Aa / ab / .*), contador
// "N de M", navegacao e linha de replace colapsavel. Substitui o painel
// default do @codemirror/search (botoes de texto, visualmente poluido).
//
// CM panels sao DOM puro (sem React), entao montamos os nos na mao. As
// classes Tailwind usam os mesmos tokens do SearchPanel.tsx da sidebar.

const MAX_COUNT = 5000;

// Estado persistido do find ENTRE arquivos (igual VS Code: trocou de arquivo, o
// termo continua e reaplica). O CodeEditor remonta por arquivo, então guardamos
// aqui no módulo e restauramos no onCreateEditor.
interface PersistedFind {
  search: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  open: boolean;
}
const persisted: PersistedFind = {
  search: '',
  replace: '',
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  open: false,
};

/** Estava aberto? → o CodeEditor reabre o painel no arquivo novo (mesmo sem termo,
 *  igual VS Code: o find continua visível ao trocar de arquivo até fechar). */
export function getPersistedFindOpen(): boolean {
  return persisted.open;
}

/** SearchQuery persistido pra reaplicar no arquivo novo (null se nunca buscou). */
export function persistedSearchQuery(): SearchQuery | null {
  if (!persisted.search) return null;
  return new SearchQuery({
    search: persisted.search,
    replace: persisted.replace,
    caseSensitive: persisted.caseSensitive,
    wholeWord: persisted.wholeWord,
    regexp: persisted.regexp,
  });
}

function countMatches(view: EditorView, query: SearchQuery): { total: number; current: number } {
  if (!query.valid) return { total: 0, current: 0 };
  const sel = view.state.selection.main;
  let total = 0;
  let current = 0;
  try {
    const cursor = query.getCursor(view.state);
    let next = cursor.next();
    while (!next.done && total < MAX_COUNT) {
      total++;
      const { from, to } = next.value;
      if (current === 0 && from === sel.from && to === sel.to) current = total;
      next = cursor.next();
    }
  } catch {
    return { total: 0, current: 0 };
  }
  return { total, current };
}

export function createEditorFindPanel(view: EditorView): Panel {
  const initial = getSearchQuery(view.state);

  // --- estrutura DOM ----------------------------------------------------
  // wrapper 0-height pra nao reservar faixa no topo; card flutua top-right.
  const dom = document.createElement('div');
  dom.className = 'relative';
  dom.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      persisted.open = false;
      closeSearchPanel(view);
      view.focus();
    }
  };

  const card = document.createElement('div');
  card.className =
    'absolute right-3 top-2 z-20 flex items-start gap-1 rounded-md border border-border-strong bg-dialog p-1 shadow-xl shadow-black/40';
  dom.appendChild(card);

  // chevron de replace (coluna esquerda)
  const replaceToggle = document.createElement('button');
  replaceToggle.type = 'button';
  replaceToggle.title = 'Alternar substituição';
  replaceToggle.setAttribute('aria-label', 'Alternar substituição');
  replaceToggle.className =
    'mt-0.5 grid h-[3.75rem] w-4 shrink-0 place-items-center rounded text-text-faint transition-colors hover:bg-surface-subtle hover:text-text-secondary';
  replaceToggle.textContent = '›'; // ›
  card.appendChild(replaceToggle);

  const rows = document.createElement('div');
  rows.className = 'flex min-w-0 flex-col gap-1';
  card.appendChild(rows);

  // ---- linha de busca ----
  const findRow = document.createElement('div');
  findRow.className =
    'flex items-center gap-0.5 rounded border border-border bg-surface-elevated pl-2 pr-1 focus-within:border-accent-purple/50';
  rows.appendChild(findRow);

  const findInput = document.createElement('input');
  findInput.placeholder = 'Localizar';
  findInput.value = initial.search;
  findInput.className =
    'h-7 w-32 bg-transparent text-[12.5px] text-text-primary outline-none placeholder:text-text-faint';
  findRow.appendChild(findInput);

  const makeGlyph = (glyph: string, label: string, active: boolean) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(active));
    b.textContent = glyph;
    b.className =
      'grid h-6 w-6 place-items-center rounded text-[12px] leading-none transition-colors';
    return b;
  };

  let caseSensitive = initial.caseSensitive;
  let wholeWord = initial.wholeWord;
  let regexp = initial.regexp;

  const caseBtn = makeGlyph('Aa', 'Diferenciar maiúsculas', caseSensitive);
  const wordBtn = makeGlyph('ab', 'Palavra inteira', wholeWord);
  const regexBtn = makeGlyph('.*', 'Expressão regular', regexp);
  findRow.appendChild(caseBtn);
  findRow.appendChild(wordBtn);
  findRow.appendChild(regexBtn);

  const paintGlyph = (b: HTMLButtonElement, active: boolean) => {
    b.setAttribute('aria-pressed', String(active));
    b.className =
      'grid h-6 w-6 place-items-center rounded text-[12px] leading-none transition-colors ' +
      (active
        ? 'bg-accent-purple/20 text-accent-purple'
        : 'text-text-muted hover:bg-surface-subtle hover:text-text-secondary');
  };

  const counter = document.createElement('span');
  counter.className =
    'ml-1 shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-text-muted';
  findRow.appendChild(counter);

  const makeNav = (glyph: string, label: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.textContent = glyph;
    b.className =
      'grid h-6 w-6 place-items-center rounded text-text-muted transition-colors hover:bg-surface-subtle hover:text-text-secondary';
    return b;
  };

  const prevBtn = makeNav('↑', 'Anterior'); // ↑
  const nextBtn = makeNav('↓', 'Próximo'); // ↓
  const closeBtn = makeNav('✕', 'Fechar'); // ✕
  findRow.appendChild(prevBtn);
  findRow.appendChild(nextBtn);
  findRow.appendChild(closeBtn);

  // ---- linha de replace ----
  const replaceRow = document.createElement('div');
  replaceRow.className =
    'flex items-center gap-0.5 rounded border border-border bg-surface-elevated pl-2 pr-1 focus-within:border-accent-purple/50';
  rows.appendChild(replaceRow);

  const replaceInput = document.createElement('input');
  replaceInput.placeholder = 'Substituir';
  replaceInput.value = initial.replace;
  replaceInput.className =
    'h-7 w-32 bg-transparent text-[12.5px] text-text-primary outline-none placeholder:text-text-faint';
  replaceRow.appendChild(replaceInput);

  const replaceOneBtn = makeNav('↵', 'Substituir'); // ↵
  const replaceAllBtn = makeNav('↠', 'Substituir tudo'); // ↠
  replaceRow.appendChild(replaceOneBtn);
  replaceRow.appendChild(replaceAllBtn);

  let showReplace = initial.replace.length > 0;

  // --- comportamento ----------------------------------------------------
  const commitQuery = (extra?: { focusInput?: boolean }) => {
    const q = new SearchQuery({
      search: findInput.value,
      replace: replaceInput.value,
      caseSensitive,
      wholeWord,
      regexp,
    });
    view.dispatch({ effects: setSearchQuery.of(q) });
    persisted.search = findInput.value;
    persisted.replace = replaceInput.value;
    persisted.caseSensitive = caseSensitive;
    persisted.wholeWord = wholeWord;
    persisted.regexp = regexp;
    if (extra?.focusInput) findInput.focus();
    syncUi();
  };

  const syncReplaceVisibility = () => {
    replaceRow.style.display = showReplace ? '' : 'none';
    replaceToggle.textContent = showReplace ? '⌄' : '›'; // ⌄ : ›
    replaceToggle.style.height = showReplace ? '3.75rem' : '1.75rem';
  };

  const syncUi = () => {
    paintGlyph(caseBtn, caseSensitive);
    paintGlyph(wordBtn, wholeWord);
    paintGlyph(regexBtn, regexp);
    const q = getSearchQuery(view.state);
    if (!findInput.value.trim()) {
      counter.textContent = '';
    } else {
      const { total, current } = countMatches(view, q);
      if (total === 0) counter.textContent = 'nenhum';
      else if (total >= MAX_COUNT) counter.textContent = `${MAX_COUNT}+`;
      else counter.textContent = `${current || 0} de ${total}`;
    }
    syncReplaceVisibility();
  };

  caseBtn.onclick = () => {
    caseSensitive = !caseSensitive;
    commitQuery();
  };
  wordBtn.onclick = () => {
    wholeWord = !wholeWord;
    commitQuery();
  };
  regexBtn.onclick = () => {
    regexp = !regexp;
    commitQuery();
  };

  prevBtn.onclick = () => {
    findPrevious(view);
  };
  nextBtn.onclick = () => {
    findNext(view);
  };
  closeBtn.onclick = () => {
    persisted.open = false;
    closeSearchPanel(view);
    view.focus();
  };

  replaceToggle.onclick = () => {
    showReplace = !showReplace;
    syncReplaceVisibility();
    if (showReplace) replaceInput.focus();
  };

  replaceOneBtn.onclick = () => {
    replaceNext(view);
  };
  replaceAllBtn.onclick = () => {
    replaceAll(view);
  };

  findInput.oninput = () => commitQuery();
  findInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) findPrevious(view);
      else findNext(view);
    }
  };

  replaceInput.oninput = () => commitQuery();
  replaceInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) replaceAll(view);
      else replaceNext(view);
    }
  };

  syncReplaceVisibility();
  syncUi();

  return {
    dom,
    top: true,
    mount() {
      // NÃO dar view.dispatch aqui — mount roda DENTRO do update do CodeMirror;
      // dispatch reentrante quebra a view (era o bug do "trava ao reabrir com termo").
      // A query já foi aplicada via setSearchQuery antes de abrir o painel.
      persisted.open = true;
      findInput.focus();
      findInput.select();
    },
    update(update) {
      const queryChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setSearchQuery)),
      );
      if (queryChanged) {
        const q = getSearchQuery(update.state);
        // refletir mudancas externas (ex.: Cmd+F com texto selecionado)
        if (q.search !== findInput.value) findInput.value = q.search;
        caseSensitive = q.caseSensitive;
        wholeWord = q.wholeWord;
        regexp = q.regexp;
      }
      if (queryChanged || update.docChanged || update.selectionSet) syncUi();
    },
  };
}
