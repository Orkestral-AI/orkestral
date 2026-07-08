import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Settings2,
  PackageOpen,
  Globe,
  KeyRound,
  Check,
  Download,
  Loader2,
  Terminal,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { toast } from '@renderer/stores/toastStore';
import { useT, type TFunction } from '@renderer/i18n';
import type { Skill, DetectedCliMcp, CliSource } from '@shared/types';
import { ItemDetailDialog } from './ItemDetailDialog';
import { MarketplaceIcon } from './MarketplaceIcon';
import { ProviderIcon } from '@renderer/components/ProviderIcon';
import {
  accentFor,
  logoSrc,
  readInstalledMeta,
  scopeSummary,
  deriveScopeOptions,
  type MarketplaceCatalogItem,
} from './shared';

interface InstalledManagerProps {
  kind: 'mcp' | 'skill';
  workspaceId: string;
}

const CLI_LABEL: Record<CliSource, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
};

/** Converte um MCP detectado num CLI em item de catálogo (pra reusar o install). */
function detectedToItem(d: DetectedCliMcp, t: TFunction): MarketplaceCatalogItem {
  const importedFrom = t('pages.marketplace.importedFrom', { cli: CLI_LABEL[d.source] });
  return {
    id: `cli.${d.source}.${d.name}`,
    kind: 'mcp',
    name: d.name,
    slug: d.name,
    description: importedFrom,
    sourceUrl: '',
    provider: 'cli',
    iconKey: 'Server',
    transport: d.transport,
    install: {
      skillKind: 'mcp',
      contentTemplate: `# ${d.name}\n\n${importedFrom}.`,
      config: {
        mcpServer: {
          command: d.command,
          args: d.args,
          env: d.env,
          url: d.url,
          headers: d.headers,
        },
      },
    },
  };
}

/** Aba "Instalados" — gerencia itens instalados + importa MCPs já nos CLIs. */
export function InstalledManager({ kind, workspaceId }: InstalledManagerProps) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<MarketplaceCatalogItem | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [open, setOpen] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);

  const skillsQuery = useQuery({
    queryKey: ['skills', workspaceId],
    queryFn: () => window.orkestral['skill:list']({ workspaceId }),
  });
  const catalogQuery = useQuery({
    queryKey: ['marketplace', kind],
    queryFn: () => window.orkestral['marketplace:list']({ kind }),
  });
  const agentsQuery = useQuery({
    queryKey: ['agents', workspaceId],
    queryFn: () => window.orkestral['agent:list']({ workspaceId }),
  });
  // MCPs detectados nos CLIs do usuário (só faz sentido pra kind mcp).
  const detectQuery = useQuery({
    queryKey: ['mcp-detect-cli'],
    enabled: kind === 'mcp',
    queryFn: () => window.orkestral['marketplace:detect-cli']({}),
  });

  const catalogById = useMemo(() => {
    const m = new Map<string, MarketplaceCatalogItem>();
    for (const it of catalogQuery.data ?? []) m.set(it.id, it);
    return m;
  }, [catalogQuery.data]);

  const scopeOptions = useMemo(
    () => deriveScopeOptions(agentsQuery.data ?? [], t),
    [agentsQuery.data, t],
  );

  // Itens instalados desse tipo (skills com metadata de marketplace).
  const installed = useMemo(() => {
    const list = (skillsQuery.data ?? []).filter((s) => s.kind === kind);
    return list
      .map((skill) => ({ skill, meta: readInstalledMeta(skill) }))
      .filter((x) => x.meta) as Array<{
      skill: Skill;
      meta: NonNullable<ReturnType<typeof readInstalledMeta>>;
    }>;
  }, [skillsQuery.data, kind]);

  const installedIds = useMemo(() => new Set(installed.map((x) => x.meta.id)), [installed]);
  const detected = kind === 'mcp' ? (detectQuery.data ?? []) : [];

  function refetch() {
    queryClient.invalidateQueries({ queryKey: ['skills', workspaceId] });
    queryClient.invalidateQueries({ queryKey: ['skills'] });
  }

  const importMut = useMutation({
    mutationFn: (d: DetectedCliMcp) =>
      window.orkestral['marketplace:install']({
        workspaceId,
        item: detectedToItem(d, t),
        modelScopes: ['*'],
      }),
    onMutate: (d) => setImportingId(`cli.${d.source}.${d.name}`),
    onSuccess: (_x, d) => {
      toast.success(
        t('pages.marketplace.importedToastTitle', { name: d.name }),
        t('pages.marketplace.importedToastDesc'),
      );
      refetch();
    },
    onError: (e) =>
      toast.error(
        t('pages.marketplace.importFailTitle'),
        e instanceof Error ? e.message : undefined,
      ),
    onSettled: () => setImportingId(null),
  });

  function openManage(skill: Skill, itemId: string) {
    const item = catalogById.get(itemId) ?? skillToItem(skill);
    setSelected(item);
    setSelectedSkill(skill);
    setOpen(true);
  }

  const isEmpty = installed.length === 0 && detected.length === 0;

  return (
    <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {isEmpty ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <PackageOpen className="h-8 w-8 text-text-faint" />
          <div className="mt-3 text-[13px] text-text-secondary">
            {t('pages.marketplace.nothingInstalled')}
          </div>
          <div className="mt-1 max-w-xs text-[12px] leading-relaxed text-text-muted">
            {kind === 'mcp'
              ? t('pages.marketplace.emptyInstalledMcp')
              : t('pages.marketplace.emptyInstalledSkill')}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {installed.length > 0 && (
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              {t('pages.marketplace.managedByOrkestral')}
            </div>
          )}
          {installed.map(({ skill, meta }) => {
            const item = catalogById.get(meta.id);
            const accent = accentFor(item?.accent);
            const envCount = Object.keys(meta.env).length + Object.keys(meta.headers).length;
            return (
              <button
                key={skill.id}
                type="button"
                onClick={() => openManage(skill, meta.id)}
                className="group flex items-center gap-3.5 rounded-xl border border-hairline-med bg-surface-veil px-4 py-3 text-left transition-colors hover:border-hairline-bright hover:bg-surface-3"
              >
                <div
                  className={cn(
                    'grid h-10 w-10 shrink-0 place-items-center rounded-lg border',
                    accent.bg,
                    accent.border,
                    accent.text,
                  )}
                >
                  <MarketplaceIcon
                    iconKey={item?.iconKey}
                    src={item ? logoSrc(item) : undefined}
                    kind={kind}
                    className="h-5 w-5"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-text-primary">
                    {skill.name}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-text-muted">
                    {kind === 'mcp' && (
                      <span className="inline-flex items-center gap-1">
                        <Globe className="h-3 w-3" />
                        {scopeSummary(meta, t)}
                      </span>
                    )}
                    {envCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-accent-green">
                        <KeyRound className="h-3 w-3" />
                        {t('pages.marketplace.credentialsOk')}
                      </span>
                    )}
                    {kind === 'skill' && (
                      <span className="inline-flex items-center gap-1">
                        <Check className="h-3 w-3" /> {t('pages.marketplace.inLibrary')}
                      </span>
                    )}
                  </div>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-hairline-strong px-2.5 py-1.5 text-[11.5px] text-text-secondary transition-colors group-hover:border-white/15 group-hover:text-text-primary">
                  <Settings2 className="h-3.5 w-3.5" />
                  {t('pages.marketplace.manage')}
                </span>
              </button>
            );
          })}

          {detected.length > 0 && (
            <div className="mt-5">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                <Terminal className="h-3.5 w-3.5" />
                {t('pages.marketplace.detectedInClis')}
              </div>
              <div className="mb-3 text-[11.5px] leading-relaxed text-text-muted">
                {t('pages.marketplace.detectedDesc')}
              </div>
              <div className="flex flex-col gap-2">
                {detected.map((d) => {
                  const id = `cli.${d.source}.${d.name}`;
                  const alreadyImported = installedIds.has(id);
                  const subtitle = d.url ?? `${d.command ?? ''} ${(d.args ?? []).join(' ')}`.trim();
                  return (
                    <div
                      key={`${d.source}:${d.scope ?? ''}:${d.name}`}
                      className="flex items-center gap-3.5 rounded-xl border border-hairline-med bg-surface-veil px-4 py-3"
                    >
                      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-hairline-heavy bg-surface-2 text-text-primary">
                        <ProviderIcon provider={d.source} className="h-[18px] w-[18px]" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13.5px] font-medium text-text-primary">
                            {d.name}
                          </span>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-hairline-strong bg-surface-1 py-0.5 pl-1 pr-2 text-[10px] font-medium text-text-secondary">
                            <ProviderIcon provider={d.source} className="h-3 w-3" />
                            {CLI_LABEL[d.source]}
                          </span>
                        </div>
                        {subtitle && (
                          <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
                            {subtitle}
                          </div>
                        )}
                      </div>
                      {alreadyImported ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-accent-green">
                          <Check className="h-3.5 w-3.5" />
                          {t('pages.marketplace.imported')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => importMut.mutate(d)}
                          disabled={importingId === id}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-hairline-heavy bg-surface-2 px-2.5 py-1.5 text-[11.5px] font-medium text-text-secondary transition-colors hover:border-accent-purple/40 hover:bg-accent-purple/15 hover:text-text-primary disabled:opacity-50"
                        >
                          {importingId === id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Download className="h-3.5 w-3.5" />
                          )}
                          {t('pages.marketplace.import')}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <ItemDetailDialog
        workspaceId={workspaceId}
        item={selected}
        installedSkill={selectedSkill}
        scopeOptions={scopeOptions}
        open={open}
        onOpenChange={setOpen}
        onChanged={refetch}
      />
    </div>
  );
}

/** Fallback quando o item não está mais no catálogo (custom ou removido). */
function skillToItem(skill: Skill): MarketplaceCatalogItem {
  const mk = ((skill.config ?? {}) as Record<string, unknown>).marketplace as
    | { id?: string; category?: string; iconKey?: string; transport?: 'stdio' | 'http' | 'sse' }
    | undefined;
  return {
    id: mk?.id ?? skill.id,
    kind: skill.kind === 'mcp' ? 'mcp' : 'skill',
    name: skill.name,
    slug: skill.slug,
    description: skill.description ?? '',
    longDescription: skill.description ?? undefined,
    readme: skill.content,
    category: mk?.category,
    iconKey: mk?.iconKey,
    transport: mk?.transport,
    sourceUrl: '',
    provider: 'orkestral',
    install: {
      skillKind: skill.kind,
      contentTemplate: skill.content,
      config: skill.config,
    },
  };
}
