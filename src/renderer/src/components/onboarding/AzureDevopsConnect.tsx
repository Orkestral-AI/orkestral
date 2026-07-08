import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  GitBranch,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import { useOnboardingStore } from '@renderer/stores/onboardingStore';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';
import type {
  AzureDevopsAccount,
  AzureDevopsDeviceCode,
  AzureDevopsDeviceFlowStatus,
  AzureDevopsRepoSummary,
} from '@shared/types';

export function AzureDevopsConnect({ showRepoPicker = true }: { showRepoPicker?: boolean } = {}) {
  const { t } = useT();
  const company = useOnboardingStore((s) => s.company);
  const patchCompany = useOnboardingStore((s) => s.patchCompany);

  const accountQuery = useQuery({
    queryKey: ['azure-devops', 'account'],
    queryFn: () => window.orkestral['azure-devops:get-account'](),
    staleTime: 30_000,
  });

  const account = accountQuery.data ?? null;
  const [connecting, setConnecting] = useState(false);

  if (accountQuery.isPending) {
    return (
      <div className="mt-2 flex h-11 items-center gap-2 rounded-lg border border-hairline-med bg-surface-subtle px-3 text-[12.5px] text-text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('onboarding.azure.verifyingConnection')}
      </div>
    );
  }

  if (!account) {
    return (
      <div className="mt-2">
        <AzureDeviceFlowPanel active={connecting} onActiveChange={setConnecting} />
        {!connecting && (
          <>
            <button
              type="button"
              onClick={() => setConnecting(true)}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-[#0078D4]/35 bg-[#0078D4]/10 px-4 text-[13px] font-medium text-text-primary transition-colors hover:border-[#0078D4]/55 hover:bg-[#0078D4]/15"
            >
              <MicrosoftLogoMark className="h-4 w-4" />
              {t('onboarding.azure.connect')}
            </button>
            <p className="mt-2 text-[11px] text-text-faint">{t('onboarding.azure.connectHint')}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <ConnectedAzureAccountBar account={account} />
      {showRepoPicker && (
        <AzureRepoPicker
          selectedRemoteUrls={company.sources
            .filter((source) => source.kind === 'azure_repo' && source.repoFullName)
            .map((source) => source.repoFullName!)}
          onToggle={(repo) => {
            const current = company.sources.filter((source) => source.kind !== 'azure_repo');
            const azureSources = company.sources.filter((source) => source.kind === 'azure_repo');
            const exists = azureSources.some((source) => source.repoFullName === repo.remoteUrl);
            const nextAzureSources = exists
              ? azureSources.filter((source) => source.repoFullName !== repo.remoteUrl)
              : [
                  ...azureSources,
                  {
                    kind: 'azure_repo' as const,
                    label: repo.name,
                    repoFullName: repo.remoteUrl,
                  },
                ];
            const first = nextAzureSources[0];
            patchCompany({
              provider: 'azure',
              sources: [...current, ...nextAzureSources],
              azureRepoFullName: first?.label ?? '',
              azureRepoRemoteUrl: first?.repoFullName ?? '',
              gitRemote: first?.repoFullName ?? '',
              path: '',
              githubRepoFullName: '',
              githubBranch: '',
              ...(company.name.trim() ? {} : { name: repo.name }),
            });
          }}
        />
      )}
    </div>
  );
}

function AzureDeviceFlowPanel({
  active,
  onActiveChange,
}: {
  active: boolean;
  onActiveChange: (value: boolean) => void;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const [code, setCode] = useState<AzureDevopsDeviceCode | null>(null);
  const [status, setStatus] = useState<
    'idle' | 'starting' | 'waiting' | 'expired' | 'denied' | 'error'
  >('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      setStatus('starting');
      setErrorMsg(null);
      setCode(null);
      void (async () => {
        try {
          const next = await window.orkestral['azure-devops:start-device-flow']();
          if (cancelled) return;
          setCode(next);
          setStatus('waiting');
          await window.orkestral['azure-devops:open-verification']({
            url: next.verificationUri,
          });
        } catch (err) {
          if (cancelled) return;
          setStatus('error');
          setErrorMsg(err instanceof Error ? err.message : String(err));
        }
      })();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [active]);

  useEffect(() => {
    if (!active || status !== 'waiting' || !code) return;
    let cancelled = false;
    let intervalSec = code.interval || 5;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const result: AzureDevopsDeviceFlowStatus = await window.orkestral[
          'azure-devops:poll-device-flow'
        ]({
          deviceCode: code!.deviceCode,
        });
        if (cancelled) return;
        switch (result.status) {
          case 'authorized':
            await qc.invalidateQueries({ queryKey: ['azure-devops'] });
            onActiveChange(false);
            return;
          case 'expired':
            setStatus('expired');
            return;
          case 'denied':
            setStatus('denied');
            return;
          case 'slow_down':
            intervalSec = result.interval;
            break;
          case 'pending':
          default:
            break;
        }
        timer = setTimeout(poll, intervalSec * 1000);
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    }

    timer = setTimeout(poll, intervalSec * 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, status, code, qc, onActiveChange]);

  function openOnMicrosoft() {
    if (!code) return;
    window.open(code.verificationUri, '_blank');
    window.orkestral['azure-devops:open-verification']({ url: code.verificationUri }).catch(
      () => undefined,
    );
  }

  function copyCode() {
    if (!code) return;
    navigator.clipboard
      .writeText(code.userCode)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => undefined);
  }

  if (!active) return null;

  return (
    <div className="rounded-lg border border-[#0078D4]/30 bg-[#0078D4]/[0.055] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-text-primary">
          <MicrosoftLogoMark className="h-3.5 w-3.5" />
          {t('onboarding.azure.dialogTitle')}
        </div>
        <button
          type="button"
          onClick={() => onActiveChange(false)}
          className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          title={t('onboarding.azure.close')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {status === 'starting' && (
        <div className="mt-3 flex h-20 items-center justify-center text-[12px] text-text-muted">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          {t('onboarding.azure.generatingCode')}
        </div>
      )}

      {status === 'waiting' && code && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="rounded-md border border-hairline bg-black/15 px-3 py-2 text-center text-[11px] leading-relaxed text-text-muted">
            {code.message}
          </div>
          <button
            type="button"
            onClick={copyCode}
            className={cn(
              'rounded-lg border py-4 transition-colors',
              copied
                ? 'border-accent-green/40 bg-accent-green/[0.08]'
                : 'border-hairline-strong bg-surface-hover hover:bg-white/[0.045]',
            )}
            title={copied ? t('onboarding.azure.copied') : t('onboarding.azure.clickToCopy')}
          >
            <div className="text-center font-mono text-[24px] font-medium tracking-[0.26em] text-text-primary">
              {code.userCode}
            </div>
            <div
              className="mt-1 flex items-center justify-center gap-1.5 text-[10.5px] text-text-muted"
              style={{ color: copied ? '#4ADE80' : undefined }}
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3" />
                  {t('onboarding.azure.copied')}
                </>
              ) : (
                t('onboarding.azure.clickToCopy')
              )}
            </div>
          </button>
          <button
            type="button"
            onClick={openOnMicrosoft}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-white px-4 text-[12.5px] font-medium text-black transition-colors hover:bg-white/90"
          >
            <MicrosoftLogoMark className="h-3.5 w-3.5" />
            <ExternalLink className="h-3.5 w-3.5" />
            {t('onboarding.azure.openMicrosoft')}
          </button>
          <div className="flex items-center justify-center gap-2 text-[11px] text-text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('onboarding.azure.waitingAuth')}
          </div>
        </div>
      )}

      {status === 'expired' && (
        <AzureErrorBlock
          title={t('onboarding.azure.expiredTitle')}
          body={t('onboarding.azure.expiredBody')}
        />
      )}
      {status === 'denied' && (
        <AzureErrorBlock
          title={t('onboarding.azure.deniedTitle')}
          body={t('onboarding.azure.deniedBody')}
        />
      )}
      {status === 'error' && (
        <AzureErrorBlock
          title={t('onboarding.azure.errorTitle')}
          body={errorMsg ?? t('onboarding.azure.errorBody')}
        />
      )}
    </div>
  );
}

function ConnectedAzureAccountBar({ account }: { account: AzureDevopsAccount }) {
  const { t } = useT();
  const qc = useQueryClient();
  const patchCompany = useOnboardingStore((s) => s.patchCompany);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await window.orkestral['azure-devops:disconnect']();
      patchCompany({
        azureRepoFullName: '',
        azureRepoRemoteUrl: '',
        gitRemote: '',
        sources: useOnboardingStore
          .getState()
          .company.sources.filter((source) => source.kind !== 'azure_repo'),
      });
      await qc.invalidateQueries({ queryKey: ['azure-devops'] });
    } finally {
      setDisconnecting(false);
    }
  }

  const label = account.displayName || account.email || 'Azure DevOps';

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-[#0078D4]/25 bg-[#0078D4]/[0.055] px-3 py-2">
      <div className="flex h-6 w-6 items-center justify-center rounded-md bg-white">
        <MicrosoftLogoMark className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 className="h-3 w-3 text-accent-green" />
          <span className="truncate text-[12.5px] font-medium text-text-primary">{label}</span>
        </div>
        <div className="truncate text-[10.5px] text-text-muted">
          {account.organizations.length > 0
            ? account.organizations.join(', ')
            : t('onboarding.azure.connected')}
        </div>
      </div>
      <button
        type="button"
        onClick={handleDisconnect}
        disabled={disconnecting}
        className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
        title={t('onboarding.azure.disconnect')}
      >
        {disconnecting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <X className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function AzureRepoPicker({
  selectedRemoteUrls,
  onToggle,
}: {
  selectedRemoteUrls: string[];
  onToggle: (repo: AzureDevopsRepoSummary) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selectedSet = useMemo(() => new Set(selectedRemoteUrls), [selectedRemoteUrls]);

  const reposQuery = useQuery({
    queryKey: ['azure-devops', 'repos'],
    queryFn: () => window.orkestral['azure-devops:list-repos']({}),
    staleTime: 60_000,
  });

  const repos = useMemo(() => reposQuery.data ?? [], [reposQuery.data]);
  const selected = useMemo(
    () => repos.filter((repo) => selectedSet.has(repo.remoteUrl)),
    [repos, selectedSet],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return repos;
    const q = query.trim().toLowerCase();
    return repos.filter(
      (repo) =>
        repo.fullName.toLowerCase().includes(q) ||
        repo.remoteUrl.toLowerCase().includes(q) ||
        repo.projectName.toLowerCase().includes(q),
    );
  }, [repos, query]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex h-11 w-full items-center gap-2 rounded-lg border border-hairline-med bg-surface-subtle px-3 text-left transition-colors hover:bg-surface-1',
          'focus:outline-none focus:ring-2 focus:ring-hairline-strong',
        )}
      >
        <AzureReposMark className="h-3.5 w-3.5 shrink-0" />
        <span
          className={cn(
            'truncate text-[12.5px]',
            selected.length > 0 ? 'font-mono text-text-primary' : 'text-text-muted',
          )}
        >
          {selected.length > 0
            ? selected.length === 1
              ? selected[0].fullName
              : t('onboarding.azure.selectedRepos', { count: selected.length })
            : reposQuery.isPending
              ? t('onboarding.azure.loadingRepos')
              : reposQuery.isError
                ? t('onboarding.azure.listError')
                : repos.length === 0
                  ? t('onboarding.azure.noRepos')
                  : t('onboarding.azure.chooseRepo')}
        </span>
        <span className="flex-1" />
        {reposQuery.isPending ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-muted" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-hidden rounded-lg border border-hairline-strong shadow-xl"
            style={{ background: '#0b0a10' }}
          >
            <div className="flex items-center gap-2 border-b border-hairline-faint px-3 py-2">
              <Search className="h-3.5 w-3.5 text-text-muted" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('onboarding.azure.searchRepo')}
                className="flex-1 bg-transparent text-[12.5px] text-text-primary placeholder:text-text-muted focus:outline-none"
              />
              {reposQuery.isError && (
                <button
                  type="button"
                  onClick={() => reposQuery.refetch()}
                  className="text-[11px] text-accent-blue hover:underline"
                >
                  {t('onboarding.azure.retry')}
                </button>
              )}
            </div>
            <div className="max-h-60 overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-[12px] text-text-muted">
                  {reposQuery.isPending
                    ? t('onboarding.azure.loading')
                    : t('onboarding.azure.empty')}
                </div>
              ) : (
                filtered.map((repo) => {
                  const isSelected = selectedSet.has(repo.remoteUrl);
                  return (
                    <button
                      key={repo.id}
                      type="button"
                      onClick={() => {
                        onToggle(repo);
                      }}
                      className={cn(
                        'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-2',
                        isSelected && 'bg-surface-1',
                      )}
                    >
                      <AzureReposMark className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[12.5px] text-text-primary">
                          {repo.fullName}
                        </div>
                        <div className="truncate text-[10.5px] text-text-muted">
                          {repo.remoteUrl}
                        </div>
                      </div>
                      {isSelected && (
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-green" />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AzureErrorBlock({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-3 rounded-lg border border-accent-red/30 bg-accent-red/[0.05] px-4 py-3 text-center">
      <div className="text-[12.5px] font-medium text-accent-red">{title}</div>
      <div className="mt-1 text-[11px] text-text-secondary">{body}</div>
    </div>
  );
}

export function MicrosoftLogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('grid shrink-0 grid-cols-2 grid-rows-2 gap-[1.5px]', className)}
    >
      <span className="block rounded-[1px] bg-[#F25022]" />
      <span className="block rounded-[1px] bg-[#7FBA00]" />
      <span className="block rounded-[1px] bg-[#00A4EF]" />
      <span className="block rounded-[1px] bg-[#FFB900]" />
    </span>
  );
}

export function AzureReposMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex items-center justify-center rounded-[3px] bg-[#0078D4] text-white shadow-[0_0_0_1px_rgba(255,255,255,0.12)_inset]',
        className,
      )}
    >
      <GitBranch className="h-[72%] w-[72%]" strokeWidth={2.4} />
    </span>
  );
}
