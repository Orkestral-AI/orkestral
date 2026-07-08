import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Github,
  Loader2,
  Check,
  ExternalLink,
  CheckCircle2,
  Search,
  Lock,
  Globe,
  ChevronDown,
  X,
} from 'lucide-react';
import { useOnboardingStore } from '@renderer/stores/onboardingStore';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';
import type {
  GithubAccount,
  GithubDeviceCode,
  GithubDeviceFlowStatus,
  GithubRepoSummary,
} from '@shared/types';

/**
 * Fluxo de conexão com o GitHub via Device Flow.
 *  - Se não conectado: mostra botão "Conectar GitHub" → abre DeviceFlowDialog.
 *  - Se conectado: mostra avatar + login + dropdown listando os repos.
 *
 * Estado é sincronizado com o onboarding store: ao escolher um repo, grava
 * `gitRemote`, `githubRepoFullName` e `githubBranch` em company.
 */
export function GithubConnect({ showRepoPicker = true }: { showRepoPicker?: boolean } = {}) {
  const { t } = useT();
  const company = useOnboardingStore((s) => s.company);
  const patchCompany = useOnboardingStore((s) => s.patchCompany);
  const [activeAccountLogin, setActiveAccountLogin] = useState<string | null>(null);
  const [deviceFlowOpen, setDeviceFlowOpen] = useState(false);

  const accountsQuery = useQuery({
    queryKey: ['github', 'accounts'],
    queryFn: () => window.orkestral['github:list-accounts'](),
    staleTime: 30_000,
  });

  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const activeAccount = useMemo(
    () => accounts.find((account) => account.login === activeAccountLogin) ?? accounts[0] ?? null,
    [accounts, activeAccountLogin],
  );

  if (accountsQuery.isPending) {
    return (
      <div className="mt-2 flex h-11 items-center gap-2 rounded-lg border border-hairline-med bg-surface-subtle px-3 text-[12.5px] text-text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('onboarding.github.verifyingConnection')}
      </div>
    );
  }

  if (!activeAccount) {
    return (
      <>
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setDeviceFlowOpen(true)}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-hairline-strong bg-surface-1 px-4 text-[13px] font-medium text-text-primary transition-colors hover:bg-surface-4"
          >
            <Github className="h-4 w-4" />
            {t('onboarding.github.connect')}
          </button>
          <p className="mt-2 text-[11px] text-text-faint">{t('onboarding.github.connectHint')}</p>
        </div>
        <DeviceFlowDialog
          open={deviceFlowOpen}
          onOpenChange={setDeviceFlowOpen}
          onConnected={(account) => {
            setActiveAccountLogin(account.login);
            setDeviceFlowOpen(false);
          }}
        />
      </>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <ConnectedAccountBar
        account={activeAccount}
        accounts={accounts}
        onSelectAccount={setActiveAccountLogin}
        onConnectAnother={() => setDeviceFlowOpen(true)}
      />
      {showRepoPicker && (
        <RepoPicker
          accountLogin={activeAccount.login}
          selectedFullNames={company.sources
            .filter(
              (source) =>
                source.kind === 'github_repo' &&
                source.repoFullName &&
                (source.githubAccountLogin ?? activeAccount.login) === activeAccount.login,
            )
            .map((source) => source.repoFullName!)}
          onToggle={(repo) => {
            const current = company.sources.filter((source) => source.kind !== 'github_repo');
            const githubSources = company.sources.filter((source) => source.kind === 'github_repo');
            const exists = githubSources.some(
              (source) =>
                source.repoFullName === repo.fullName &&
                (source.githubAccountLogin ?? activeAccount.login) === activeAccount.login,
            );
            const nextGithubSources = exists
              ? githubSources.filter(
                  (source) =>
                    !(
                      source.repoFullName === repo.fullName &&
                      (source.githubAccountLogin ?? activeAccount.login) === activeAccount.login
                    ),
                )
              : [
                  ...githubSources,
                  {
                    kind: 'github_repo' as const,
                    label: repo.name,
                    repoFullName: repo.fullName,
                    branch: repo.defaultBranch,
                    githubAccountLogin: activeAccount.login,
                  },
                ];
            const first = nextGithubSources[0];
            patchCompany({
              sources: [...current, ...nextGithubSources],
              githubRepoFullName: first?.repoFullName ?? '',
              githubBranch: first?.branch ?? '',
              gitRemote:
                reposCloneUrl(repo, first?.repoFullName) ??
                (first ? `https://github.com/${first.repoFullName}.git` : ''),
              // Auto-preenche o nome do workspace se ainda vazio
              ...(company.name.trim() ? {} : { name: repo.name }),
            });
          }}
        />
      )}
      <DeviceFlowDialog
        open={deviceFlowOpen}
        onOpenChange={setDeviceFlowOpen}
        onConnected={(account) => {
          setActiveAccountLogin(account.login);
          setDeviceFlowOpen(false);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conta conectada — pílula com avatar + botão desconectar
// ---------------------------------------------------------------------------

function ConnectedAccountBar({
  account,
  accounts,
  onSelectAccount,
  onConnectAnother,
}: {
  account: GithubAccount;
  accounts: GithubAccount[];
  onSelectAccount: (login: string) => void;
  onConnectAnother: () => void;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const patchCompany = useOnboardingStore((s) => s.patchCompany);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await window.orkestral['github:disconnect']({ accountLogin: account.login });
      // Limpa as escolhas relacionadas ao GitHub no draft
      const current = useOnboardingStore.getState().company.sources;
      const remainingSources = current.filter(
        (source) =>
          source.kind !== 'github_repo' ||
          (source.githubAccountLogin && source.githubAccountLogin !== account.login),
      );
      const firstGithub = remainingSources.find(
        (source) => source.kind === 'github_repo' && source.repoFullName,
      );
      patchCompany({
        githubRepoFullName: firstGithub?.repoFullName ?? '',
        githubBranch: firstGithub?.branch ?? '',
        gitRemote: firstGithub?.repoFullName
          ? `https://github.com/${firstGithub.repoFullName}.git`
          : '',
        sources: remainingSources,
      });
      await qc.invalidateQueries({ queryKey: ['github'] });
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg border border-hairline-med bg-surface-subtle px-3 py-2 text-left transition-colors hover:bg-surface-1"
      >
        <GithubAccountAvatar account={account} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3 w-3 text-accent-green" />
            <span className="truncate text-[12.5px] font-medium text-text-primary">
              {account.displayName || account.login}
            </span>
          </div>
          <div className="truncate text-[10.5px] text-text-muted">@{account.login}</div>
        </div>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-hairline-strong shadow-xl"
            style={{ background: '#0b0a10' }}
          >
            <div className="border-b border-hairline-faint px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-text-faint">
              {t('onboarding.github.selectAccount')}
            </div>
            <div className="max-h-52 overflow-y-auto py-1">
              {accounts.map((item) => {
                const selected = item.login === account.login;
                return (
                  <button
                    key={item.login}
                    type="button"
                    onClick={() => {
                      onSelectAccount(item.login);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-2',
                      selected && 'bg-surface-1',
                    )}
                  >
                    <GithubAccountAvatar account={item} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium text-text-primary">
                        {item.displayName || item.login}
                      </div>
                      <div className="truncate text-[10.5px] text-text-muted">@{item.login}</div>
                    </div>
                    {selected && (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent-green" />
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1 border-t border-hairline-faint p-1.5">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onConnectAnother();
                }}
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-[12px] font-medium text-text-primary transition-colors hover:bg-surface-2"
              >
                <Github className="h-3.5 w-3.5" />
                {t('onboarding.github.addAccount')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  handleDisconnect().catch(() => undefined);
                }}
                disabled={disconnecting}
                className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
                title={t('onboarding.github.disconnect')}
              >
                {disconnecting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function GithubAccountAvatar({ account }: { account: GithubAccount }) {
  return account.avatarUrl ? (
    <img src={account.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
  ) : (
    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2">
      <Github className="h-3.5 w-3.5 text-text-secondary" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repo picker — dropdown com busca local
// ---------------------------------------------------------------------------

function RepoPicker({
  accountLogin,
  selectedFullNames,
  onToggle,
}: {
  accountLogin: string;
  selectedFullNames: string[];
  onToggle: (repo: GithubRepoSummary) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selectedSet = useMemo(() => new Set(selectedFullNames), [selectedFullNames]);

  const reposQuery = useQuery({
    queryKey: ['github', 'repos', accountLogin],
    queryFn: () => window.orkestral['github:list-repos']({ accountLogin }),
    staleTime: 60_000,
  });

  const repos = useMemo(() => reposQuery.data ?? [], [reposQuery.data]);
  const needsAccessGrant = !reposQuery.isPending && !reposQuery.isError && repos.length === 0;
  const selected = useMemo(
    () => repos.filter((r) => selectedSet.has(r.fullName)),
    [repos, selectedSet],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return repos;
    const q = query.trim().toLowerCase();
    return repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q),
    );
  }, [repos, query]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-11 w-full items-center gap-2 rounded-lg border border-hairline-med bg-surface-subtle px-3 text-left transition-colors hover:bg-surface-1',
          'focus:outline-none focus:ring-2 focus:ring-hairline-strong',
        )}
      >
        {selected.length > 0 ? (
          <>
            {selected.length === 1 && selected[0].private ? (
              <Lock className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            ) : (
              <Globe className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            )}
            <span className="truncate font-mono text-[12.5px] text-text-primary">
              {selected.length === 1
                ? selected[0].fullName
                : t('onboarding.github.selectedRepos', { count: selected.length })}
            </span>
          </>
        ) : (
          <>
            <Github className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            <span className="truncate text-[12.5px] text-text-muted">
              {reposQuery.isPending
                ? t('onboarding.github.loadingRepos')
                : reposQuery.isError
                  ? t('onboarding.github.listError')
                  : repos.length === 0
                    ? t('onboarding.github.accessNeededShort')
                    : t('onboarding.github.chooseRepo')}
            </span>
          </>
        )}
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
            // Casa com o background do onboarding (#0b0a10). O cinza #1B1C1E
            // padrão ficava destacado e quebrava a estética escura do step.
            style={{ background: '#0b0a10' }}
          >
            <div className="flex items-center gap-2 border-b border-hairline-faint px-3 py-2">
              <Search className="h-3.5 w-3.5 text-text-muted" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('onboarding.github.searchRepo')}
                className="flex-1 bg-transparent text-[12.5px] text-text-primary placeholder:text-text-muted focus:outline-none"
              />
              {reposQuery.isError && (
                <button
                  type="button"
                  onClick={() => reposQuery.refetch()}
                  className="text-[11px] text-accent-blue hover:underline"
                >
                  {t('onboarding.github.retry')}
                </button>
              )}
            </div>
            {needsAccessGrant && (
              <GithubAccessGrantCard
                accountLogin={accountLogin}
                onRetry={() => void reposQuery.refetch()}
              />
            )}
            <div className="max-h-60 overflow-y-auto py-1">
              {needsAccessGrant ? null : filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-[12px] text-text-muted">
                  {reposQuery.isPending
                    ? t('onboarding.github.loading')
                    : t('onboarding.github.empty')}
                </div>
              ) : (
                filtered.map((r) => {
                  const isSel = selectedSet.has(r.fullName);
                  return (
                    <button
                      key={r.fullName}
                      type="button"
                      onClick={() => {
                        onToggle(r);
                      }}
                      className={cn(
                        'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-2',
                        isSel && 'bg-surface-1',
                      )}
                    >
                      {r.private ? (
                        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
                      ) : (
                        <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[12.5px] text-text-primary">
                          {r.fullName}
                        </div>
                        {r.description && (
                          <div className="truncate text-[10.5px] text-text-muted">
                            {r.description}
                          </div>
                        )}
                      </div>
                      {isSel && (
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

function GithubAccessGrantCard({
  accountLogin,
  onRetry,
}: {
  accountLogin: string;
  onRetry: () => void;
}) {
  const { t } = useT();
  const [opening, setOpening] = useState(false);

  async function openGrantAccess(): Promise<void> {
    setOpening(true);
    try {
      await window.orkestral['github:open-access-settings']();
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="border-b border-hairline-faint px-3 py-3">
      <div className="rounded-lg border border-accent-yellow/20 bg-accent-yellow/[0.06] p-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent-yellow/10 text-accent-yellow">
            <Lock className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-text-primary">
              {t('onboarding.github.accessNeededTitle')}
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
              {t('onboarding.github.accessNeededBody', { account: accountLogin })}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void openGrantAccess()}
                disabled={opening}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white px-2.5 text-[12px] font-medium text-black transition-colors hover:bg-white/90 disabled:opacity-60"
              >
                {opening ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="h-3.5 w-3.5" />
                )}
                {t('onboarding.github.grantAccess')}
              </button>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-8 items-center rounded-md px-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
              >
                {t('onboarding.github.retry')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function reposCloneUrl(repo: GithubRepoSummary, fullName?: string | null): string | null {
  if (!fullName || repo.fullName !== fullName) return null;
  return repo.cloneUrl;
}

// ---------------------------------------------------------------------------
// Device Flow Dialog — modal com user_code + polling
// ---------------------------------------------------------------------------

export function DeviceFlowDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConnected: (account: GithubAccount) => void;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const [code, setCode] = useState<GithubDeviceCode | null>(null);
  const [status, setStatus] = useState<
    'idle' | 'starting' | 'waiting' | 'expired' | 'denied' | 'error'
  >('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset ao abrir.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      setStatus('starting');
      setErrorMsg(null);
      setCode(null);
      void (async () => {
        try {
          const c = await window.orkestral['github:start-device-flow']();
          if (cancelled) return;
          setCode(c);
          setStatus('waiting');
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
  }, [open]);

  // Polling enquanto status === 'waiting'.
  useEffect(() => {
    if (!open || status !== 'waiting' || !code) return;
    let cancelled = false;
    let intervalSec = code.interval || 5;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const result: GithubDeviceFlowStatus = await window.orkestral['github:poll-device-flow']({
          deviceCode: code!.deviceCode,
        });
        if (cancelled) return;
        switch (result.status) {
          case 'authorized':
            await qc.invalidateQueries({ queryKey: ['github'] });
            onConnected(result.account);
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

    // Primeiro poll com o interval inicial (sem chamar antes de o user ter chance).
    timer = setTimeout(poll, intervalSec * 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, status, code, qc, onConnected]);

  function openOnGithub() {
    if (!code) return;
    // window.open + setWindowOpenHandler no main = abre no browser externo.
    // Mais confiável que ir via IPC + shell.openExternal direto.
    window.open(code.verificationUri, '_blank');
    // Fallback via IPC caso o handler de window-open não pegue por algum motivo.
    window.orkestral['github:open-verification']({ url: code.verificationUri }).catch(
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

  if (!open) return null;

  // Portal pra document.body — escapa de qualquer stacking context (transform,
  // filter, etc.) criado pelo wizard/motion. Sem isso, mesmo z-index 99999
  // não vence o stacking context do <motion.div> que tem `transform`.
  // -webkit-app-region: no-drag é CRÍTICO no Electron: o StepLayout tem
  // `-webkit-app-region: drag` e isso bloqueia todos os cliques.
  return createPortal(
    <div
      style={
        {
          position: 'fixed',
          inset: 0,
          zIndex: 99999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          WebkitAppRegion: 'no-drag',
        } as CSSProperties
      }
    >
      {/* Backdrop — fecha ao clicar fora */}
      <div
        onClick={() => onOpenChange(false)}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 99999,
          background: 'rgba(0,0,0,0.78)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      />

      {/* Card */}
      <div
        style={
          {
            position: 'relative',
            zIndex: 100000,
            pointerEvents: 'auto',
            width: '100%',
            maxWidth: 420,
            background: '#1B1C1E',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 12,
            padding: 24,
            color: '#E5E5E5',
            boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            WebkitAppRegion: 'no-drag',
          } as CSSProperties
        }
      >
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="absolute right-4 top-4 rounded-md p-1.5 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          title={t('onboarding.github.close')}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2">
            <Github className="h-6 w-6 text-text-primary" />
          </div>
          <div className="text-base font-semibold tracking-tight">
            {t('onboarding.github.dialogTitle')}
          </div>
          <div className="mt-1 text-[12.5px] text-text-secondary">
            {t('onboarding.github.dialogDesc')}
          </div>
        </div>

        <div className="mt-6">
          {status === 'starting' && (
            <div className="flex h-32 items-center justify-center text-text-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('onboarding.github.generatingCode')}
            </div>
          )}

          {status === 'waiting' && code && (
            <div className="flex flex-col gap-4">
              <button
                type="button"
                onClick={copyCode}
                style={{
                  border: copied
                    ? '1px solid rgba(74, 222, 128, 0.4)'
                    : '1px solid rgba(255,255,255,0.08)',
                  background: copied ? 'rgba(74, 222, 128, 0.08)' : 'rgba(255,255,255,0.03)',
                  transition: 'background 160ms, border-color 160ms',
                }}
                className="group cursor-pointer rounded-lg py-5"
                title={copied ? t('onboarding.github.copied') : t('onboarding.github.clickToCopy')}
              >
                <div className="text-center font-mono text-[28px] font-medium tracking-[0.32em] text-text-primary">
                  {code.userCode}
                </div>
                <div
                  className="mt-1 flex items-center justify-center gap-1.5 text-[10.5px] text-text-muted group-hover:text-text-secondary"
                  style={{ color: copied ? '#4ADE80' : undefined }}
                >
                  {copied ? (
                    <>
                      <Check className="h-3 w-3" />
                      {t('onboarding.github.copied')}
                    </>
                  ) : (
                    t('onboarding.github.clickToCopy')
                  )}
                </div>
              </button>
              <button
                type="button"
                onClick={openOnGithub}
                className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-white px-4 text-[13px] font-medium text-black transition-colors hover:bg-white/90"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('onboarding.github.openGithub')}
              </button>
              <div className="flex items-center justify-center gap-2 text-[11px] text-text-muted">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('onboarding.github.waitingAuth')}
              </div>
            </div>
          )}

          {status === 'expired' && (
            <ErrorBlock
              title={t('onboarding.github.expiredTitle')}
              body={t('onboarding.github.expiredBody')}
            />
          )}

          {status === 'denied' && (
            <ErrorBlock
              title={t('onboarding.github.deniedTitle')}
              body={t('onboarding.github.deniedBody')}
            />
          )}

          {status === 'error' && (
            <ErrorBlock
              title={t('onboarding.github.errorTitle')}
              body={errorMsg ?? t('onboarding.github.errorBody')}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ErrorBlock({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-accent-red/30 bg-accent-red/[0.05] px-4 py-3 text-center">
      <div className="text-[12.5px] font-medium text-accent-red">{title}</div>
      <div className="mt-1 text-[11px] text-text-secondary">{body}</div>
    </div>
  );
}
