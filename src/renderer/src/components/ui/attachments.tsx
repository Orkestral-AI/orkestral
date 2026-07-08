import { useCallback, useState } from 'react';
import { Paperclip, FileText, ImageIcon, X, Loader2 } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';
import type { IssueAttachment } from '@shared/types';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Estado de anexos em rascunho (antes de enviar comentário/decisão). */
export function useStagedAttachments() {
  const [items, setItems] = useState<IssueAttachment[]>([]);
  const [picking, setPicking] = useState(false);

  const pick = useCallback(async () => {
    setPicking(true);
    try {
      const res = await window.orkestral['attachment:add-files']();
      if (res.attachments.length) setItems((prev) => [...prev, ...res.attachments]);
    } finally {
      setPicking(false);
    }
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  return { items, picking, pick, remove, clear };
}

function AttachIcon({ mime }: { mime: string }) {
  if (mime.startsWith('image/')) return <ImageIcon className="h-3.5 w-3.5 text-text-muted" />;
  return <FileText className="h-3.5 w-3.5 text-text-muted" />;
}

/** Botão de clipe pra anexar arquivos. */
export function AttachButton({
  onClick,
  picking,
  disabled,
}: {
  onClick: () => void;
  picking?: boolean;
  disabled?: boolean;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || picking}
      title={t('layout.ui.attachFiles')}
      aria-label={t('layout.ui.attachFiles')}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-hover px-2 text-[11.5px] text-text-secondary transition-colors hover:bg-surface-4 hover:text-text-primary disabled:opacity-50"
    >
      {picking ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Paperclip className="h-3.5 w-3.5" />
      )}
      {t('layout.ui.attach')}
    </button>
  );
}

/** Chips de anexos em rascunho — com botão de remover. */
export function StagedChips({
  items,
  onRemove,
}: {
  items: IssueAttachment[];
  onRemove: (id: string) => void;
}) {
  const { t } = useT();
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((a) => (
        <span
          key={a.id}
          className="inline-flex items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-hover py-1 pl-2 pr-1 text-[11px] text-text-secondary"
        >
          <AttachIcon mime={a.mimeType} />
          <span className="max-w-[160px] truncate">{a.fileName}</span>
          <span className="text-text-faint">{formatBytes(a.sizeBytes)}</span>
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            className="rounded p-0.5 text-text-faint hover:text-accent-red"
            aria-label={t('layout.ui.removeAttachment')}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Anexos já salvos (em um comentário) — clicáveis pra abrir no SO. */
export function AttachmentChips({
  items,
  className,
}: {
  items: IssueAttachment[];
  className?: string;
}) {
  const { t } = useT();
  if (!items || items.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {items.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => window.orkestral['attachment:open']({ path: a.path })}
          title={t('layout.ui.openFile', { fileName: a.fileName })}
          className="inline-flex items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-hover px-2 py-1 text-[11px] text-text-secondary transition-colors hover:border-hairline-mega hover:text-text-primary"
        >
          <AttachIcon mime={a.mimeType} />
          <span className="max-w-[180px] truncate">{a.fileName}</span>
          <span className="text-text-faint">{formatBytes(a.sizeBytes)}</span>
        </button>
      ))}
    </div>
  );
}
