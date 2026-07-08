// @refresh reset
// ↑ força o React Fast Refresh a remontar este arquivo a cada edição.
// Necessário porque o StepWelcome embute o GalaxyBackground com canvas imperativo.

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Workflow,
  Check,
  LogIn,
  ChevronLeft,
  ChevronDown,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  ScanSearch,
  FileText,
  Bug,
  Layers,
  Zap,
  Shield,
  GitBranch,
  ListChecks,
  Hammer,
  Laptop,
  Github,
  FolderOpen,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Input } from '@renderer/components/ui/input';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { AdapterConfigFields } from '@renderer/components/agents/AdapterConfigFields';
import { ProviderIcon } from '@renderer/components/ProviderIcon';
import { useOnboardingStore } from '@renderer/stores/onboardingStore';
import { useT, type TFunction } from '@renderer/i18n';
import { GalaxyBackground } from './GalaxyBackground';
import { GithubConnect } from './GithubConnect';
import { AzureDevopsConnect, MicrosoftLogoMark } from './AzureDevopsConnect';
import { cn } from '@renderer/lib/utils';
import { AutonomySlider } from '@renderer/components/agents/AutonomySlider';
import { recommendPresetForRamMb } from '@shared/performance-presets';
import type { ReactNode } from 'react';
import type {
  AdapterDescriptor,
  AdapterModel,
  AdapterTestResult,
  OnboardingObjective,
  WorkspaceSourceKind,
} from '@shared/types';
import logoPng from '@renderer/assets/logo_icon.png';

// ============================================================================
// Contrato de navegação que cada step recebe do OnboardingWizard
// ============================================================================
export interface StepNavProps {
  onContinue: () => void;
  onBack: () => void;
  continueLabel: string;
  continueDisabled?: boolean;
  submitting?: boolean;
  onSkip?: () => void;
  skipLabel?: string;
  showBack?: boolean;
}

// ============================================================================
// Classe padronizada de inputs do onboarding
// ============================================================================
const onboardingInputClass =
  'h-11 w-full rounded-lg bg-surface-subtle border border-hairline-med px-3.5 text-[14px] ' +
  'text-text-primary placeholder:text-text-faint ' +
  'hover:border-hairline-vivid hover:bg-surface-3 ' +
  // `!` (important) força override do focus roxo do componente Input base,
  // sem mexer no componente compartilhado.
  'focus-visible:!outline-none focus-visible:!ring-1 focus-visible:!ring-white/20 ' +
  'focus-visible:!border-white/30 transition-colors';

// ============================================================================
// Chassi de step — split-screen padrão Littlebird
// ============================================================================
interface StepLayoutProps extends StepNavProps {
  title: string;
  description?: string;
  children: ReactNode;
  preview: ReactNode;
}

export function StepLayout({
  title,
  description,
  children,
  preview,
  onContinue,
  onBack,
  continueLabel,
  continueDisabled,
  submitting,
  onSkip,
  skipLabel,
  showBack = true,
}: StepLayoutProps) {
  const { t } = useT();
  return (
    <div className="window-drag relative flex h-full w-full overflow-hidden">
      <PreviewPaneBackground />

      <div
        className="relative z-10 flex h-full w-full flex-col md:w-1/2"
        style={{
          background: '#0b0a10',
          borderRight: '1px solid rgba(255,255,255,0.05)',
        }}
      >
        {/* Mask no topo — cobre os ~52px dos traffic lights do macOS. Sem isso
            o conteúdo scrolla por baixo dos botões vermelho/amarelo/verde e
            fica ilegível (placeholder "CEO" aparecendo no topo, etc). */}
        <div
          className="pointer-events-none absolute left-0 right-0 top-0 z-20 h-12"
          style={{
            background: 'linear-gradient(180deg, #0b0a10 70%, rgba(11,10,16,0) 100%)',
          }}
        />

        {/* Área scrollável — título + descrição + conteúdo. Scrollbar sutil
            (thin-scrollbar) na borda direita do painel pra o usuário saber
            que tem mais conteúdo. Wrapper interno `mx-auto max-w-md`
            centraliza horizontalmente dentro do painel esquerdo.
            `window-no-drag` é OBRIGATÓRIO aqui — sem isso, o region herda
            o `window-drag` do container externo e o usuário não consegue
            scrollar/clicar fora dos inputs (vira arrasto de janela). */}
        <div className="window-no-drag thin-scrollbar relative flex-1 overflow-y-auto px-12 pb-6 pt-14">
          <div className="mx-auto w-full max-w-md">
            {showBack && (
              <button
                type="button"
                onClick={onBack}
                disabled={submitting}
                className="window-no-drag mb-8 inline-flex w-fit items-center gap-1 text-[13px] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                {t('common.back')}
              </button>
            )}

            <h1
              className="text-text-primary"
              style={{
                fontFamily: '"Fira Sans", -apple-system, BlinkMacSystemFont, sans-serif',
                fontSize: 'clamp(28px, 2.6vw, 34px)',
                fontWeight: 400,
                lineHeight: 1.15,
                letterSpacing: '-0.02em',
              }}
            >
              {title}
            </h1>
            {description && (
              <p className="mt-3 text-[14px] leading-relaxed text-text-secondary">{description}</p>
            )}
            <div className="window-no-drag mt-8">{children}</div>
          </div>
        </div>

        {/* Footer sticky — Continue + Skip ficam sempre visíveis */}
        <div
          className="window-no-drag relative z-10 px-12 pb-10 pt-3"
          style={{
            background: 'linear-gradient(180deg, rgba(11,10,16,0) 0%, #0b0a10 35%, #0b0a10 100%)',
          }}
        >
          <div className="mx-auto flex w-full max-w-md flex-col gap-2.5">
            <button
              type="button"
              onClick={onContinue}
              disabled={continueDisabled || submitting}
              className={cn(
                'inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[14px] font-medium tracking-wide transition-all duration-200',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
              style={{
                background: 'linear-gradient(180deg, #fafaf7 0%, #e8e6df 100%)',
                color: '#15121c',
                // Sombra neutra (preto puro) — sem mais halo roxo embaixo
                boxShadow:
                  '0 10px 28px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.7)',
              }}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('common.loading')}
                </>
              ) : (
                continueLabel
              )}
            </button>
            {onSkip && (
              <button
                type="button"
                onClick={onSkip}
                disabled={submitting}
                className="mt-1 self-center text-[12.5px] text-text-muted transition-colors hover:text-text-secondary disabled:opacity-50"
              >
                {skipLabel ?? t('onboarding.skipForNow')}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="relative z-10 hidden h-full overflow-hidden md:block md:w-1/2">
        <div className="absolute inset-0 pl-10 pt-14">
          <div className="h-[calc(100%+120px)] w-[125%]">{preview}</div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Background global do painel direito
// ============================================================================
function PreviewPaneBackground() {
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden" style={{ background: '#0b0a10' }}>
      {/* Gradiente neutro topo-direito — só dá uma respiração de luminância,
       * sem matiz roxa, combinando com a paleta cinza do dashboard. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(70% 65% at 85% 15%, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 65%)',
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(40% 50% at 15% 90%, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0) 70%)',
        }}
      />
      {/* Estrelinhas neutras pra manter o vibe "espacial" */}
      <div
        className="absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            'radial-gradient(1px 1px at 68% 18%, rgba(220,222,230,0.5) 50%, transparent 100%),' +
            'radial-gradient(1px 1px at 88% 32%, rgba(220,222,230,0.4) 50%, transparent 100%),' +
            'radial-gradient(1.2px 1.2px at 76% 78%, rgba(220,222,230,0.4) 50%, transparent 100%),' +
            'radial-gradient(0.8px 0.8px at 94% 70%, rgba(255,255,255,0.35) 50%, transparent 100%),' +
            'radial-gradient(0.8px 0.8px at 60% 92%, rgba(255,255,255,0.3) 50%, transparent 100%),' +
            'radial-gradient(1px 1px at 22% 18%, rgba(220,222,230,0.35) 50%, transparent 100%)',
          backgroundRepeat: 'no-repeat',
        }}
      />
    </div>
  );
}

// ============================================================================
// "Janela" de preview
// ============================================================================
function PreviewWindow({
  eyebrow,
  eyebrowDot,
  children,
}: {
  eyebrow: string;
  eyebrowDot?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-hairline-med"
      style={{
        background:
          'linear-gradient(180deg, rgba(255,255,255,0.028) 0%, rgba(255,255,255,0.008) 100%)',
        boxShadow: '0 24px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
      }}
    >
      <div className="flex items-center gap-2 border-b border-hairline-faint px-7 py-5">
        {/* Eyebrow dot — verde do "Contexto ativo" do dashboard pra dar sinal de "ativo" */}
        {eyebrowDot && <span className="h-2 w-2 rounded-full bg-accent-green" />}
        <span className="text-[13px] text-text-secondary">{eyebrow}</span>
      </div>
      <div className="flex-1 px-7 py-7">{children}</div>
    </div>
  );
}

// ============================================================================
// Step 0 — Welcome (galáxia animada + CTA Littlebird)
// ============================================================================
export function StepWelcome({ onStart }: { onStart?: () => void } = {}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const patchUser = useOnboardingStore((s) => s.patchUser);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  // Auto-advance roda 1x por sessão: se o usuário voltar pro welcome, não é
  // reempurrado pra frente (não prende a navegação).
  const didAutoAdvanceRef = useRef(false);

  // Conta do Orkestral Cloud (login feito no web, entregue via loopback/deep link).
  const accountQuery = useQuery({
    queryKey: ['cloud-account'],
    queryFn: () => window.orkestral['cloud:get-account'](),
  });
  const account = accountQuery.data ?? null;

  async function handleLogin() {
    setLoginError(null);
    setLoggingIn(true);
    try {
      const { url } = await window.orkestral['cloud:login-start']();
      // url=null → Cloud não configurado neste build: o navegador nem abre.
      if (!url) {
        setLoginError(t('onboarding.welcome.loginUnavailable'));
        setLoggingIn(false);
      }
    } catch {
      // O deep link reabre o app e dispara onCloudAuthChanged. Se o disparo do
      // browser falhar, mostramos erro; o loading some quando o usuário tentar
      // de novo (ou quando o login completa via deep link).
      setLoginError(t('onboarding.welcome.loginError'));
      setLoggingIn(false);
    }
  }

  const TERMS_URL = 'https://orkestral.ai/terms';
  const PRIVACY_URL = 'https://orkestral.ai/privacy';

  // Quando o login no navegador completa, o loopback/deep link entrega a sessão e
  // o main emite cloud:auth-changed — só atualiza o cache aqui. O efeito abaixo
  // (keyed em `account`) cuida do prefill do nome + avançar (fonte única).
  useEffect(() => {
    return window.orkestralEvents.onCloudAuthChanged(({ account: next }) => {
      queryClient.setQueryData(['cloud-account'], next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Conta Cloud conhecida (login recém-feito OU app reaberto já logado): preenche
  // nome/email no rascunho do onboarding (idempotente; só sobrescreve quando o
  // Cloud tem o valor) e avança do welcome pro próximo step — fluxo estilo 2FA:
  // o web autentica, o desktop reconhece e continua sozinho.
  useEffect(() => {
    if (!account) return;
    patchUser({
      ...(account.name ? { name: account.name } : {}),
      ...(account.email ? { email: account.email } : {}),
    });
    if (!didAutoAdvanceRef.current) {
      didAutoAdvanceRef.current = true;
      onStart?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  // Callback de login chegou sem fluxo ativo (nonce perdido num restart do app):
  // não some em silêncio — para o loading e pede pro usuário clicar em Entrar de
  // novo, em vez de o botão ficar girando pra sempre.
  useEffect(() => {
    if (typeof window.orkestralEvents?.onCloudAuthError !== 'function') return;
    return window.orkestralEvents.onCloudAuthError(() => {
      setLoggingIn(false);
      setLoginError(t('onboarding.welcome.loginRetry'));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <GalaxyBackground />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(80% 60% at 50% 55%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.6) 100%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          // Halo central sutil em branco neutro — não mais roxo
          background:
            'radial-gradient(28% 22% at 50% 44%, rgba(200,205,220,0.08) 0%, rgba(0,0,0,0) 70%)',
        }}
      />
      <div className="relative z-10 flex flex-col items-center text-center px-6">
        <div
          className="mb-3"
          style={{
            // Sombras agora neutras (preto puro + cinza), sem matiz roxa.
            // A logo já tem o roxo no próprio PNG — combina com o "B" do dashboard.
            filter:
              'drop-shadow(0 14px 40px rgba(0,0,0,0.7)) drop-shadow(0 4px 14px rgba(0,0,0,0.55))',
          }}
        >
          <img
            src={logoPng}
            alt="Orkestral"
            width={84}
            height={84}
            draggable={false}
            style={{ display: 'block', userSelect: 'none' }}
          />
        </div>
        <h1
          className="text-text-primary"
          style={{
            fontFamily: '"Fira Sans", -apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: 'clamp(40px, 5vw, 56px)',
            fontWeight: 300,
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
            // Sombra de texto neutra (branco aveludado)
            textShadow: '0 1px 30px rgba(220, 225, 240, 0.18)',
          }}
        >
          {t('onboarding.welcome.greetingPrefix')}{' '}
          <span
            style={{
              fontStyle: 'italic',
              fontWeight: 500,
              color: '#ffffff',
            }}
          >
            Orkestral
          </span>
        </h1>
        <p
          className="mt-5 max-w-md leading-relaxed text-text-secondary"
          style={{
            fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            fontSize: '14px',
          }}
        >
          {t('onboarding.welcome.tagline')}
          <br />
          {t('onboarding.welcome.taglineLine2')}
        </p>
        {account ? (
          <>
            <button
              type="button"
              onClick={onStart}
              className="window-no-drag mt-10 inline-flex items-center justify-center rounded-full px-9 py-3 text-[14px] font-medium tracking-wide text-[#15121c] transition-all duration-200 hover:translate-y-[-1px]"
              style={{
                background: 'linear-gradient(180deg, #fafaf7 0%, #e8e6df 100%)',
                boxShadow:
                  '0 10px 30px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.7)',
              }}
            >
              {t('onboarding.welcome.start')}
            </button>
            <p className="window-no-drag mt-4 text-[12px] text-text-muted">
              {t('onboarding.welcome.connectedAs')}{' '}
              <span className="text-text-secondary">{account.email}</span>
            </p>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void handleLogin()}
              disabled={loggingIn}
              className="window-no-drag mt-10 inline-flex items-center justify-center gap-2 rounded-full px-9 py-3 text-[14px] font-medium tracking-wide text-[#15121c] transition-all duration-200 hover:translate-y-[-1px] disabled:opacity-60"
              style={{
                background: 'linear-gradient(180deg, #fafaf7 0%, #e8e6df 100%)',
                // Sombra neutra — sem mais halo roxo embaixo do botão
                boxShadow:
                  '0 10px 30px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.7)',
              }}
            >
              {loggingIn ? (
                <>
                  <Loader2 size={15} strokeWidth={2} className="animate-spin" />
                  {t('onboarding.welcome.loginStarting')}
                </>
              ) : (
                <>
                  <LogIn size={15} strokeWidth={2} />
                  {t('onboarding.welcome.login')}
                </>
              )}
            </button>
            {loginError && (
              <p className="window-no-drag mt-3 text-[12px] text-accent-red">{loginError}</p>
            )}
            <button
              type="button"
              onClick={onStart}
              className="window-no-drag mt-4 text-[12.5px] text-text-muted underline-offset-4 transition-colors hover:text-text-primary hover:underline"
            >
              {t('onboarding.welcome.skipLogin')}
            </button>
          </>
        )}
      </div>
      <div className="window-no-drag absolute bottom-8 left-1/2 z-10 -translate-x-1/2 text-[11.5px] text-text-muted">
        {t('onboarding.welcome.termsPrefix')}{' '}
        <button
          type="button"
          onClick={() => window.open(TERMS_URL, '_blank')}
          className="underline-offset-2 transition-colors hover:text-text-secondary hover:underline"
        >
          {t('onboarding.welcome.terms')}
        </button>{' '}
        {t('onboarding.welcome.termsConnector')}{' '}
        <button
          type="button"
          onClick={() => window.open(PRIVACY_URL, '_blank')}
          className="underline-offset-2 transition-colors hover:text-text-secondary hover:underline"
        >
          {t('onboarding.welcome.privacy')}
        </button>
        .
      </div>
    </div>
  );
}

// ============================================================================
// Step 1 — Dados pessoais + Company
// ============================================================================
export function StepCompany(props: StepNavProps) {
  const { t } = useT();
  const user = useOnboardingStore((s) => s.user);
  const company = useOnboardingStore((s) => s.company);
  const patchUser = useOnboardingStore((s) => s.patchUser);
  const patchCompany = useOnboardingStore((s) => s.patchCompany);

  // Adiciona uma pasta à lista (permite VÁRIAS). Se a pasta já é um repo git com
  // remote github/azure, registra como repo (aponta pro existente, sem clonar).
  async function addFolder() {
    const r = await window.orkestral['dialog:open-directory']({
      title: t('onboarding.company.pickFolderTitle'),
    });
    if (!r?.path) return;
    const p = r.path;
    const label = p.split('/').filter(Boolean).slice(-1)[0] ?? 'Local folder';
    let kind: WorkspaceSourceKind = 'local_folder';
    let repoFullName: string | null = null;
    try {
      const scan = await window.orkestral['source:scan-folder']({ path: p });
      if (
        scan.rootIsGit &&
        scan.rootRemote &&
        (scan.rootRemote.provider === 'github' || scan.rootRemote.provider === 'azure')
      ) {
        kind = scan.rootRemote.provider === 'github' ? 'github_repo' : 'azure_repo';
        repoFullName = scan.rootRemote.fullName;
      }
    } catch {
      /* sem scan → trata como pasta local */
    }
    const prev = useOnboardingStore.getState().company;
    const sources = [
      ...prev.sources.filter((s) => s.path !== p),
      { kind, label, path: p, repoFullName },
    ];
    patchCompany({
      provider: 'local',
      sources,
      path: sources[0]?.path ?? '',
      name: prev.name.trim() ? prev.name : label,
    });
  }

  function removeFolder(p: string) {
    const prev = useOnboardingStore.getState().company;
    const sources = prev.sources.filter((s) => s.path !== p);
    patchCompany({ sources, path: sources[0]?.path ?? '' });
  }

  return (
    <StepLayout
      {...props}
      title={t('onboarding.company.title')}
      description={t('onboarding.company.description')}
      preview={<CompanyPreview />}
    >
      <div className="flex flex-col gap-5">
        <Field label={t('onboarding.company.yourName')}>
          <Input
            className={onboardingInputClass}
            value={user.name}
            onChange={(e) => patchUser({ name: e.target.value })}
            placeholder={t('onboarding.company.yourNamePlaceholder')}
            autoFocus
          />
        </Field>

        <Field label={t('onboarding.company.workspaceName')}>
          <Input
            className={onboardingInputClass}
            value={company.name}
            onChange={(e) => patchCompany({ name: e.target.value })}
            placeholder={t('onboarding.company.workspaceNamePlaceholder')}
          />
        </Field>

        <Field label={t('onboarding.company.whereLabel')} hint={t('onboarding.company.whereHint')}>
          <div className="grid grid-cols-3 gap-2">
            <ProviderCard
              icon={Laptop}
              label={t('onboarding.company.localFolder')}
              description={t('onboarding.company.localFolderDesc')}
              selected={company.provider === 'local'}
              onSelect={() =>
                patchCompany({
                  provider: 'local',
                  gitRemote: '',
                  githubRepoFullName: '',
                  githubBranch: '',
                  azureRepoFullName: '',
                  azureRepoRemoteUrl: '',
                  // Mantém só as sources com path local (pastas + repos linkados);
                  // descarta seleções remotas (sem path) ao voltar pro local.
                  sources: company.sources.filter((s) => !!s.path),
                })
              }
            />
            <ProviderCard
              icon={Github}
              label={t('onboarding.company.github')}
              description={t('onboarding.company.githubDesc')}
              selected={company.provider === 'github'}
              onSelect={() =>
                patchCompany({
                  provider: 'github',
                  path: '',
                  azureRepoFullName: '',
                  azureRepoRemoteUrl: '',
                  sources: [],
                })
              }
            />
            <ProviderCard
              icon={GitBranch}
              iconNode={<MicrosoftLogoMark className="h-3.5 w-3.5" />}
              label={t('onboarding.company.azure')}
              description={t('onboarding.company.azureDesc')}
              selected={company.provider === 'azure'}
              onSelect={() =>
                patchCompany({
                  provider: 'azure',
                  path: '',
                  gitRemote: '',
                  githubRepoFullName: '',
                  githubBranch: '',
                  sources: [],
                })
              }
            />
          </div>

          {company.provider === 'local' && (
            <div className="mt-2 flex flex-col gap-2">
              {company.sources.map((s) => (
                <div
                  key={s.path ?? s.label}
                  className="flex items-center gap-2.5 rounded-lg border border-hairline-med bg-surface-subtle px-3 py-2.5"
                >
                  {s.kind === 'github_repo' ? (
                    <Github className="h-4 w-4 shrink-0 text-text-secondary" />
                  ) : s.kind === 'azure_repo' ? (
                    <GitBranch className="h-4 w-4 shrink-0 text-text-secondary" />
                  ) : (
                    <FolderOpen className="h-4 w-4 shrink-0 text-accent-yellow" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] text-text-primary">{s.label}</div>
                    <div className="truncate font-mono text-[11px] text-text-muted">
                      {s.repoFullName ?? s.path}
                    </div>
                  </div>
                  {s.kind !== 'local_folder' && (
                    <span className="shrink-0 rounded-full border border-hairline-heavy bg-surface-hover px-1.5 py-0.5 text-[9.5px] text-text-faint">
                      {t('onboarding.company.repoBadge')}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => s.path && removeFolder(s.path)}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-text-faint transition-colors hover:bg-surface-1 hover:text-text-primary"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addFolder}
                className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg border border-dashed border-hairline-med bg-surface-subtle px-3 text-[12.5px] text-text-primary transition-colors hover:bg-surface-1"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {company.sources.length > 0
                  ? t('onboarding.company.addAnotherFolder')
                  : t('onboarding.company.choose')}
              </button>
            </div>
          )}

          {company.provider === 'github' && <GithubConnect />}
          {company.provider === 'azure' && <AzureDevopsConnect />}
        </Field>

        <Field
          label={t('onboarding.company.missionLabel')}
          hint={t('onboarding.company.missionHint')}
        >
          <textarea
            className={cn(onboardingInputClass, 'min-h-[88px] py-3 leading-relaxed')}
            value={company.mission}
            onChange={(e) => patchCompany({ mission: e.target.value })}
            placeholder={t('onboarding.company.missionPlaceholder')}
            rows={3}
          />
        </Field>
      </div>
    </StepLayout>
  );
}

function ProviderCard({
  icon: Icon,
  iconNode,
  label,
  description,
  selected,
  onSelect,
}: {
  icon: LucideIcon;
  iconNode?: ReactNode;
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
        {iconNode ?? <Icon className="h-3.5 w-3.5 text-text-primary" />}
        <span className="text-[12.5px] font-medium text-text-primary">{label}</span>
      </div>
      <span className="text-[10.5px] text-text-muted">{description}</span>
    </button>
  );
}

// ============================================================================
// Skeleton primitives — usados em todos os previews. Variações sutis de
// opacidade pra dar profundidade sem chamar atenção.
// ============================================================================
function SkelLine({
  w = '100%',
  h = 8,
  shade = 0.05,
  rounded = 'full',
  className,
}: {
  w?: string | number;
  h?: number;
  shade?: number;
  rounded?: 'full' | 'md' | 'sm';
  className?: string;
}) {
  return (
    <div
      className={cn(
        rounded === 'full' ? 'rounded-full' : rounded === 'md' ? 'rounded-md' : 'rounded-sm',
        className,
      )}
      style={{
        width: w,
        height: h,
        background: `rgba(255,255,255,${shade})`,
      }}
    />
  );
}

function SkelBlock({
  size = 56,
  rounded = 12,
  className,
}: {
  size?: number;
  rounded?: number;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: rounded,
        background:
          'linear-gradient(160deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)',
        border: '1px solid rgba(255,255,255,0.05)',
      }}
    />
  );
}

function SkelCard({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-hairline bg-surface-veil p-4', className)}>
      {children}
    </div>
  );
}

function SkelChip({ w = 70, shade = 0.05 }: { w?: number; shade?: number }) {
  return (
    <div
      className="rounded-full"
      style={{
        width: w,
        height: 22,
        background: `rgba(255,255,255,${shade})`,
        border: '1px solid rgba(255,255,255,0.04)',
      }}
    />
  );
}

function CompanyPreview() {
  const { t } = useT();
  return (
    <PreviewWindow eyebrowDot eyebrow={t('onboarding.company.previewEyebrow')}>
      {/* Hero: avatar + 2 linhas */}
      <div className="flex items-center gap-5">
        <SkelBlock size={68} rounded={16} />
        <div className="flex flex-1 flex-col gap-2.5">
          <SkelLine w="58%" h={11} shade={0.085} rounded="md" />
          <SkelLine w="38%" h={8} shade={0.05} />
        </div>
      </div>

      {/* Card "missão" */}
      <SkelCard className="mt-6">
        <SkelLine w={70} h={7} shade={0.05} className="mb-3" />
        <div className="flex flex-col gap-2">
          <SkelLine w="92%" h={9} shade={0.06} />
          <SkelLine w="78%" h={9} shade={0.055} />
          <SkelLine w="64%" h={9} shade={0.05} />
        </div>
      </SkelCard>

      {/* Lista estilo "members" — 3 rows com mini avatar + linhas */}
      <div className="mt-6 flex flex-col gap-3.5">
        {[60, 80, 48].map((w, i) => (
          <div key={i} className="flex items-center gap-3">
            <SkelBlock size={28} rounded={8} />
            <div className="flex flex-1 flex-col gap-1.5">
              <SkelLine w={`${w}%`} h={7} shade={0.055} />
              <SkelLine w={`${w * 0.55}%`} h={6} shade={0.04} />
            </div>
            <SkelChip w={48} />
          </div>
        ))}
      </div>
    </PreviewWindow>
  );
}

// ============================================================================
// Step 2 — Agente (name + adapter + model + test)
// ============================================================================

export function StepAgent(props: StepNavProps) {
  const { t } = useT();
  const agent = useOnboardingStore((s) => s.agent);
  const patchAgent = useOnboardingStore((s) => s.patchAgent);
  const applyRecommendedPreset = useOnboardingStore((s) => s.applyRecommendedPreset);

  // RAM total da máquina → recomenda o preset de memória (pré-seleciona o slider
  // sem travar a escolha manual). totalMemMb vem do main (os.totalmem).
  const hardwareQuery = useQuery({
    queryKey: ['system:hardware'],
    queryFn: () => window.orkestral['system:hardware'](),
    staleTime: Infinity,
  });
  const totalMemMb = hardwareQuery.data?.totalMemMb ?? 0;
  // Forge removido: sem slider de variante. O preset de footprint dos modelos locais
  // (fast-apply/embeddings) ainda é auto-aplicado conforme a RAM detectada.
  const recommendedPreset = totalMemMb > 0 ? recommendPresetForRamMb(totalMemMb) : null;
  useEffect(() => {
    if (recommendedPreset) applyRecommendedPreset(recommendedPreset);
  }, [recommendedPreset, applyRecommendedPreset]);

  const [adapters, setAdapters] = useState<AdapterDescriptor[]>([]);
  const [showMore, setShowMore] = useState(false);
  const [models, setModels] = useState<AdapterModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AdapterTestResult | null>(null);

  // Carrega descritores na primeira render
  useEffect(() => {
    window.orkestral['adapter:list']()
      .then((list) => setAdapters(list))
      .catch((err) => console.error('[onboarding] adapter:list falhou', err));
  }, []);

  // Carrega modelos sempre que o ADAPTER mudar (não quando só o model muda — senão
  // trocar de modelo limpava o resultado do teste de ambiente). O model atual é
  // lido fresco do store dentro do .then pra evitar closure stale.
  useEffect(() => {
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      setLoadingModels(true);
      setTestResult(null);
    });
    void window.orkestral['adapter:list-models']({ type: agent.adapterType })
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        // Se o model atual não existe na lista, volta pro default
        const currentModel = useOnboardingStore.getState().agent.model;
        if (!list.find((m) => m.id === currentModel)) {
          patchAgent({ model: list[0]?.id ?? 'default' });
        }
      })
      .catch((err) => {
        console.error('[onboarding] adapter:list-models falhou', err);
        if (!cancelled) setModels([{ id: 'default', label: 'Default' }]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [agent.adapterType, patchAgent]);

  // O agente principal (orquestrador) precisa de poder de planejamento — não
  // pode ser o modelo local Orkestral (executorOnly). Ele entra só nos
  // executores contratados depois.
  const selectable = adapters.filter((a) => !a.executorOnly);
  const recommended = selectable.filter((a) => a.recommended);
  const others = selectable.filter((a) => !a.recommended);
  const selectedAdapter = adapters.find((a) => a.type === agent.adapterType);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.orkestral['adapter:test']({ type: agent.adapterType });
      setTestResult(result);
    } catch (err) {
      setTestResult({
        status: 'fail',
        message: err instanceof Error ? err.message : t('onboarding.agent.adapterListFailed'),
        checks: [],
        durationMs: 0,
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <StepLayout
      {...props}
      title={t('onboarding.agent.title')}
      description={t('onboarding.agent.description')}
      preview={<AgentPreview />}
    >
      <div className="flex flex-col gap-5">
        <Field label={t('onboarding.agent.nameLabel')}>
          <Input
            className={onboardingInputClass}
            value={agent.name}
            onChange={(e) => patchAgent({ name: e.target.value })}
            placeholder="CEO"
            autoFocus
          />
        </Field>

        <Field label={t('onboarding.agent.adapterTypeLabel')}>
          <div className="grid grid-cols-2 gap-2.5">
            {recommended.map((a) => (
              <AdapterCard
                key={a.type}
                adapter={a}
                selected={agent.adapterType === a.type}
                onSelect={() => patchAgent({ adapterType: a.type, adapterConfig: {} })}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            className="mt-2 inline-flex items-center gap-1 text-[12.5px] text-text-secondary transition-colors hover:text-text-primary"
          >
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', showMore && 'rotate-180')}
            />
            {t('onboarding.agent.moreAdapterTypes')}
          </button>

          {showMore && (
            <div className="mt-2 grid grid-cols-2 gap-2.5">
              {others.map((a) => (
                <AdapterCard
                  key={a.type}
                  adapter={a}
                  selected={agent.adapterType === a.type}
                  onSelect={() => patchAgent({ adapterType: a.type, adapterConfig: {} })}
                  small
                />
              ))}
            </div>
          )}
        </Field>

        <Field label={t('onboarding.agent.modelLabel')}>
          <DSSelect
            value={agent.model}
            onChange={(value) => patchAgent({ model: value })}
            options={models.map((m) => ({ value: m.id, label: m.label, hint: m.id }))}
            placeholder={
              loadingModels
                ? t('onboarding.agent.modelPlaceholderLoading')
                : t('onboarding.agent.modelPlaceholder')
            }
            onboarding
          />
        </Field>

        {/* Campos de configuração dinâmicos — mudam quando o provedor muda. */}
        {selectedAdapter?.configSchema && (
          <Field label={t('onboarding.agent.providerConfigLabel')}>
            <AdapterConfigFields
              schema={selectedAdapter.configSchema}
              value={agent.adapterConfig}
              onChange={(adapterConfig) => patchAgent({ adapterConfig })}
              onboarding
            />
          </Field>
        )}

        {/* Autonomia do time — config GLOBAL do workspace (slider auto-contido). */}
        <AutonomySlider
          value={agent.autonomyLevel}
          onChange={(autonomyLevel) => patchAgent({ autonomyLevel })}
        />

        {/* Adapter environment check */}
        <div className="rounded-xl border border-hairline-med bg-surface-faint p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <div className="text-[13px] font-medium text-text-primary">
                {t('onboarding.agent.envCheckTitle')}
              </div>
              <div className="mt-0.5 text-[11.5px] text-text-muted">
                {t('onboarding.agent.envCheckDesc')}
              </div>
            </div>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-hover px-3 text-[12px] font-medium text-text-primary transition-colors hover:bg-surface-active disabled:opacity-50"
            >
              {testing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('onboarding.agent.testing')}
                </>
              ) : (
                <>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('onboarding.agent.testNow')}
                </>
              )}
            </button>
          </div>

          {testResult && (
            <div className="mt-3 flex flex-col gap-2 border-t border-hairline-faint pt-3">
              <div className="flex items-center gap-2 text-[12.5px]">
                <TestStatusIcon status={testResult.status} />
                <span className="text-text-primary">{testResult.message}</span>
              </div>
              {testResult.checks.map((c, i) => (
                <div key={i} className="flex items-start gap-2 text-[11.5px]">
                  <TestStatusIcon status={c.status} small />
                  <div className="flex-1">
                    <div className="text-text-secondary">{c.label}</div>
                    {c.detail && (
                      <div className="mt-0.5 text-[10.5px] leading-snug text-text-muted">
                        {c.detail}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </StepLayout>
  );
}

function AdapterCard({
  adapter,
  selected,
  onSelect,
  small,
}: {
  adapter: AdapterDescriptor;
  selected: boolean;
  onSelect: () => void;
  small?: boolean;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={adapter.comingSoon}
      className={cn(
        'relative flex flex-col items-center justify-center gap-1 rounded-lg border px-2 transition-all',
        small ? 'py-2.5' : 'py-3',
        selected
          ? 'border-white/30 bg-surface-active'
          : 'border-hairline-med bg-surface-faint hover:border-hairline-bright hover:bg-surface-1',
        adapter.comingSoon && 'opacity-50 cursor-not-allowed',
      )}
    >
      {adapter.recommended && (
        <span className="absolute -top-1.5 right-1.5 rounded-full bg-accent-green/90 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-black">
          {t('onboarding.agent.recommended')}
        </span>
      )}
      <ProviderIcon
        provider={adapter.type}
        className={cn('text-text-primary', small ? 'h-3.5 w-3.5' : 'h-4 w-4')}
      />
      <div className={cn('font-medium text-text-primary', small ? 'text-[11.5px]' : 'text-[12px]')}>
        {adapter.name}
      </div>
      <div className="text-[10px] leading-tight text-text-muted">{adapter.description}</div>
    </button>
  );
}

function TestStatusIcon({
  status,
  small,
}: {
  status: AdapterTestResult['status'];
  small?: boolean;
}) {
  const size = small ? 'h-3.5 w-3.5' : 'h-4 w-4';
  if (status === 'pass') return <CheckCircle2 className={cn(size, 'shrink-0 text-accent-green')} />;
  if (status === 'warn')
    return <AlertTriangle className={cn(size, 'shrink-0 text-accent-yellow')} />;
  return <XCircle className={cn(size, 'shrink-0 text-accent-red')} />;
}

function AgentPreview() {
  const { t } = useT();
  return (
    <PreviewWindow eyebrowDot eyebrow={t('onboarding.agent.previewEyebrow')}>
      {/* Hero: avatar + 2 linhas + chip (model) */}
      <div className="flex items-center gap-5">
        <SkelBlock size={68} rounded={16} />
        <div className="flex flex-1 flex-col gap-2.5">
          <SkelLine w="48%" h={11} shade={0.085} rounded="md" />
          <div className="flex items-center gap-2">
            <SkelChip w={64} />
            <SkelChip w={48} shade={0.04} />
          </div>
        </div>
      </div>

      {/* Card "capacidades" — toggles + linhas */}
      <SkelCard className="mt-6">
        <SkelLine w={80} h={7} shade={0.05} className="mb-3" />
        <div className="flex flex-col gap-3">
          {[
            { w: 68, on: true },
            { w: 54, on: true },
            { w: 72, on: true },
            { w: 60, on: false },
          ].map((row, i) => (
            <div key={i} className="flex items-center gap-3">
              {/* "toggle" pill */}
              <div
                className="flex h-4 w-7 items-center rounded-full px-0.5"
                style={{
                  background: row.on ? 'rgba(34,197,94,0.18)' : 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.04)',
                }}
              >
                <span
                  className="h-3 w-3 rounded-full"
                  style={{
                    background: row.on ? 'rgba(34,197,94,0.7)' : 'rgba(255,255,255,0.18)',
                    marginLeft: row.on ? 'auto' : 0,
                  }}
                />
              </div>
              <SkelLine w={`${row.w}%`} h={8} shade={row.on ? 0.06 : 0.035} />
            </div>
          ))}
        </div>
      </SkelCard>

      {/* "Mensagens" — 3 bolhas alternadas (agent/user) */}
      <div className="mt-6 flex flex-col gap-2.5">
        <div
          className="ml-0 max-w-[80%] rounded-2xl rounded-bl-md p-3"
          style={{
            background: 'rgba(255,255,255,0.025)',
            border: '1px solid rgba(255,255,255,0.04)',
          }}
        >
          <div className="flex flex-col gap-2">
            <SkelLine w="70%" h={7} shade={0.07} />
            <SkelLine w="55%" h={7} shade={0.06} />
          </div>
        </div>
        <div
          className="ml-auto max-w-[60%] rounded-2xl rounded-br-md p-3"
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          <SkelLine w="80%" h={7} shade={0.08} />
        </div>
      </div>
    </PreviewWindow>
  );
}

// ============================================================================
// Step 3 — Tarefas (objetivos)
// ============================================================================

interface TaskOption {
  id: OnboardingObjective;
  label: string;
  description: string;
  icon: LucideIcon;
}

function buildTaskOptions(t: TFunction): TaskOption[] {
  return [
    {
      id: 'code-review',
      label: t('onboarding.tasks.codeReview'),
      description: t('onboarding.tasks.codeReviewDesc'),
      icon: ScanSearch,
    },
    {
      id: 'code-build',
      label: t('onboarding.tasks.codeBuild'),
      description: t('onboarding.tasks.codeBuildDesc'),
      icon: Hammer,
    },
    {
      id: 'bugfix',
      label: t('onboarding.tasks.bugfix'),
      description: t('onboarding.tasks.bugfixDesc'),
      icon: Bug,
    },
    {
      id: 'architecture',
      label: t('onboarding.tasks.architecture'),
      description: t('onboarding.tasks.architectureDesc'),
      icon: Layers,
    },
    {
      id: 'refactor',
      label: t('onboarding.tasks.refactor'),
      description: t('onboarding.tasks.refactorDesc'),
      icon: GitBranch,
    },
    {
      id: 'performance',
      label: t('onboarding.tasks.performance'),
      description: t('onboarding.tasks.performanceDesc'),
      icon: Zap,
    },
    {
      id: 'docs',
      label: t('onboarding.tasks.docs'),
      description: t('onboarding.tasks.docsDesc'),
      icon: FileText,
    },
    {
      id: 'tests',
      label: t('onboarding.tasks.tests'),
      description: t('onboarding.tasks.testsDesc'),
      icon: ListChecks,
    },
    {
      id: 'security',
      label: t('onboarding.tasks.security'),
      description: t('onboarding.tasks.securityDesc'),
      icon: Shield,
    },
    {
      id: 'ci-cd',
      label: t('onboarding.tasks.cicd'),
      description: t('onboarding.tasks.cicdDesc'),
      icon: Workflow,
    },
  ];
}

export function StepTasks(props: StepNavProps) {
  const { t } = useT();
  const objectives = useOnboardingStore((s) => s.objectives);
  const toggle = useOnboardingStore((s) => s.toggleObjective);
  const setObjectives = useOnboardingStore((s) => s.setObjectives);
  const TASK_OPTIONS = buildTaskOptions(t);
  const allIds = TASK_OPTIONS.map((o) => o.id);
  const allSelected = allIds.every((id) => objectives.includes(id));

  return (
    <StepLayout
      {...props}
      title={t('onboarding.tasks.title')}
      description={t('onboarding.tasks.description')}
      preview={<TasksPreview />}
    >
      <div className="mb-2.5 flex items-center justify-end">
        <button
          type="button"
          onClick={() => setObjectives(allSelected ? [] : allIds)}
          className="text-[11.5px] font-medium text-text-secondary transition-colors hover:text-text-primary"
        >
          {allSelected ? t('onboarding.tasks.deselectAll') : t('onboarding.tasks.selectAll')}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {TASK_OPTIONS.map((t) => {
          const Icon = t.icon;
          const selected = objectives.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => toggle(t.id)}
              className={cn(
                'flex items-start gap-2.5 rounded-xl border px-3 py-3 text-left transition-all',
                selected
                  ? 'border-white/30 bg-surface-active'
                  : 'border-hairline-med bg-surface-faint hover:border-hairline-bright hover:bg-surface-1',
              )}
            >
              <Icon
                className={cn(
                  'mt-0.5 h-4 w-4 shrink-0',
                  selected ? 'text-text-primary' : 'text-text-secondary',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium text-text-primary">{t.label}</div>
                <div className="text-[10.5px] leading-tight text-text-muted">{t.description}</div>
              </div>
              {selected && <Check className="h-3.5 w-3.5 shrink-0 text-text-primary" />}
            </button>
          );
        })}
      </div>
    </StepLayout>
  );
}

function TasksPreview() {
  const { t } = useT();
  return (
    <PreviewWindow eyebrowDot eyebrow={t('onboarding.tasks.previewEyebrow')}>
      {/* Header com título + botão "novo" */}
      <div className="mb-5 flex items-center justify-between">
        <SkelLine w={140} h={11} shade={0.085} rounded="md" />
        <SkelChip w={72} shade={0.06} />
      </div>

      {/* Grid 2x3 de widgets — cada um com mini avatar + 2 linhas */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { line1: 70, line2: 45 },
          { line1: 55, line2: 35 },
          { line1: 80, line2: 50 },
          { line1: 48, line2: 38 },
          { line1: 65, line2: 42 },
          { line1: 58, line2: 30 },
        ].map((row, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-xl border border-hairline bg-surface-faint p-3"
          >
            <SkelBlock size={36} rounded={10} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <SkelLine w={`${row.line1}%`} h={8} shade={0.07} />
              <SkelLine w={`${row.line2}%`} h={6} shade={0.04} />
            </div>
          </div>
        ))}
      </div>

      {/* Lista "recentes" embaixo */}
      <div className="mt-6 flex flex-col gap-2.5">
        <SkelLine w={90} h={7} shade={0.045} className="mb-1" />
        {[78, 64, 52].map((w, i) => (
          <div key={i} className="flex items-center gap-3">
            <SkelLine w={6} h={6} shade={0.05} />
            <SkelLine w={`${w}%`} h={7} shade={0.055} />
          </div>
        ))}
      </div>
    </PreviewWindow>
  );
}

// ============================================================================
// Step 4 — Plano (Free Local vs Team Cloud)
// ============================================================================

export function StepPlan(props: StepNavProps) {
  const { t } = useT();
  const plan = useOnboardingStore((s) => s.plan);
  const setPlan = useOnboardingStore((s) => s.setPlan);
  const runInitialHiringPlan = useOnboardingStore((s) => s.runInitialHiringPlan);

  return (
    <StepLayout
      {...props}
      title={t('onboarding.plan.title')}
      description={t('onboarding.plan.description')}
      preview={<PlanPreview />}
    >
      <div className="flex flex-col gap-3">
        <PlanCard
          selected={plan === 'free-local'}
          onSelect={() => setPlan('free-local')}
          title={t('onboarding.plan.freeLocalTitle')}
          price={t('onboarding.plan.freeLocalPrice')}
          description={t('onboarding.plan.freeLocalDesc')}
          features={[
            t('onboarding.plan.freeLocalFeature1'),
            t('onboarding.plan.freeLocalFeature2'),
            t('onboarding.plan.freeLocalFeature3'),
            t('onboarding.plan.freeLocalFeature4'),
          ]}
        />
        <PlanCard
          selected={plan === 'team-cloud'}
          onSelect={() => setPlan('team-cloud')}
          title={t('onboarding.plan.teamCloudTitle')}
          price={t('onboarding.plan.teamCloudPrice')}
          description={t('onboarding.plan.teamCloudDesc')}
          features={[
            t('onboarding.plan.teamCloudFeature1'),
            t('onboarding.plan.teamCloudFeature2'),
            t('onboarding.plan.teamCloudFeature3'),
            t('onboarding.plan.teamCloudFeature4'),
          ]}
          comingSoon
        />
        <label className="mt-2 flex cursor-pointer items-start gap-2.5 rounded-xl border border-hairline-strong bg-surface-faint px-3.5 py-3 text-left transition-colors hover:border-hairline-bright">
          <input
            type="checkbox"
            checked={runInitialHiringPlan}
            onChange={(e) =>
              useOnboardingStore.setState({ runInitialHiringPlan: e.currentTarget.checked })
            }
            className="mt-[1px] h-4 w-4 rounded border-white/20 bg-white/10"
          />
          <div>
            <div className="text-[13px] font-medium text-text-primary">
              {t('onboarding.plan.runInitialHiringTitle')}
            </div>
            <div className="mt-0.5 text-[11.5px] text-text-muted">
              {t('onboarding.plan.runInitialHiringDesc')}
            </div>
          </div>
        </label>
      </div>
    </StepLayout>
  );
}

function PlanCard({
  selected,
  onSelect,
  title,
  price,
  description,
  features,
  comingSoon,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  price: string;
  description: string;
  features: string[];
  comingSoon?: boolean;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={comingSoon}
      className={cn(
        'flex flex-col gap-3 rounded-xl border px-4 py-4 text-left transition-all',
        comingSoon
          ? 'cursor-not-allowed border-hairline-faint bg-surface-veil opacity-55'
          : selected
            ? 'border-white/30 bg-surface-active'
            : 'border-hairline-med bg-surface-faint hover:border-hairline-bright hover:bg-surface-1',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14.5px] font-medium text-text-primary">{title}</span>
            {comingSoon && (
              <span className="rounded-full bg-accent-yellow/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent-yellow">
                {t('onboarding.plan.comingSoon')}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11.5px] text-text-muted">{description}</div>
        </div>
        <div className="text-[12.5px] font-medium text-text-primary">{price}</div>
      </div>
      <div className="flex flex-col gap-1.5">
        {features.map((f) => (
          <div key={f} className="flex items-center gap-2 text-[11.5px] text-text-secondary">
            <Check className="h-3 w-3 shrink-0 text-accent-green" />
            {f}
          </div>
        ))}
      </div>
    </button>
  );
}

function PlanPreview() {
  const { t } = useT();
  return (
    <PreviewWindow eyebrowDot eyebrow={t('onboarding.plan.previewEyebrow')}>
      {/* Hero: avatar + 2 linhas (título + preço chip) */}
      <div className="flex items-center gap-5">
        <SkelBlock size={68} rounded={16} />
        <div className="flex flex-1 flex-col gap-2.5">
          <SkelLine w="42%" h={11} shade={0.085} rounded="md" />
          <div className="flex items-center gap-2">
            <SkelChip w={80} />
          </div>
        </div>
      </div>

      {/* Card de features — linhas com check */}
      <SkelCard className="mt-6">
        <SkelLine w={90} h={7} shade={0.05} className="mb-3" />
        <div className="flex flex-col gap-2.5">
          {[78, 64, 82, 56, 70].map((w, i) => (
            <div key={i} className="flex items-center gap-3">
              <div
                className="h-3 w-3 shrink-0 rounded-full"
                style={{
                  background: 'rgba(34,197,94,0.18)',
                  border: '1px solid rgba(34,197,94,0.25)',
                }}
              />
              <SkelLine w={`${w}%`} h={7} shade={0.055} />
            </div>
          ))}
        </div>
      </SkelCard>

      {/* "Botão" CTA grande no fundo do card */}
      <div className="mt-6">
        <div
          className="h-10 w-[55%] rounded-lg"
          style={{
            background:
              'linear-gradient(180deg, rgba(255,255,255,0.075) 0%, rgba(255,255,255,0.035) 100%)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        />
      </div>
    </PreviewWindow>
  );
}

// ============================================================================
// Helpers
// ============================================================================
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-medium text-text-primary">{label}</label>
      {children}
      {hint && <div className="text-[11px] text-text-muted">{hint}</div>}
    </div>
  );
}
