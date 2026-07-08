import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save, Settings2, Sparkles, Trash2, Zap } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { useT } from '@renderer/i18n';
import { useWorkspaceIdeStore } from '@renderer/stores/workspaceIdeStore';
import { ROLE_META, ROLE_ORDER } from '@renderer/lib/role-meta';
import type { WorkspaceSource, WorkspaceSourceRole } from '@shared/types';

const ROLE_SELECT_OPTIONS = ROLE_ORDER.map((value) => {
  const meta = ROLE_META[value];
  const Icon = meta.icon;
  return {
    value,
    label: meta.label,
    icon: <Icon className={cn('h-3.5 w-3.5', meta.color)} />,
  };
});

/**
 * Configurações de um source — modal (antes era overlay no header da página por
 * source). Aberto pelo menu do source-raiz na árvore (workspaceIdeStore.configSourceId).
 */
export function SourceConfigDialog() {
  const configSourceId = useWorkspaceIdeStore((s) => s.configSourceId);
  const closeConfig = useWorkspaceIdeStore((s) => s.closeConfig);
  return (
    <Dialog open={!!configSourceId} onOpenChange={(o) => !o && closeConfig()}>
      {configSourceId && (
        <DialogContent className="max-w-xl">
          <ConfigBody sourceId={configSourceId} onDone={closeConfig} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function ConfigBody({ sourceId, onDone }: { sourceId: string; onDone: () => void }) {
  const { t } = useT();
  const queryClient = useQueryClient();

  const sourceQuery = useQuery<WorkspaceSource[]>({
    queryKey: ['source-by-id', sourceId],
    queryFn: async () => {
      const workspaces = await window.orkestral['workspace:list']();
      for (const ws of workspaces) {
        const list = await window.orkestral['source:list']({ workspaceId: ws.id });
        const match = list.find((s) => s.id === sourceId);
        if (match) return [match];
      }
      return [];
    },
  });
  const source = sourceQuery.data?.[0];

  const [label, setLabel] = useState('');
  const [role, setRole] = useState('');
  useEffect(() => {
    if (source) {
      const frame = requestAnimationFrame(() => {
        setLabel(source.label);
        setRole(source.role ?? '');
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [source]);

  const updateMutation = useMutation({
    mutationFn: () =>
      window.orkestral['source:update']({
        sourceId,
        patch: {
          label: label.trim() || source!.label,
          role: (role || null) as WorkspaceSourceRole | null,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sources'] });
      queryClient.invalidateQueries({ queryKey: ['source-by-id'] });
    },
  });

  const setPrimaryMutation = useMutation({
    mutationFn: () => window.orkestral['source:set-primary']({ sourceId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sources'] });
      queryClient.invalidateQueries({ queryKey: ['source-by-id'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => window.orkestral['source:delete']({ sourceId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sources'] });
      onDone();
    },
  });

  if (!source) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-[13px] text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('workspace.sourceDetail.loading')}
      </div>
    );
  }

  const dirty = label.trim() !== source.label || (role || null) !== (source.role ?? null);

  return (
    <div className="thin-scrollbar flex flex-col gap-5 overflow-y-auto px-6 pb-6 pt-6">
      <DialogTitle className="text-[15px]">{source.label}</DialogTitle>

      <Section
        icon={Settings2}
        title={t('workspace.sourceDetail.configTitle')}
        description={t('workspace.sourceDetail.configDescription')}
      >
        <Field
          label={t('workspace.sourceDetail.labelLabel')}
          hint={t('workspace.sourceDetail.labelHint')}
        >
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="h-10 w-full rounded-md border border-hairline-strong bg-surface-faint px-3 text-[13px] text-text-primary transition-colors focus:border-hairline-mega focus:bg-surface-3 focus:outline-none"
          />
        </Field>

        <Field
          label={t('workspace.sourceDetail.roleLabel')}
          hint={t('workspace.sourceDetail.roleHint')}
        >
          <DSSelect
            value={role}
            onChange={setRole}
            options={ROLE_SELECT_OPTIONS}
            placeholder={t('workspace.sourceDetail.rolePlaceholder')}
            className="h-10 w-full text-[13px]"
          />
        </Field>

        {updateMutation.isError && (
          <div className="mb-3 rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
            {(updateMutation.error as Error)?.message ?? t('workspace.sourceDetail.saveError')}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-2">
          <div className="text-[11.5px]">
            {updateMutation.isSuccess && !dirty ? (
              <span className="inline-flex items-center gap-1 text-accent-green">
                <Sparkles className="h-3 w-3" />
                {t('workspace.sourceDetail.changesSaved')}
              </span>
            ) : dirty ? (
              <span className="text-text-faint">{t('workspace.sourceDetail.unsavedChanges')}</span>
            ) : null}
          </div>
          <button
            type="button"
            disabled={!dirty || updateMutation.isPending}
            onClick={() => updateMutation.mutate()}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-4 text-[12.5px] font-medium text-black hover:bg-white/90 disabled:opacity-40"
          >
            {updateMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t('workspace.sourceDetail.saveChanges')}
          </button>
        </div>
      </Section>

      <Section
        icon={Zap}
        title={t('workspace.sourceDetail.actionsTitle')}
        description={t('workspace.sourceDetail.actionsDescription')}
      >
        {!source.isPrimary && (
          <ActionRow
            title={t('workspace.sourceDetail.setPrimaryTitle')}
            description={t('workspace.sourceDetail.setPrimaryDescription')}
            button={
              <button
                type="button"
                disabled={setPrimaryMutation.isPending}
                onClick={() => setPrimaryMutation.mutate()}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-hairline-heavy bg-surface-hover px-3.5 text-[12.5px] font-medium text-text-primary hover:bg-surface-active disabled:opacity-40"
              >
                {setPrimaryMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 text-accent-purple" />
                )}
                {t('workspace.sourceDetail.makePrimary')}
              </button>
            }
          />
        )}

        <ActionRow
          title={t('workspace.sourceDetail.removeTitle')}
          titleClass="text-accent-red"
          description={t('workspace.sourceDetail.removeDescription')}
          divider={!source.isPrimary}
          button={
            <button
              type="button"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (confirm(t('workspace.sourceDetail.confirmRemove', { label: source.label }))) {
                  deleteMutation.mutate();
                }
              }}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-accent-red/25 bg-accent-red/[0.07] px-3.5 text-[12.5px] font-medium text-accent-red hover:bg-accent-red/14 disabled:opacity-40"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {t('workspace.sourceDetail.remove')}
            </button>
          }
        />
      </Section>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Settings2;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-hairline-faint bg-transparent p-5">
      <header className="mb-4 flex items-start gap-3">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-hairline-med bg-surface-faint">
          <Icon className="h-3.5 w-3.5 text-text-secondary" />
        </div>
        <div>
          <h3 className="text-[14px] font-semibold tracking-tight text-text-primary">{title}</h3>
          {description && (
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">{description}</p>
          )}
        </div>
      </header>
      <div className="pl-11">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <label className="mb-1 block text-[11px] font-medium text-text-secondary">{label}</label>
      {hint && <p className="mb-1.5 text-[10.5px] text-text-muted">{hint}</p>}
      {children}
    </div>
  );
}

function ActionRow({
  title,
  titleClass,
  description,
  button,
  divider,
}: {
  title: string;
  titleClass?: string;
  description: string;
  button: ReactNode;
  divider?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4',
        divider && 'mt-5 border-t border-hairline-faint pt-5',
      )}
    >
      <div className="min-w-0">
        <div className={cn('text-[13px] font-medium text-text-primary', titleClass)}>{title}</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">{description}</div>
      </div>
      {button}
    </div>
  );
}
