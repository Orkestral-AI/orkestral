import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Download,
  Trash2,
  Loader2,
  ExternalLink,
  Github,
  KeyRound,
  Layers,
  Check,
  Star,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@renderer/components/ui/dialog';
import { Markdown } from '@renderer/components/ui/markdown';
import { toast } from '@renderer/stores/toastStore';
import { useT } from '@renderer/i18n';
import type { Skill } from '@shared/types';
import { AssignAgentsDialog } from './AssignAgentsDialog';
import { ModelScopeManager } from './ModelScopeManager';
import { MarketplaceIcon } from './MarketplaceIcon';
import { PricingBadge } from './PricingBadge';
import {
  formatStars,
  logoSrc,
  readInstalledMeta,
  type MarketplaceCatalogItem,
  type ModelScopeOption,
} from './shared';

interface ItemDetailDialogProps {
  workspaceId: string;
  item: MarketplaceCatalogItem | null;
  installedSkill: Skill | null;
  scopeOptions: ModelScopeOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}

export function ItemDetailDialog({
  workspaceId,
  item,
  installedSkill,
  scopeOptions,
  open,
  onOpenChange,
  onChanged,
}: ItemDetailDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {item && (
        <DialogContent className="max-w-2xl">
          <DetailBody
            key={item.id}
            workspaceId={workspaceId}
            item={item}
            installedSkill={installedSkill}
            scopeOptions={scopeOptions}
            onChanged={onChanged}
            onClose={() => onOpenChange(false)}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function DetailBody({
  workspaceId,
  item,
  installedSkill,
  scopeOptions,
  onChanged,
  onClose,
}: {
  workspaceId: string;
  item: MarketplaceCatalogItem;
  installedSkill: Skill | null;
  scopeOptions: ModelScopeOption[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const stars = formatStars(item.stars);
  const isMcp = item.kind === 'mcp';
  const installedMeta = installedSkill ? readInstalledMeta(installedSkill) : null;
  const installed = !!installedSkill;

  const [envValues, setEnvValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const r of item.requiredEnv ?? []) {
      if (!r.asHeader) init[r.key] = installedMeta?.env[r.key] ?? '';
    }
    return init;
  });
  const [scopes, setScopes] = useState<string[]>(() => installedMeta?.modelScopes ?? ['*']);
  const [assignOpen, setAssignOpen] = useState(false);

  const requiredMissing = useMemo(
    () =>
      (item.requiredEnv ?? []).some(
        (r) => r.required !== false && !(envValues[r.key] ?? '').trim(),
      ),
    [item.requiredEnv, envValues],
  );

  function nonEmptyEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(envValues)) if (v.trim()) out[k] = v.trim();
    return out;
  }

  // O install não acontece mais aqui — o botão "Instalar" abre o AssignAgentsDialog,
  // que instala de fato ao confirmar (junto da atribuição aos agentes).

  const saveMut = useMutation({
    mutationFn: () =>
      window.orkestral['marketplace:configure']({
        skillId: installedSkill!.id,
        env: isMcp ? nonEmptyEnv() : undefined,
        modelScopes: isMcp ? scopes : undefined,
      }),
    onSuccess: () => {
      toast.success(t('pages.marketplace.updatedToast', { name: item.name }));
      onChanged();
      onClose();
    },
    onError: (e) =>
      toast.error(t('pages.marketplace.saveFailTitle'), e instanceof Error ? e.message : undefined),
  });

  const removeMut = useMutation({
    mutationFn: () => window.orkestral['marketplace:uninstall']({ skillId: installedSkill!.id }),
    onSuccess: () => {
      toast.success(t('pages.marketplace.removedToast', { name: item.name }));
      onChanged();
      onClose();
    },
    onError: (e) =>
      toast.error(
        t('pages.marketplace.removeFailTitle'),
        e instanceof Error ? e.message : undefined,
      ),
  });

  const busy = saveMut.isPending || removeMut.isPending;

  return (
    <>
      {/* Header */}
      <div className="flex items-start gap-3.5 border-b border-hairline px-6 py-5 pr-12">
        <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl border border-hairline-heavy bg-surface-active text-text-secondary">
          <MarketplaceIcon
            iconKey={item.iconKey}
            src={logoSrc(item)}
            kind={item.kind}
            className="h-[18px] w-[18px]"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <DialogTitle className="truncate text-[17px]">{item.name}</DialogTitle>
            {installed && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-accent-green/30 bg-accent-green/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-green">
                <Check className="h-2.5 w-2.5" />
                {t('pages.marketplace.installedBadge')}
              </span>
            )}
          </div>
          <DialogDescription className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed">
            {item.description || item.longDescription}
          </DialogDescription>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
            {item.author && <span>{t('pages.marketplace.by', { author: item.author })}</span>}
            {item.category && (
              <span className="inline-flex items-center gap-1">
                <Layers className="h-3 w-3" /> {item.category}
              </span>
            )}
            {stars && (
              <span className="inline-flex items-center gap-1">
                <Star className="h-3 w-3" /> {stars}
              </span>
            )}
            <PricingBadge pricing={item.pricing} />
            {item.repoUrl && (
              <a
                href={item.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
              >
                <Github className="h-3 w-3" /> {t('pages.marketplace.repository')}
              </a>
            )}
            {item.homepageUrl && (
              <a
                href={item.homepageUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
              >
                <ExternalLink className="h-3 w-3" /> {t('pages.marketplace.site')}
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Body (scrollable) */}
      <div className="thin-scrollbar flex-1 overflow-y-auto px-6 py-5">
        {/* Credenciais */}
        {isMcp && (item.requiredEnv?.length ?? 0) > 0 && (
          <section className="mb-6">
            <SectionTitle icon={KeyRound}>{t('pages.marketplace.credentials')}</SectionTitle>
            <div className="mt-3 flex flex-col gap-3.5">
              {item.requiredEnv!.map((r) => (
                <div key={r.key} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-[12px] font-medium text-text-primary">
                      {r.label}
                      {r.required === false && (
                        <span className="ml-1.5 text-[10.5px] font-normal text-text-faint">
                          {t('common.optional')}
                        </span>
                      )}
                    </label>
                    {r.link && (
                      <a
                        href={r.link}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-accent-blue hover:underline"
                      >
                        {t('pages.marketplace.getCredential')}{' '}
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    )}
                  </div>
                  <input
                    type={r.secret === false ? 'text' : 'password'}
                    value={envValues[r.key] ?? ''}
                    onChange={(e) => setEnvValues((s) => ({ ...s, [r.key]: e.target.value }))}
                    placeholder={
                      r.placeholder ??
                      (installed ? t('pages.marketplace.credentialPlaceholderInstalled') : '')
                    }
                    spellCheck={false}
                    autoComplete="off"
                    className="h-9 w-full rounded-md border border-hairline-strong bg-surface-subtle px-3 font-mono text-[12.5px] text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
                  />
                  {r.description && (
                    <span className="text-[11px] leading-relaxed text-text-muted">
                      {r.description}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Model scopes (apenas MCP já instalado — na 1ª instalação os scopes
            vêm da escolha de agentes no AssignAgentsDialog). */}
        {isMcp && installed && (
          <section className="mb-6">
            <SectionTitle icon={Layers}>{t('pages.marketplace.enableOnModels')}</SectionTitle>
            <p className="mb-3 mt-1 text-[11.5px] leading-relaxed text-text-muted">
              {t('pages.marketplace.modelScopeDesc')}
            </p>
            <ModelScopeManager options={scopeOptions} value={scopes} onChange={setScopes} />
          </section>
        )}

        {/* README */}
        {item.readme && (
          <section>
            <SectionTitle>{t('pages.marketplace.about')}</SectionTitle>
            <div className="mt-3">
              <Markdown>{item.readme}</Markdown>
            </div>
          </section>
        )}

        {item.tags && item.tags.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-1.5">
            {item.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-md border border-hairline bg-surface-hover px-1.5 py-0.5 font-mono text-[10.5px] text-text-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-3 border-t border-hairline px-6 py-4">
        <div className="text-[11px] text-text-faint">
          {installed
            ? isMcp
              ? t('pages.marketplace.footerEditMcp')
              : t('pages.marketplace.footerSkillLibrary')
            : isMcp && requiredMissing
              ? t('pages.marketplace.footerFillCreds')
              : ''}
        </div>
        <div className="flex items-center gap-2">
          {installed ? (
            <>
              <button
                type="button"
                onClick={() => removeMut.mutate()}
                disabled={busy}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 text-[12.5px] font-medium text-accent-red transition-colors hover:bg-accent-red/20 disabled:opacity-50"
              >
                {removeMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                {t('pages.marketplace.remove')}
              </button>
              {isMcp && (
                <button
                  type="button"
                  onClick={() => saveMut.mutate()}
                  disabled={busy}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-4 text-[12.5px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                >
                  {saveMut.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  {t('pages.marketplace.saveChanges')}
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => setAssignOpen(true)}
              disabled={busy || (isMcp && requiredMissing)}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-4 text-[12.5px] font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              {t('pages.marketplace.install')}
            </button>
          )}
        </div>
      </div>

      <AssignAgentsDialog
        item={item}
        env={nonEmptyEnv()}
        workspaceId={workspaceId}
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        onInstalled={() => {
          onChanged();
          onClose();
        }}
      />
    </>
  );
}

function SectionTitle({
  children,
  icon: Icon,
}: {
  children: React.ReactNode;
  icon?: typeof KeyRound;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </div>
  );
}
