import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronRight,
  Folder,
  GitBranch,
  Github,
  Loader2,
  Search,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { ACCENTS, accentTokenFromColor } from '@renderer/lib/accents';
import { useT } from '@renderer/i18n';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { ProviderIcon } from '@renderer/components/ProviderIcon';
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog';
import type {
  AdapterType,
  AzureDevopsRepoSummary,
  GithubRepoSummary,
  Workspace,
  WorkspaceSourceKind,
} from '@shared/types';

// Paleta = mesmas cores de accent do app. A cor escolhida vira a "cor
// principal" do workspace: pinta o avatar E o accent quando ele está ativo.
const COMPANY_COLORS = ACCENTS.map((a) => a.hex);

type SourceTab = 'github' | 'azure' | 'folder';

/**
 * Payload de source montado no Step 3, no mesmo shape que o AddSourceDialog
 * envia pra `source:create` (menos workspaceId/isPrimary, adicionados no finish).
 */
type SourceDraft = {
  kind: WorkspaceSourceKind;
  label: string;
  path?: string | null;
  repoFullName?: string | null;
} | null;

/** Source confirmado (não-nulo). O Step 3 mantém uma LISTA: uma pasta local
 *  pode render a pasta-mãe + cada repo git achado dentro (varredura). */
type ConfirmedSource = NonNullable<SourceDraft>;

/** Item da varredura de pasta local (pasta-mãe + repos git dentro). */
type FolderPick = {
  path: string;
  label: string;
  isGit: boolean;
  checked: boolean;
};

function baseName(p: string): string {
  return p.split('/').filter(Boolean).pop() || p;
}

function picksToSources(list: FolderPick[]): ConfirmedSource[] {
  return list
    .filter((it) => it.checked)
    .map((it) => ({
      kind: 'local_folder' as const,
      label: it.label.trim() || baseName(it.path),
      path: it.path,
    }));
}

/**
 * Wizard de 3 passos pra criar um workspace:
 *  1. Nome (+ cor opcional)
 *  2. Orquestrador (CEO) — adapter + model
 *  3. Source opcional (GitHub repo ou pasta local) — pode pular
 *
 * No finish: cria o workspace, troca pra ele, cria o CEO/Orchestrator
 * (idempotente) e, se houver, cria o source primário.
 */
export function CreateWorkspaceWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const setActive = useWorkspaceStore((s) => s.setActive);

  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(COMPANY_COLORS[0]);

  // Step 2
  const [agentName, setAgentName] = useState('CEO');
  const [adapterType, setAdapterType] = useState<AdapterType>('claude_local');
  const [model, setModel] = useState<string>('default');

  // Step 3
  const [sourceTab, setSourceTab] = useState<SourceTab>('github');
  const [sources, setSources] = useState<ConfirmedSource[]>([]);
  // Gera o time inicial (hiring plan do CEO) ao finalizar — mesmo toggle do
  // onboarding. Default ligado.
  const [generateTeam, setGenerateTeam] = useState(true);

  // finish — `void` evita warning de promise não-tratada no onClick
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adaptersQuery = useQuery({
    queryKey: ['adapters'],
    queryFn: () => window.orkestral['adapter:list'](),
    enabled: open,
  });
  const adaptersForCeo = (adaptersQuery.data ?? []).filter((a) => !a.executorOnly);

  const modelsQuery = useQuery({
    queryKey: ['adapter-models', adapterType],
    queryFn: () => window.orkestral['adapter:list-models']({ type: adapterType }),
    enabled: open && !!adapterType,
  });
  const models = modelsQuery.data ?? [];

  const adapterOptions = adaptersForCeo.map((a) => ({
    value: a.type,
    label: a.name,
    icon: <ProviderIcon provider={a.type} className="h-4 w-4 text-text-secondary" />,
  }));
  // A lista do adapter às vezes já traz um "default" (configurado no CLI). Só
  // injeta o "Padrão" sintético quando ela NÃO traz, pra não duplicar a opção.
  const hasDefaultModel = models.some((m) => m.id === 'default');
  const modelOptions = [
    ...(hasDefaultModel
      ? []
      : [{ value: 'default', label: t('workspace.stepOrchestrator.modelDefault') }]),
    ...models.map((m) => ({ value: m.id, label: m.label, hint: m.id })),
  ];

  function reset(): void {
    setStep(1);
    setName('');
    setColor(COMPANY_COLORS[0]);
    setAgentName('CEO');
    setAdapterType('claude_local');
    setModel('default');
    setSourceTab('github');
    setSources([]);
    setGenerateTeam(true);
    setSubmitting(false);
    setError(null);
  }

  function handleClose(): void {
    if (submitting) return;
    reset();
    onClose();
  }

  async function handleFinish(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      // 1. Cria o workspace.
      const ws = await window.orkestral['workspace:create']({ name: name.trim(), color });

      // 2. Auto-switch — insere o novo workspace no cache ANTES de ativar, pra
      // a lista já conter ele e o WorkspaceSwitcher não resetar pro list[0]
      // durante o refetch (corrida de hidratação).
      queryClient.setQueryData<Workspace[]>(['workspaces'], (old) => {
        const arr = old ?? [];
        return arr.some((w) => w.id === ws.id) ? arr : [...arr, ws];
      });
      setActive(ws);
      window.location.hash = '#/';
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });

      // 3. CEO/Orchestrator (idempotente no main).
      await window.orkestral['agent:create-orchestrator']({
        workspaceId: ws.id,
        name: agentName.trim() || 'CEO',
        adapterType,
        model: model === 'default' ? undefined : model,
        adapterConfig: {},
      });

      // 4. Sources opcionais — pode ser mais de um (a pasta-mãe + cada repo git
      // achado na varredura). O primeiro vira primário; o hiring plan roda uma
      // vez só (no último), pra não propor vários times.
      for (let i = 0; i < sources.length; i++) {
        const s = sources[i];
        await window.orkestral['source:create']({
          workspaceId: ws.id,
          kind: s.kind,
          label: s.label,
          path: s.path ?? null,
          repoFullName: s.repoFullName ?? null,
          isPrimary: i === 0,
          runHiringPlanAfterCreate: generateTeam && i === sources.length - 1,
          runKnowledgeAnalysisAfterCreate: true,
        });
      }

      // 5. Revalida queries do workspace recém-criado. Quando há source, o
      // próprio source:create agenda KB/embeddings e hiring no momento correto
      // (após clone para GitHub/Azure; imediato para pasta local).
      queryClient.invalidateQueries({ queryKey: ['agents', ws.id] });
      queryClient.invalidateQueries({ queryKey: ['sources', ws.id] });
      queryClient.invalidateQueries({ queryKey: ['source-list', ws.id] });

      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('workspace.wizard.createError'));
      setSubmitting(false);
    }
  }

  const canNext = step === 1 ? name.trim().length > 0 : true;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) handleClose();
      }}
    >
      <DialogContent className="max-w-xl" data-accent={accentTokenFromColor(color)}>
        {/* Header com indicador de passo */}
        <div className="border-b border-hairline-soft px-6 pt-6 pb-4">
          <div className="flex items-center justify-between pr-8">
            <DialogTitle className="text-[15px] font-semibold tracking-tight text-text-primary">
              {t('workspace.wizard.title')}
            </DialogTitle>
            <span className="text-[11px] text-text-muted">
              {t('workspace.wizard.stepIndicator', { step })}
            </span>
          </div>
          <div className="mt-3 flex gap-1.5">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors',
                  n <= step ? 'bg-accent-purple' : 'bg-surface-elevated',
                )}
              />
            ))}
          </div>
        </div>

        <div className="thin-scrollbar overflow-y-auto px-6 py-5">
          {step === 1 && (
            <StepWorkspace name={name} setName={setName} color={color} setColor={setColor} />
          )}
          {step === 2 && (
            <StepOrchestrator
              agentName={agentName}
              setAgentName={setAgentName}
              adapterType={adapterType}
              setAdapterType={(t) => {
                setAdapterType(t);
                setModel('default');
              }}
              model={model}
              setModel={setModel}
              adapterOptions={adapterOptions}
              modelOptions={modelOptions}
            />
          )}
          {step === 3 && (
            <>
              <StepSource
                tab={sourceTab}
                setTab={setSourceTab}
                sources={sources}
                setSources={setSources}
              />
              <label
                className={cn(
                  'mt-4 flex items-start gap-2.5 rounded-xl border border-hairline-soft bg-surface-1/40 px-3.5 py-3 text-left transition-colors',
                  sources.length === 0
                    ? 'cursor-not-allowed opacity-50'
                    : 'cursor-pointer hover:border-hairline-strong',
                )}
              >
                <input
                  type="checkbox"
                  checked={generateTeam && sources.length > 0}
                  disabled={sources.length === 0}
                  onChange={(e) => setGenerateTeam(e.currentTarget.checked)}
                  className="mt-[1px] h-4 w-4 rounded border-white/20 bg-white/10"
                />
                <div>
                  <div className="text-[13px] font-medium text-text-primary">
                    {t('workspace.wizard.generateTeamTitle')}
                  </div>
                  <div className="mt-0.5 text-[11.5px] leading-snug text-text-muted">
                    {t('workspace.wizard.generateTeamDesc')}
                  </div>
                </div>
              </label>
            </>
          )}

          {error && (
            <div className="mt-4 rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-hairline-soft px-6 py-4">
          <button
            type="button"
            disabled={step === 1 || submitting}
            onClick={() => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s))}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-hairline-strong px-3.5 text-[12.5px] text-text-secondary hover:bg-surface-1 hover:text-text-primary disabled:opacity-30"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('common.back')}
          </button>

          {step < 3 ? (
            <button
              type="button"
              disabled={!canNext}
              onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-text-primary px-4 text-[12.5px] font-medium text-background hover:opacity-90 disabled:opacity-40"
            >
              {t('workspace.wizard.next')}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting || !name.trim()}
              onClick={handleFinish}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-text-primary px-4 text-[12.5px] font-medium text-background hover:opacity-90 disabled:opacity-40"
            >
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('workspace.wizard.createWorkspace')}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Step 1 — Workspace
// -----------------------------------------------------------------------------

function StepWorkspace({
  name,
  setName,
  color,
  setColor,
}: {
  name: string;
  setName: (v: string) => void;
  color: string;
  setColor: (v: string) => void;
}) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-5">
      <Field label={t('workspace.stepWorkspace.nameLabel')}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('workspace.stepWorkspace.namePlaceholder')}
          className="h-10 w-full rounded-lg border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-3 text-[13px] text-text-primary placeholder:text-text-muted transition-colors focus:border-[var(--color-input-border-focus)] focus:outline-none"
        />
      </Field>

      <Field label={t('workspace.stepWorkspace.colorLabel')}>
        <div className="flex flex-wrap gap-2">
          {COMPANY_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={t('workspace.stepWorkspace.colorAria', { color: c })}
              className={cn(
                'h-7 w-7 rounded-full transition-transform hover:scale-110',
                color === c &&
                  'ring-2 ring-text-primary ring-offset-2 ring-offset-[var(--color-dialog)]',
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </Field>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Step 2 — Orquestrador (CEO)
// -----------------------------------------------------------------------------

function StepOrchestrator({
  agentName,
  setAgentName,
  adapterType,
  setAdapterType,
  model,
  setModel,
  adapterOptions,
  modelOptions,
}: {
  agentName: string;
  setAgentName: (v: string) => void;
  adapterType: AdapterType;
  setAdapterType: (v: AdapterType) => void;
  model: string;
  setModel: (v: string) => void;
  adapterOptions: { value: string; label: string }[];
  modelOptions: { value: string; label: string; hint?: string }[];
}) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3 rounded-lg border border-hairline bg-surface-1 p-3">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-accent-purple" />
        <p className="text-[11.5px] text-text-muted">{t('workspace.stepOrchestrator.blurb')}</p>
      </div>

      <Field label={t('workspace.stepOrchestrator.agentNameLabel')}>
        <input
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="CEO"
          className="h-10 w-full rounded-lg border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-3 text-[13px] text-text-primary placeholder:text-text-muted transition-colors focus:border-[var(--color-input-border-focus)] focus:outline-none"
        />
      </Field>

      <Field label={t('workspace.stepOrchestrator.adapterLabel')}>
        <DSSelect
          value={adapterType}
          onChange={(v) => setAdapterType(v as AdapterType)}
          options={adapterOptions}
          placeholder={t('workspace.stepOrchestrator.adapterPlaceholder')}
          className="h-10 w-full text-[13px]"
        />
      </Field>

      <Field label={t('workspace.stepOrchestrator.modelLabel')}>
        <DSSelect
          value={model}
          onChange={setModel}
          options={modelOptions}
          placeholder={t('workspace.stepOrchestrator.modelDefault')}
          className="h-10 w-full text-[13px]"
        />
      </Field>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Step 3 — Source (opcional)
// -----------------------------------------------------------------------------

function StepSource({
  tab,
  setTab,
  sources,
  setSources,
}: {
  tab: SourceTab;
  setTab: (t: SourceTab) => void;
  sources: ConfirmedSource[];
  setSources: (s: ConfirmedSource[]) => void;
}) {
  const { t } = useT();
  const remoteSelected =
    sources.length === 1 && (sources[0].kind === 'github_repo' || sources[0].kind === 'azure_repo');
  // Trocar de aba zera a seleção — cada aba começa limpa, sem estado órfão.
  function switchTab(next: SourceTab): void {
    if (next === tab) return;
    setSources([]);
    setTab(next);
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[11.5px] text-text-muted">{t('workspace.stepSource.blurb')}</p>

      <div className="flex gap-1">
        <TabBtn active={tab === 'github'} onClick={() => switchTab('github')}>
          <Github className="h-3.5 w-3.5" />
          {t('workspace.stepSource.githubTab')}
        </TabBtn>
        <TabBtn active={tab === 'azure'} onClick={() => switchTab('azure')}>
          <GitBranch className="h-3.5 w-3.5" />
          {t('workspace.stepSource.azureTab')}
        </TabBtn>
        <TabBtn active={tab === 'folder'} onClick={() => switchTab('folder')}>
          <Folder className="h-3.5 w-3.5" />
          {t('workspace.stepSource.folderTab')}
        </TabBtn>
      </div>

      {tab === 'folder' ? (
        <LocalFolderPicker onSources={setSources} />
      ) : remoteSelected ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-accent-purple/30 bg-accent-purple/[0.06] p-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {sources[0].kind === 'github_repo' ? (
              <Github className="h-4 w-4 shrink-0 text-text-secondary" />
            ) : (
              <GitBranch className="h-4 w-4 shrink-0 text-text-secondary" />
            )}
            <div className="min-w-0">
              <div className="truncate text-[12.5px] text-text-primary">{sources[0].label}</div>
              <div className="truncate font-mono text-[10.5px] text-text-muted">
                {sources[0].repoFullName ?? sources[0].path}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSources([])}
            className="shrink-0 rounded-md px-2 py-1 text-[11.5px] text-text-muted hover:bg-surface-active hover:text-text-primary"
          >
            {t('workspace.stepSource.swap')}
          </button>
        </div>
      ) : tab === 'github' ? (
        <GithubRepoPicker
          onPick={(repo) => {
            if (repo) setSources([repo]);
          }}
        />
      ) : (
        <AzureRepoPicker
          onPick={(repo) => {
            if (repo) setSources([repo]);
          }}
        />
      )}

      <div className="rounded-md border border-hairline-soft bg-surface-1 px-3 py-2.5 text-[11px] text-text-muted">
        {t('workspace.stepSource.optionalNotePrefix')}
        <span className="text-text-secondary">{t('workspace.stepSource.optionalNoteAction')}</span>
        {t('workspace.stepSource.optionalNoteSuffix')}
      </div>
    </div>
  );
}

function GithubRepoPicker({ onPick }: { onPick: (s: SourceDraft) => void }) {
  const { t } = useT();
  const reposQuery = useQuery<GithubRepoSummary[]>({
    queryKey: ['github-repos'],
    queryFn: () => window.orkestral['github:list-repos'](),
  });
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reposQuery.data ?? [];
    return (reposQuery.data ?? []).filter((r) => r.fullName.toLowerCase().includes(q));
  }, [reposQuery.data, query]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('workspace.repoPicker.searchPlaceholder')}
          className="h-10 w-full rounded-lg border border-[var(--color-input-border)] bg-[var(--color-input-bg)] pl-9 pr-3 text-[13px] text-text-primary placeholder:text-text-muted transition-colors focus:border-[var(--color-input-border-focus)] focus:outline-none"
        />
      </div>

      <div className="thin-scrollbar -mx-1 max-h-[260px] overflow-y-auto px-1">
        {reposQuery.isPending ? (
          <div className="flex items-center justify-center py-10 text-[12px] text-text-muted">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('workspace.repoPicker.loading')}
          </div>
        ) : reposQuery.isError ? (
          <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] p-3 text-[11.5px] text-accent-red">
            {(reposQuery.error as Error)?.message ?? t('workspace.repoPicker.listError')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-text-muted">
            {t('workspace.repoPicker.empty')}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.slice(0, 50).map((r) => (
              <button
                key={r.fullName}
                type="button"
                onClick={() =>
                  onPick({ kind: 'github_repo', label: r.name, repoFullName: r.fullName })
                }
                className="group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-1"
              >
                <Github className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted group-hover:text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[12px] text-text-primary">{r.fullName}</div>
                  {r.description && (
                    <div className="mt-0.5 truncate text-[11px] text-text-muted">
                      {r.description}
                    </div>
                  )}
                </div>
                <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-text-faint group-hover:text-text-secondary" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AzureRepoPicker({ onPick }: { onPick: (s: SourceDraft) => void }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const accountQuery = useQuery({
    queryKey: ['azure-devops-account'],
    queryFn: () => window.orkestral['azure-devops:get-account'](),
  });
  const reposQuery = useQuery<AzureDevopsRepoSummary[]>({
    queryKey: ['azure-devops-repos'],
    enabled: !!accountQuery.data,
    queryFn: () => window.orkestral['azure-devops:list-repos']({}),
  });
  const startFlowMutation = useQuery({
    queryKey: ['azure-devops-connect-flow'],
    enabled: false,
    queryFn: async () => {
      const flow = await window.orkestral['azure-devops:start-device-flow']();
      await window.orkestral['azure-devops:open-verification']({ url: flow.verificationUri });
      const started = Date.now();
      let interval = Math.max(3, flow.interval);
      while (Date.now() - started < flow.expiresIn * 1000) {
        await new Promise((resolve) => window.setTimeout(resolve, interval * 1000));
        const poll = await window.orkestral['azure-devops:poll-device-flow']({
          deviceCode: flow.deviceCode,
        });
        if (poll.status === 'pending') continue;
        if (poll.status === 'slow_down') {
          interval = Math.max(interval + 2, poll.interval);
          continue;
        }
        if (poll.status === 'authorized') {
          queryClient.invalidateQueries({ queryKey: ['azure-devops-account'] });
          queryClient.invalidateQueries({ queryKey: ['azure-devops-repos'] });
          return poll.account;
        }
        throw new Error(t('workspace.stepSource.azureAuthCancelled'));
      }
      throw new Error(t('workspace.stepSource.azureAuthExpired'));
    },
  });
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reposQuery.data ?? [];
    return (reposQuery.data ?? []).filter((r) => r.fullName.toLowerCase().includes(q));
  }, [reposQuery.data, query]);

  if (!accountQuery.data) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-hairline-soft bg-surface-1 px-3 py-2.5 text-[11px] leading-relaxed text-text-muted">
          {t('workspace.stepSource.azureConnectHelp')}
        </div>
        {startFlowMutation.error && (
          <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
            {(startFlowMutation.error as Error).message}
          </div>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            disabled={startFlowMutation.isFetching}
            onClick={() => startFlowMutation.refetch()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-hairline-strong px-3.5 text-[12.5px] text-text-secondary hover:bg-surface-1 hover:text-text-primary disabled:opacity-40"
          >
            {startFlowMutation.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('workspace.stepSource.azureConnect')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('workspace.stepSource.azureSearchPlaceholder')}
          className="h-10 w-full rounded-lg border border-[var(--color-input-border)] bg-[var(--color-input-bg)] pl-9 pr-3 text-[13px] text-text-primary placeholder:text-text-muted transition-colors focus:border-[var(--color-input-border-focus)] focus:outline-none"
        />
      </div>

      <div className="thin-scrollbar -mx-1 max-h-[260px] overflow-y-auto px-1">
        {reposQuery.isPending ? (
          <div className="flex items-center justify-center py-10 text-[12px] text-text-muted">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('workspace.stepSource.azureLoading')}
          </div>
        ) : reposQuery.isError ? (
          <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] p-3 text-[11.5px] text-accent-red">
            {(reposQuery.error as Error)?.message ?? t('workspace.stepSource.azureListError')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-text-muted">
            {t('workspace.stepSource.azureEmpty')}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.slice(0, 80).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() =>
                  onPick({
                    kind: 'azure_repo',
                    label: r.name,
                    repoFullName: r.remoteUrl,
                  })
                }
                className="group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-1"
              >
                <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted group-hover:text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[12px] text-text-primary">{r.fullName}</div>
                  <div className="mt-0.5 truncate text-[11px] text-text-muted">{r.remoteUrl}</div>
                </div>
                <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-text-faint group-hover:text-text-secondary" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LocalFolderPicker({ onSources }: { onSources: (s: ConfirmedSource[]) => void }) {
  const { t } = useT();
  const [path, setPath] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [picks, setPicks] = useState<FolderPick[] | null>(null);
  const firstRun = useRef(true);

  async function pick(): Promise<void> {
    const res = await window.orkestral['source:pick-folder']({});
    if (res.path) setPath(res.path);
  }

  // Varre a pasta automaticamente (debounce) sempre que o path muda. Sem botão
  // de confirmar (Opção A): a seleção JÁ é o source, então não dá pra criar o
  // workspace perdendo a pasta. Se a pasta tem repos git dentro, vira seleção.
  useEffect(() => {
    const p = path.trim();
    if (!p) {
      if (!firstRun.current) {
        setPicks(null);
        setScanError(null);
        onSources([]);
      }
      firstRun.current = false;
      return;
    }
    firstRun.current = false;
    let cancelled = false;
    setScanning(true);
    const id = setTimeout(async () => {
      try {
        const res = await window.orkestral['source:scan-folder']({ path: p });
        if (cancelled) return;
        const list: FolderPick[] =
          res.rootIsGit || res.repos.length === 0
            ? [{ path: p, label: baseName(p), isGit: res.rootIsGit, checked: true }]
            : [
                { path: p, label: baseName(p), isGit: false, checked: true },
                ...res.repos.map((r) => ({
                  path: r.path,
                  label: r.name,
                  isGit: true,
                  checked: true,
                })),
              ];
        setPicks(list);
        setScanError(null);
        onSources(picksToSources(list));
      } catch (err) {
        if (cancelled) return;
        setScanError(err instanceof Error ? err.message : String(err));
        setPicks(null);
        onSources([]);
      } finally {
        if (!cancelled) setScanning(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  function update(list: FolderPick[]): void {
    setPicks(list);
    onSources(picksToSources(list));
  }

  const hasRepos = !!picks && picks.length > 1;

  return (
    <div className="flex flex-col gap-4">
      <Field label={t('workspace.folderPicker.folderLabel')}>
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t('workspace.folderPicker.folderPlaceholder')}
            className="h-10 flex-1 rounded-lg border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-3 font-mono text-[12px] text-text-primary placeholder:text-text-muted transition-colors focus:border-[var(--color-input-border-focus)] focus:outline-none"
          />
          <button
            type="button"
            onClick={pick}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-hairline-strong bg-surface-1 px-3 text-[12.5px] font-medium text-text-primary hover:bg-surface-active"
          >
            <Folder className="h-3.5 w-3.5" />
            {t('common.choose')}
          </button>
        </div>
      </Field>

      {scanning && (
        <div className="flex items-center gap-2 text-[11.5px] text-text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('workspace.folderPicker.scanning')}
        </div>
      )}

      {scanError && (
        <div className="rounded-md border border-accent-red/30 bg-accent-red/[0.06] px-3 py-2 text-[11.5px] text-accent-red">
          {scanError}
        </div>
      )}

      {picks && !scanning && (
        <div className="flex flex-col gap-2">
          {hasRepos && (
            <p className="text-[11.5px] text-text-secondary">
              {t('workspace.folderPicker.scanFound')}
            </p>
          )}
          <div className="thin-scrollbar -mx-1 flex max-h-[240px] flex-col gap-1.5 overflow-y-auto px-1">
            {picks.map((it, idx) => (
              <div
                key={it.path}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors',
                  it.checked
                    ? 'border-accent-purple/30 bg-accent-purple/[0.06]'
                    : 'border-hairline-soft',
                )}
              >
                <input
                  type="checkbox"
                  checked={it.checked}
                  onChange={(e) =>
                    update(
                      picks.map((p2, i) =>
                        i === idx ? { ...p2, checked: e.currentTarget.checked } : p2,
                      ),
                    )
                  }
                  className="mt-1 h-3.5 w-3.5 cursor-pointer accent-accent-purple"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {it.isGit ? (
                      <GitBranch className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                    ) : (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                    )}
                    <span className="truncate font-mono text-[10.5px] text-text-muted">
                      {it.path}
                    </span>
                    {!it.isGit && hasRepos && (
                      <span className="shrink-0 rounded-full border border-hairline-strong px-1.5 py-0.5 text-[9.5px] text-text-faint">
                        {t('workspace.folderPicker.localFolderBadge')}
                      </span>
                    )}
                  </div>
                  <input
                    value={it.label}
                    onChange={(e) =>
                      update(
                        picks.map((p2, i) =>
                          i === idx ? { ...p2, label: e.currentTarget.value } : p2,
                        ),
                      )
                    }
                    disabled={!it.checked}
                    placeholder={baseName(it.path)}
                    className="mt-2 h-8 w-full rounded-md border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-2.5 text-[12px] text-text-primary placeholder:text-text-muted transition-colors focus:border-[var(--color-input-border-focus)] focus:outline-none disabled:opacity-40"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition-colors',
        active
          ? 'bg-surface-active text-text-primary'
          : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[10.5px] font-medium uppercase tracking-wider text-text-faint">
        {label}
      </label>
      {children}
    </div>
  );
}
