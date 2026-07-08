import { AlertTriangle, FileText } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog';
import { Button } from '@renderer/components/ui/button';
import { useT } from '@renderer/i18n';

export function ConflictModal({
  open,
  onOpenChange,
  files,
  onAbort,
  onOpenFile,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  files: string[];
  onAbort: () => void;
  onOpenFile: (path: string) => void;
}): React.JSX.Element {
  const { t } = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]" hideClose>
        <div className="px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
            <AlertTriangle className="h-4 w-4 text-accent-yellow" />
            {t('issues.code.conflictTitle')}
          </DialogTitle>
          <p className="mt-1 text-[12.5px] text-text-secondary">
            {t('issues.code.conflictBody', { count: files.length })}
          </p>
          <div className="thin-scrollbar mt-3 max-h-60 overflow-auto rounded-md border border-border">
            {files.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onOpenFile(f)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11.5px] text-text-primary hover:bg-surface-1"
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-text-faint" />
                <span className="truncate">{f}</span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="destructive" size="sm" onClick={onAbort}>
              {t('issues.code.conflictAbort')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              {t('issues.code.conflictClose')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
