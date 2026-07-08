import { useEffect, useRef } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';

/**
 * Editor WYSIWYG de markdown pras skills — mesmo motor (BlockNote) da Base de
 * Conhecimento, mas serializando de volta pra **markdown** (o conteúdo da skill
 * é injetado como markdown no prompt do agente).
 *
 * Hidrata a partir de `initialMarkdown` e emite markdown a cada mudança. O
 * primeiro `onReady` traz o markdown já normalizado (round-trip), pro caller
 * fixar a baseline e não marcar "não salvo" só por abrir.
 */
export function SkillMarkdownEditor({
  initialMarkdown,
  onChange,
  onReady,
}: {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  onReady?: (markdown: string) => void;
}) {
  const editor = useCreateBlockNote();
  const hydrated = useRef(false);
  const ready = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    void (async () => {
      try {
        const blocks = await editor.tryParseMarkdownToBlocks(initialMarkdown || '');
        if (blocks.length > 0) editor.replaceBlocks(editor.document, blocks);
      } catch (err) {
        console.warn('[skill-editor] falha ao parsear markdown:', err);
      } finally {
        try {
          const md = editor.blocksToMarkdownLossy(editor.document);
          ready.current = true;
          onReady?.(md);
        } catch {
          ready.current = true;
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return (
    <div className="kb-blocknote-wrapper">
      <BlockNoteView
        editor={editor}
        theme="dark"
        onChange={() => {
          if (!ready.current) return;
          onChange(editor.blocksToMarkdownLossy(editor.document));
        }}
      />
    </div>
  );
}
