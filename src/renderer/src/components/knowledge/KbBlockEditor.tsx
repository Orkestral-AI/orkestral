import { useEffect, useMemo, useRef } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import type { Block } from '@blocknote/core';
import { useNavigate } from 'react-router-dom';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';

interface KbBlockEditorProps {
  /** Conteúdo serializado anterior (BlockNote JSON). */
  initialContentJson?: string | null;
  /** Fallback de markdown bruto (importa pra blocos no boot do editor). */
  initialMarkdown?: string | null;
  /** Chamado a cada mudança (debounced no caller). */
  onChange: (contentJson: string) => void;
}

/**
 * Slug de wikilink — mesmo algoritmo do backend (`slugify` em kb-page.repo).
 * Mantemos uma cópia local pra resolver `[[Título]]` → URL no client sem
 * round-trip ao main process.
 */
function slugify(title: string): string {
  return (
    title
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80) || 'page'
  );
}

/**
 * Pré-processa wikilinks `[[Título]]` no markdown → links markdown clicáveis
 * `[Título](/knowledge/<slug>)`. O BlockNote não tem suporte nativo a wikilinks
 * Obsidian-style, então convertemos antes de hidratar o editor.
 *
 * Slug derivado do título com o mesmo algoritmo do backend — se a página alvo
 * existir, o slug bate. Se não existir, o link aponta pra uma rota inválida
 * mas o texto continua legível (sem os colchetes feios).
 *
 * Suporta `[[Título]]` e `[[Título|alias]]` (Obsidian-compat).
 */
function expandWikilinks(md: string): string {
  return md.replace(/\[\[([^\]]+)\]\]/g, (_full, inner: string) => {
    const [target, alias] = inner.split('|').map((s) => s.trim());
    const display = alias && alias.length > 0 ? alias : target;
    return `[${display}](/knowledge/${slugify(target)})`;
  });
}

/**
 * Wrapper do BlockNote pro Orkestral KB. Inicialização async porque a importação
 * de markdown roda como Promise. Tema escuro (combina com o app).
 */
export function KbBlockEditor({
  initialContentJson,
  initialMarkdown,
  onChange,
}: KbBlockEditorProps) {
  const navigate = useNavigate();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const initialBlocks = useMemo<Block[] | undefined>(() => {
    if (!initialContentJson) return undefined;
    try {
      const parsed = JSON.parse(initialContentJson);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as Block[];
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }, [initialContentJson]);

  const editor = useCreateBlockNote({
    initialContent: initialBlocks,
  });

  // Se não veio contentJson e veio markdown, carrega como blocos.
  // Wikilinks `[[X]]` são expandidos pra links markdown antes do parse.
  const hydratedFromMd = useRef(false);
  useEffect(() => {
    if (hydratedFromMd.current) return;
    if (initialBlocks) return;
    if (!initialMarkdown || !initialMarkdown.trim()) return;
    hydratedFromMd.current = true;
    void (async () => {
      try {
        const expanded = expandWikilinks(initialMarkdown);
        const blocks = await editor.tryParseMarkdownToBlocks(expanded);
        editor.replaceBlocks(editor.document, blocks);
      } catch (err) {
        console.warn('[kb-editor] falha ao parsear markdown:', err);
      }
    })();
  }, [editor, initialBlocks, initialMarkdown]);

  // Click handler global no wrapper — intercepta links internos
  // (`/knowledge/...`) e navega via react-router em vez de abrir no browser.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const anchor = target.closest('a') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      // Captura tanto path relativo quanto pseudo-URLs internas
      if (href.startsWith('/knowledge/')) {
        e.preventDefault();
        e.stopPropagation();
        navigate(href);
      }
    }
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [navigate]);

  return (
    <div ref={wrapperRef} className="kb-blocknote-wrapper">
      <BlockNoteView
        editor={editor}
        theme="dark"
        onChange={() => {
          const doc = editor.document;
          onChange(JSON.stringify(doc));
        }}
      />
    </div>
  );
}
