import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, FolderOpen, Github, Laptop, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Callback opcional após criação bem-sucedida — recebe o projeto criado. */
  onCreated?: (projectId: string) => void;
}

/**
 * Modal minimalista pra criar projeto. Estilo Linear/Vercel — formulário
 * curto, sem floreios, com botão "Escolher pasta" usando dialog nativo.
 */
export function NewProjectDialog({ open, onOpenChange, onCreated }: NewProjectDialogProps) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const workspace = useWorkspaceStore((s) => s.active);

  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [provider, setProvider] = useState<'local' | 'github'>('local');
  const [gitRemote, setGitRemote] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!workspace) throw new Error(t('workspace.newProject.workspaceUndefined'));
      if (name.trim().length === 0) throw new Error(t('workspace.newProject.nameRequired'));
      return window.orkestral['project:create']({
        workspaceId: workspace.id,
        name: name.trim(),
        path: path.trim() || undefined,
        provider,
        gitRemote: provider === 'github' ? gitRemote.trim() || undefined : undefined,
        description: description.trim() || undefined,
      });
    },
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      reset();
      onOpenChange(false);
      onCreated?.(project.id);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  function reset() {
    setName('');
    setPath('');
    setProvider('local');
    setGitRemote('');
    setDescription('');
    setError(null);
  }

  async function handlePickFolder() {
    const result = await window.orkestral['dialog:open-directory']({
      title: t('workspace.newProject.pickFolderTitle'),
    });
    if (result?.path) {
      setPath(result.path);
      // Auto-preenche o nome se vazio (pega o último segmento do path)
      if (name.trim().length === 0) {
        const segments = result.path.split('/').filter(Boolean);
        const last = segments[segments.length - 1];
        if (last) setName(last);
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-[460px] p-0">
        <div className="border-b border-hairline-faint px-6 py-5">
          <DialogTitle>{t('workspace.newProject.title')}</DialogTitle>
          <DialogDescription className="mt-1">
            {t('workspace.newProject.subtitle')}
          </DialogDescription>
        </div>

        <div className="flex flex-col gap-5 px-6 py-5">
          {/* Provider toggle */}
          <Field label={t('workspace.newProject.typeLabel')}>
            <div className="grid grid-cols-2 gap-2">
              <ProviderCard
                icon={Laptop}
                label={t('workspace.newProject.localLabel')}
                description={t('workspace.newProject.localDescription')}
                selected={provider === 'local'}
                onSelect={() => setProvider('local')}
              />
              <ProviderCard
                icon={Github}
                label={t('workspace.newProject.githubLabel')}
                description={t('workspace.newProject.githubDescription')}
                selected={provider === 'github'}
                onSelect={() => setProvider('github')}
              />
            </div>
          </Field>

          <Field label={t('workspace.newProject.nameLabel')}>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('workspace.newProject.namePlaceholder')}
              className="h-10 rounded-md bg-surface-subtle border-hairline-med"
            />
          </Field>

          {provider === 'local' ? (
            <Field
              label={t('workspace.newProject.folderLabel')}
              hint={t('workspace.newProject.folderHint')}
            >
              <div className="flex gap-2">
                <Input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder={t('workspace.newProject.folderPlaceholder')}
                  className="h-10 flex-1 rounded-md bg-surface-subtle border-hairline-med font-mono text-[12.5px]"
                />
                <button
                  type="button"
                  onClick={handlePickFolder}
                  className="inline-flex h-10 items-center gap-1.5 rounded-md border border-hairline-med bg-surface-subtle px-3 text-[12.5px] text-text-primary transition-colors hover:bg-surface-1"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t('common.choose')}
                </button>
              </div>
            </Field>
          ) : (
            <Field label={t('workspace.newProject.repoUrlLabel')}>
              <Input
                value={gitRemote}
                onChange={(e) => setGitRemote(e.target.value)}
                placeholder={t('workspace.newProject.repoUrlPlaceholder')}
                className="h-10 rounded-md bg-surface-subtle border-hairline-med font-mono text-[12.5px]"
              />
            </Field>
          )}

          <Field
            label={t('workspace.newProject.descriptionLabel')}
            hint={t('workspace.newProject.descriptionHint')}
          >
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('workspace.newProject.descriptionPlaceholder')}
              rows={2}
              className="w-full resize-none rounded-md border border-hairline-med bg-surface-subtle px-3 py-2 text-[13px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-white/20"
            />
          </Field>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2.5 text-[12px] text-text-primary">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />
              <div>{error}</div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-hairline-faint px-6 py-4">
          <button
            type="button"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            className="inline-flex h-9 items-center rounded-md px-3 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || name.trim().length === 0}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-text-primary px-4 text-[13px] font-medium text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('workspace.newProject.creating')}
              </>
            ) : (
              t('workspace.newProject.submit')
            )}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProviderCard({
  icon: Icon,
  label,
  description,
  selected,
  onSelect,
}: {
  icon: typeof Laptop;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition-all',
        selected
          ? 'border-white/30 bg-surface-active'
          : 'border-hairline-med bg-surface-faint hover:border-hairline-bright',
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-text-primary" />
        <span className="text-[12.5px] font-medium text-text-primary">{label}</span>
      </div>
      <span className="text-[10.5px] text-text-muted">{description}</span>
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11.5px] font-medium uppercase tracking-[0.12em] text-text-faint">
        {label}
      </label>
      {children}
      {hint && <div className="text-[10.5px] text-text-muted">{hint}</div>}
    </div>
  );
}
