import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  LogOut,
  Plug,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog';
import { IntegrationCardShell } from '@renderer/components/integrations/IntegrationCardShell';
import { useT } from '@renderer/i18n';
import type { ChannelAccountSnapshot, ChannelStatus, ChannelType } from '@shared/types';

const GRID_COLS = { gridTemplateColumns: 'repeat(auto-fill, minmax(258px, 1fr))' };

/** Mesmo visual do DSSelect/inputs do app (tokens --color-input-*), pra tudo casar. */
const INPUT_CLS =
  'w-full rounded-md border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-3 py-2 text-[13px] text-text-primary placeholder:text-text-faint transition-colors focus:border-accent-purple/50 focus:outline-none';

/** Marcas (proper nouns) + path SVG (simple-icons) pra logo colorida. */
interface Brand {
  key: string;
  name: string;
  /** Cor da logo monocromática. */
  color: string;
  /** Path único (logo monocromática). */
  path?: string;
  /** Logo multicolor (ex.: Slack) — sobrepõe `path`. */
  paths?: { d: string; color: string }[];
  /** viewBox custom (default 0 0 24 24). */
  viewBox?: string;
}

const WHATSAPP: Brand = {
  key: 'whatsapp',
  name: 'WhatsApp',
  color: '#25D366',
  path: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z',
};

const TELEGRAM: Brand = {
  key: 'telegram',
  name: 'Telegram',
  color: '#26A5E4',
  path: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
};

const DISCORD: Brand = {
  key: 'discord',
  name: 'Discord',
  color: '#5865F2',
  path: 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z',
};

const TEAMS: Brand = {
  key: 'msteams',
  name: 'Microsoft Teams',
  color: '#6264A7',
  path: 'M20.625 8.127q-.55 0-1.025-.205-.475-.205-.832-.563-.358-.357-.563-.832Q18 6.053 18 5.502q0-.54.205-1.02t.563-.837q.357-.358.832-.563.474-.205 1.025-.205.54 0 1.02.205t.837.563q.358.357.563.837.205.48.205 1.02 0 .55-.205 1.025-.205.475-.563.832-.357.358-.837.563-.48.205-1.02.205zm0-3.75q-.469 0-.797.328-.328.328-.328.797 0 .469.328.797.328.328.797.328.469 0 .797-.328.328-.328.328-.797 0-.469-.328-.797-.328-.328-.797-.328zM24 10.002v5.578q0 .774-.293 1.46-.293.685-.803 1.194-.51.51-1.195.803-.686.293-1.459.293-.445 0-.908-.105-.463-.106-.85-.329-.293.95-.855 1.729-.563.78-1.319 1.336-.756.557-1.67.861-.914.305-1.898.305-1.148 0-2.162-.398-1.014-.399-1.805-1.102-.79-.703-1.312-1.664t-.674-2.086h-5.8q-.411 0-.704-.293T0 16.881V6.873q0-.41.293-.703t.703-.293h8.59q-.34-.715-.34-1.5 0-.727.275-1.365.276-.639.75-1.114.475-.474 1.114-.75.638-.275 1.365-.275t1.365.275q.639.276 1.114.75.474.475.75 1.114.275.638.275 1.365t-.275 1.365q-.276.639-.75 1.113-.475.475-1.114.75-.638.276-1.365.276-.188 0-.375-.024-.188-.023-.375-.058v1.078h10.875q.469 0 .797.328.328.328.328.797zM12.75 2.373q-.41 0-.78.158-.368.158-.638.434-.27.275-.428.639-.158.363-.158.773 0 .41.158.78.159.368.428.638.27.27.639.428.369.158.779.158.41 0 .773-.158.364-.159.64-.428.274-.27.433-.639.158-.369.158-.779 0-.41-.158-.773-.159-.364-.434-.64-.275-.275-.639-.433-.363-.158-.773-.158zM6.937 9.814h2.25V7.94H2.814v1.875h2.25v6h1.875zm10.313 7.313v-6.75H12v6.504q0 .41-.293.703t-.703.293H8.309q.152.809.556 1.5.405.691.985 1.19.58.497 1.318.779.738.281 1.582.281.926 0 1.746-.352.82-.351 1.436-.966.615-.616.966-1.43.352-.815.352-1.752zm5.25-1.547v-5.203h-3.75v6.855q.305.305.691.452.387.146.809.146.469 0 .879-.176.41-.175.715-.48.304-.305.48-.715t.176-.879Z',
};

const SIGNAL: Brand = {
  key: 'signal',
  name: 'Signal',
  color: '#3A76F0',
  path: 'M12 0q-.934 0-1.83.139l.17 1.111a11 11 0 0 1 3.32 0l.172-1.111A12 12 0 0 0 12 0M9.152.34A12 12 0 0 0 5.77 1.742l.584.961a10.8 10.8 0 0 1 3.066-1.27zm5.696 0-.268 1.094a10.8 10.8 0 0 1 3.066 1.27l.584-.962A12 12 0 0 0 14.848.34M12 2.25a9.75 9.75 0 0 0-8.539 14.459c.074.134.1.292.064.441l-1.013 4.338 4.338-1.013a.62.62 0 0 1 .441.064A9.7 9.7 0 0 0 12 21.75c5.385 0 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25m-7.092.068a12 12 0 0 0-2.59 2.59l.909.664a11 11 0 0 1 2.345-2.345zm14.184 0-.664.909a11 11 0 0 1 2.345 2.345l.909-.664a12 12 0 0 0-2.59-2.59M1.742 5.77A12 12 0 0 0 .34 9.152l1.094.268a10.8 10.8 0 0 1 1.269-3.066zm20.516 0-.961.584a10.8 10.8 0 0 1 1.27 3.066l1.093-.268a12 12 0 0 0-1.402-3.383M.138 10.168A12 12 0 0 0 0 12q0 .934.139 1.83l1.111-.17A11 11 0 0 1 1.125 12q0-.848.125-1.66zm23.723.002-1.111.17q.125.812.125 1.66c0 .848-.042 1.12-.125 1.66l1.111.172a12.1 12.1 0 0 0 0-3.662M1.434 14.58l-1.094.268a12 12 0 0 0 .96 2.591l-.265 1.14 1.096.255.36-1.539-.188-.365a10.8 10.8 0 0 1-.87-2.35m21.133 0a10.8 10.8 0 0 1-1.27 3.067l.962.584a12 12 0 0 0 1.402-3.383zm-1.793 3.848a11 11 0 0 1-2.345 2.345l.664.909a12 12 0 0 0 2.59-2.59zm-19.959 1.1L.357 21.48a1.8 1.8 0 0 0 2.162 2.161l1.954-.455-.256-1.095-1.953.455a.675.675 0 0 1-.81-.81l.454-1.954zm16.832 1.769a10.8 10.8 0 0 1-3.066 1.27l.268 1.093a12 12 0 0 0 3.382-1.402zm-10.94.213-1.54.36.256 1.095 1.139-.266c.814.415 1.683.74 2.591.961l.268-1.094a10.8 10.8 0 0 1-2.35-.869zm3.634 1.24-.172 1.111a12.1 12.1 0 0 0 3.662 0l-.17-1.111q-.812.125-1.66.125a11 11 0 0 1-1.66-.125',
};

const COMING_SOON: Brand[] = [
  {
    key: 'slack',
    name: 'Slack',
    color: '#E01E5A',
    viewBox: '0 0 122.8 122.8',
    paths: [
      {
        color: '#E01E5A',
        d: 'M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z',
      },
      {
        color: '#36C5F0',
        d: 'M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z',
      },
      {
        color: '#2EB67D',
        d: 'M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z',
      },
      {
        color: '#ECB22E',
        d: 'M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z',
      },
    ],
  },
  {
    key: 'googlechat',
    name: 'Google Chat',
    color: '#00AC47',
    path: 'M1.637 0C.733 0 0 .733 0 1.637v16.5c0 .904.733 1.636 1.637 1.636h3.955v3.323c0 .804.97 1.207 1.539.638l3.963-3.96h11.27c.903 0 1.636-.733 1.636-1.637V5.592L18.408 0Zm3.955 5.592h12.816v8.59H8.455l-2.863 2.863Z',
  },
  {
    key: 'imessage',
    name: 'iMessage',
    color: '#34DA50',
    path: 'M5.285 0A5.273 5.273 0 0 0 0 5.285v13.43A5.273 5.273 0 0 0 5.285 24h13.43A5.273 5.273 0 0 0 24 18.715V5.285A5.273 5.273 0 0 0 18.715 0ZM12 4.154a8.809 7.337 0 0 1 8.809 7.338A8.809 7.337 0 0 1 12 18.828a8.809 7.337 0 0 1-2.492-.303A8.656 7.337 0 0 1 5.93 19.93a9.929 7.337 0 0 0 1.54-2.155 8.809 7.337 0 0 1-4.279-6.283A8.809 7.337 0 0 1 12 4.154',
  },
];

/** SVG da logo (mono ou multicolor). Usado no card, no título e no modal. */
function BrandSvg({ brand, className }: { brand: Brand; className?: string }) {
  return (
    <svg viewBox={brand.viewBox ?? '0 0 24 24'} className={className} aria-hidden>
      {brand.paths ? (
        brand.paths.map((p, i) => <path key={i} d={p.d} fill={p.color} />)
      ) : (
        <path d={brand.path} fill={brand.color} />
      )}
    </svg>
  );
}

/** Componente de ícone (assinatura LucideIcon) pro IntegrationCardShell. */
function brandIcon(brand: Brand): LucideIcon {
  const Icon = ({ className }: { className?: string }) => (
    <BrandSvg brand={brand} className={className} />
  );
  return Icon as unknown as LucideIcon;
}

const STATUS_TONE: Record<ChannelStatus, string> = {
  disconnected: 'bg-surface-strong text-text-muted',
  connecting: 'bg-accent-yellow/15 text-accent-yellow',
  qr: 'bg-accent-blue/15 text-accent-blue',
  connected: 'bg-accent-green/15 text-accent-green',
};

/** Canais já implementados (com modal de conexão). */
const ACTIVE: Brand[] = [WHATSAPP, TELEGRAM, DISCORD, TEAMS, SIGNAL];
const isActiveChannel = (key: string): key is ChannelType =>
  key === 'whatsapp' ||
  key === 'telegram' ||
  key === 'discord' ||
  key === 'msteams' ||
  key === 'signal';

export function ChannelsPage() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [modalChannel, setModalChannel] = useState<ChannelType | null>(null);

  const channelsQuery = useQuery({
    queryKey: ['channels'],
    queryFn: () => window.orkestral['channels:list'](),
  });
  const accountByType = useMemo(() => {
    const m = new Map<ChannelType, ChannelAccountSnapshot>();
    for (const a of channelsQuery.data ?? []) m.set(a.channelType, a);
    return m;
  }, [channelsQuery.data]);

  // Atualiza em tempo real (QR/conexão/queda). Guarda defensiva: em dev o preload
  // pode estar defasado (só recarrega no restart completo, não no Cmd+R).
  useEffect(() => {
    if (typeof window.orkestralEvents?.onChannelAccountUpdated !== 'function') return;
    return window.orkestralEvents.onChannelAccountUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
    });
  }, [queryClient]);

  const allBrands = useMemo(() => [...ACTIVE, ...COMING_SOON], []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allBrands;
    return allBrands.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        t(`pages.channels.desc.${b.key}`).toLowerCase().includes(q),
    );
  }, [allBrands, query, t]);

  const modalBrand = modalChannel ? (ACTIVE.find((b) => b.key === modalChannel) ?? null) : null;

  if (!activeWorkspace) {
    return (
      <PageShell>
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('pages.channels.noActiveWorkspace')}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="window-drag flex items-end justify-between border-b border-hairline-soft px-8 pt-5">
        <div className="pb-3">
          <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">
            {t('pages.channels.title')}
          </h1>
          <p className="mt-0.5 text-[12.5px] text-text-muted">{t('pages.channels.subtitle')}</p>
        </div>
      </div>

      {/* Busca */}
      <div className="shrink-0 border-b border-hairline-faint px-6 py-3.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('pages.channels.searchPlaceholder')}
            className="h-10 w-full rounded-lg border border-hairline-strong bg-surface-subtle pl-10 pr-9 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
          />
        </div>
      </div>

      {/* Grid de cards */}
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="text-[13px] text-text-secondary">
              {t('pages.channels.nothingFound')}
            </div>
            <div className="mt-1 text-[12px] text-text-muted">
              {t('pages.channels.tryAnotherTerm')}
            </div>
          </div>
        ) : (
          <div className="grid gap-3" style={GRID_COLS}>
            {filtered.map((brand) => {
              if (isActiveChannel(brand.key)) {
                const st: ChannelStatus = accountByType.get(brand.key)?.status ?? 'disconnected';
                return (
                  <IntegrationCardShell
                    key={brand.key}
                    icon={brandIcon(brand)}
                    name={brand.name}
                    description={t(`pages.channels.desc.${brand.key}`)}
                    category={t('pages.channels.category')}
                    badge={
                      st !== 'disconnected' ? (
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[9.5px] font-medium',
                            STATUS_TONE[st],
                          )}
                        >
                          {t(`pages.channels.status.${st}`)}
                        </span>
                      ) : undefined
                    }
                    action={
                      <button
                        type="button"
                        onClick={() => setModalChannel(brand.key as ChannelType)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-hairline-heavy bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-hairline-bright hover:bg-surface-3 hover:text-text-primary"
                      >
                        <Plug className="h-3 w-3" />
                        {st === 'connected'
                          ? t('pages.channels.manage')
                          : t('pages.channels.connect')}
                      </button>
                    }
                  />
                );
              }
              return (
                <IntegrationCardShell
                  key={brand.key}
                  icon={brandIcon(brand)}
                  name={brand.name}
                  description={t(`pages.channels.desc.${brand.key}`)}
                  category={t('pages.channels.category')}
                  muted
                  action={
                    <span className="rounded-md border border-hairline-strong px-2 py-1 text-[11px] text-text-faint">
                      {t('pages.channels.comingSoon')}
                    </span>
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      {modalBrand && (
        <ChannelModal
          brand={modalBrand}
          open={modalChannel !== null}
          onOpenChange={(v) => {
            if (!v) setModalChannel(null);
          }}
          account={accountByType.get(modalBrand.key as ChannelType) ?? null}
          workspaceId={activeWorkspace.id}
        />
      )}
    </PageShell>
  );
}

function ChannelModal({
  brand,
  open,
  onOpenChange,
  account,
  workspaceId,
}: {
  brand: Brand;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  account: ChannelAccountSnapshot | null;
  workspaceId: string;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const channelType = brand.key as ChannelType;
  const isDiscord = channelType === 'discord';
  const isTelegram = channelType === 'telegram';
  const isTeams = channelType === 'msteams';
  const isSignal = channelType === 'signal';
  const [busy, setBusy] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [numberDraft, setNumberDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  // Credenciais do Teams (do registro no Azure Bot Service).
  const [appIdDraft, setAppIdDraft] = useState('');
  const [appPasswordDraft, setAppPasswordDraft] = useState('');
  const [tenantIdDraft, setTenantIdDraft] = useState('');
  const [portDraft, setPortDraft] = useState('');
  // Criação automática do app via CLI da Microsoft.
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<{
    tone: 'ok' | 'error' | 'info';
    text: string;
  } | null>(null);
  // Código de device login (mostrado quando precisa autenticar).
  const [deviceCode, setDeviceCode] = useState<{ code: string; url: string } | null>(null);
  // Accordion das credenciais manuais (recolhido por padrão).
  const [manualOpen, setManualOpen] = useState(false);

  const agentsQuery = useQuery({
    queryKey: ['agents', account?.workspaceId ?? workspaceId],
    enabled: open,
    queryFn: () =>
      window.orkestral['agent:list']({ workspaceId: account?.workspaceId ?? workspaceId }),
  });
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);

  const [draftAgentId, setDraftAgentId] = useState('');
  const [allowlist, setAllowlist] = useState<string[]>([]);

  // Hidrata o draft a partir da conta sempre que o modal abre / a conta muda.
  useEffect(() => {
    if (!open) return;
    setDraftAgentId(account?.agentId ?? '');
    setAllowlist(account?.allowlist ?? []);
    setTokenDraft('');
    setAppIdDraft('');
    setAppPasswordDraft('');
    setTenantIdDraft('');
    setPortDraft('');
    setCreateMsg(null);
    setDeviceCode(null);
    setManualOpen(false);
  }, [open, account?.id, account?.agentId, account?.allowlist]);

  // Código de device login emitido pelo main durante o "Criar app" → mostra a caixa.
  useEffect(() => {
    if (!open || !isTeams) return;
    if (typeof window.orkestralEvents?.onTeamsLoginCode !== 'function') return;
    return window.orkestralEvents.onTeamsLoginCode((dc) => {
      setDeviceCode(dc);
      setCreateMsg(null);
    });
  }, [open, isTeams]);

  const agentId = draftAgentId || agents.find((a) => a.isOrchestrator)?.id || agents[0]?.id || '';
  const agentOptions = agents.map((a) => ({ value: a.id, label: a.title || a.name, hint: a.role }));

  const status: ChannelStatus = account?.status ?? 'disconnected';
  const connected = status === 'connected';
  const showQr = status === 'qr' && !!account?.qrDataUrl;
  // Discord conecta com token; Teams com appId+appPassword+tenantId (salvos ou
  // digitados agora). WhatsApp não precisa de credencial (pareamento por QR).
  const teamsCredsReady =
    !!account?.hasToken ||
    (!!appIdDraft.trim() && !!appPasswordDraft.trim() && !!tenantIdDraft.trim());
  const tokenReady =
    isDiscord || isTelegram
      ? !!tokenDraft.trim() || !!account?.hasToken
      : isTeams
        ? teamsCredsReady
        : true;

  // Patch de credenciais do Teams a partir dos drafts (vazio = não sobrescreve).
  const teamsPatch = ():
    | { appId?: string; appPassword?: string; tenantId?: string; port?: number }
    | undefined => {
    if (!isTeams) return undefined;
    const port = Number.parseInt(portDraft.trim(), 10);
    return {
      appId: appIdDraft.trim() || undefined,
      appPassword: appPasswordDraft.trim() || undefined,
      tenantId: tenantIdDraft.trim() || undefined,
      port: Number.isFinite(port) && port > 0 ? port : undefined,
    };
  };

  async function ensureAccountId(): Promise<string> {
    if (account) return account.id;
    const created = await window.orkestral['channels:create']({
      channelType,
      workspaceId,
      agentId,
    });
    return created.id;
  }

  async function run(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setUiError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
    } catch (err) {
      setUiError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Persiste agente + allowlist (+ token do Discord) na hora.
  const saveConfig = (nextAgentId: string, list: string[], token?: string): void => {
    void run(async () => {
      const id = await ensureAccountId();
      await window.orkestral['channels:set-config']({
        accountId: id,
        agentId: nextAgentId,
        allowlist: list,
        token,
        teams: teamsPatch(),
      });
    });
  };

  function addNumber(): void {
    // Teams: AAD id / e-mail (preserva o valor); demais: só dígitos (número/snowflake).
    const entry = isTeams ? numberDraft.trim().toLowerCase() : numberDraft.replace(/\D/g, '');
    if (!entry || allowlist.includes(entry)) {
      setNumberDraft('');
      return;
    }
    const next = [...allowlist, entry];
    setAllowlist(next);
    setNumberDraft('');
    saveConfig(agentId, next);
  }

  const handleConnect = (): Promise<void> =>
    run(async () => {
      const id = await ensureAccountId();
      await window.orkestral['channels:set-config']({
        accountId: id,
        agentId,
        allowlist,
        token: tokenDraft.trim() || undefined,
        teams: teamsPatch(),
      });
      await window.orkestral['channels:connect']({ accountId: id });
    });

  const handleDisconnect = (): Promise<void> =>
    run(async () => {
      if (account) await window.orkestral['channels:disconnect']({ accountId: account.id });
    });

  // Cria o app/bot do Teams. O main garante o login (device code) ANTES do create:
  // se precisar autenticar, o código chega pelo evento onTeamsLoginCode e aparece
  // aqui; o usuário abre a página, conclui o login, e o create segue sozinho.
  async function handleCreateApp(): Promise<void> {
    setCreating(true);
    setCreateMsg({ tone: 'info', text: t('pages.channels.modal.teamsCreating') });
    try {
      const id = await ensureAccountId();
      const res = await window.orkestral['channels:teams-create-app']({ accountId: id });
      if (res.ok) {
        // O secret fica cifrado no main; aqui só refletimos os dados não-secretos.
        setAppIdDraft(res.appId);
        setTenantIdDraft(res.tenantId);
        setDeviceCode(null);
        await queryClient.invalidateQueries({ queryKey: ['channels'] });
        setCreateMsg({ tone: 'ok', text: t('pages.channels.modal.teamsCreated') });
      } else {
        setCreateMsg({ tone: 'error', text: res.message });
      }
    } catch (err) {
      setCreateMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-hairline px-6 py-4">
          <div
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
            style={{ backgroundColor: `${brand.color}26` }}
          >
            <BrandSvg brand={brand} className="h-[18px] w-[18px]" />
          </div>
          <DialogTitle className="text-[15px] font-semibold">{brand.name}</DialogTitle>
          <span
            className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', STATUS_TONE[status])}
          >
            {t(`pages.channels.status.${status}`)}
          </span>
        </div>

        {/* Body */}
        <div className="thin-scrollbar flex flex-col gap-5 overflow-y-auto px-6 py-5">
          {/* Token do bot (Discord / Telegram) */}
          {(isDiscord || isTelegram) && (
            <div>
              <p className="text-[12.5px] font-medium text-text-secondary">
                {t('pages.channels.modal.tokenTitle')}
              </p>
              <p className="mt-0.5 text-[11.5px] text-text-faint">
                {t('pages.channels.modal.tokenHint')}
              </p>
              <input
                type="password"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder={
                  account?.hasToken
                    ? t('pages.channels.modal.tokenSaved')
                    : t('pages.channels.modal.tokenPlaceholder')
                }
                className={cn(INPUT_CLS, 'mt-2.5')}
              />
            </div>
          )}

          {/* Credenciais do bot Teams */}
          {isTeams && (
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-[12.5px] font-medium text-text-secondary">
                  {t('pages.channels.modal.teamsTitle')}
                </p>
                <p className="mt-0.5 text-[11.5px] text-text-faint">
                  {t('pages.channels.modal.teamsHint')}
                </p>
              </div>

              {/* Card: criar app automaticamente (CLI da Microsoft) */}
              <div className="flex flex-col gap-3 rounded-xl border border-hairline bg-surface-subtle p-3.5">
                <div>
                  <p className="text-[12.5px] font-medium text-text-secondary">
                    {t('pages.channels.modal.teamsCreateTitle')}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
                    {t('pages.channels.modal.teamsCreateHint')}
                  </p>
                </div>

                {deviceCode && <TeamsDeviceCode code={deviceCode.code} url={deviceCode.url} />}

                <button
                  type="button"
                  onClick={() => void handleCreateApp()}
                  disabled={creating}
                  className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-accent text-[12.5px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                >
                  {creating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {t('pages.channels.modal.teamsCreateBtn')}
                </button>

                {createMsg && (
                  <p
                    className={cn('text-center text-[11px]', {
                      'text-accent-green': createMsg.tone === 'ok',
                      'text-accent-red': createMsg.tone === 'error',
                      'text-text-faint': createMsg.tone === 'info',
                    })}
                  >
                    {createMsg.text}
                  </p>
                )}
              </div>

              {/* Accordion: preencher credenciais manualmente */}
              <div className="overflow-hidden rounded-xl border border-hairline">
                <button
                  type="button"
                  onClick={() => setManualOpen((v) => !v)}
                  className="flex w-full items-center justify-between px-3.5 py-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:text-text-primary"
                >
                  {t('pages.channels.modal.teamsManualLabel')}
                  <ChevronDown
                    className={cn('h-4 w-4 text-text-muted transition-transform', {
                      'rotate-180': manualOpen,
                    })}
                  />
                </button>
                {manualOpen && (
                  <div className="flex flex-col gap-2.5 border-t border-hairline-faint px-3.5 py-3">
                    <input
                      type="text"
                      value={appIdDraft}
                      onChange={(e) => setAppIdDraft(e.target.value)}
                      placeholder={
                        account?.hasToken
                          ? t('pages.channels.modal.teamsSaved')
                          : t('pages.channels.modal.teamsAppId')
                      }
                      className={INPUT_CLS}
                    />
                    <input
                      type="password"
                      value={appPasswordDraft}
                      onChange={(e) => setAppPasswordDraft(e.target.value)}
                      placeholder={
                        account?.hasToken
                          ? t('pages.channels.modal.teamsSaved')
                          : t('pages.channels.modal.teamsAppPassword')
                      }
                      className={INPUT_CLS}
                    />
                    <input
                      type="text"
                      value={tenantIdDraft}
                      onChange={(e) => setTenantIdDraft(e.target.value)}
                      placeholder={
                        account?.hasToken
                          ? t('pages.channels.modal.teamsSaved')
                          : t('pages.channels.modal.teamsTenantId')
                      }
                      className={INPUT_CLS}
                    />
                    <input
                      type="number"
                      value={portDraft}
                      onChange={(e) => setPortDraft(e.target.value)}
                      placeholder={t('pages.channels.modal.teamsPort')}
                      className={INPUT_CLS}
                    />
                  </div>
                )}
              </div>

              {/* Endpoint público em uso (só quando conectado) */}
              {connected && account?.endpoint && (
                <div className="rounded-xl border border-hairline bg-surface-subtle px-3.5 py-2.5">
                  <p className="text-[11.5px] font-medium text-text-secondary">
                    {t('pages.channels.modal.teamsEndpointTitle')}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
                    {t('pages.channels.modal.teamsEndpointHint')}
                  </p>
                  <code className="mt-1.5 block break-all text-[11.5px] text-text-primary">
                    {account.endpoint}
                  </code>
                </div>
              )}
            </div>
          )}

          {/* Quem responde */}
          <div>
            <p className="text-[12.5px] font-medium text-text-secondary">
              {t('pages.channels.modal.configTitle')}
            </p>
            <p className="mt-0.5 text-[11.5px] text-text-faint">
              {t('pages.channels.modal.configHint')}
            </p>
            <div className="mt-2.5">
              <DSSelect
                value={agentId}
                onChange={(v) => {
                  setDraftAgentId(v);
                  saveConfig(v, allowlist);
                }}
                options={agentOptions}
                placeholder={t('pages.channels.modal.agentLabel')}
              />
            </div>
          </div>

          {/* Allowlist (opcional) — só WhatsApp. Discord responde DMs + @menções
              nos servidores onde o bot está (escopo natural, igual openclaw). */}
          {!isDiscord && (
            <div>
              <p className="text-[12.5px] font-medium text-text-secondary">
                {isTeams
                  ? t('pages.channels.modal.allowlistTitleTeams')
                  : t('pages.channels.modal.allowlistTitle')}
              </p>
              <p className="mt-0.5 text-[11.5px] text-text-faint">
                {isTeams
                  ? t('pages.channels.modal.allowlistHintTeams')
                  : t('pages.channels.modal.allowlistHint')}
              </p>
              <div className="mt-2.5 flex gap-2">
                <input
                  type={isTeams ? 'text' : 'tel'}
                  value={numberDraft}
                  onChange={(e) => setNumberDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addNumber();
                    }
                  }}
                  placeholder={
                    isTeams
                      ? t('pages.channels.modal.allowlistPlaceholderTeams')
                      : t('pages.channels.modal.allowlistPlaceholder')
                  }
                  className={cn(INPUT_CLS, 'min-w-0 flex-1')}
                />
                <button
                  type="button"
                  onClick={addNumber}
                  className="inline-flex shrink-0 items-center gap-1 rounded-[10px] border border-hairline-heavy bg-surface-2 px-3 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('pages.channels.modal.allowlistAdd')}
                </button>
              </div>
              {allowlist.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {allowlist.map((n) => (
                    <span
                      key={n}
                      className="inline-flex items-center gap-1 rounded-full bg-surface-strong py-1 pl-2.5 pr-1 text-[11.5px] text-text-secondary"
                    >
                      {n}
                      <button
                        type="button"
                        onClick={() => {
                          const next = allowlist.filter((x) => x !== n);
                          setAllowlist(next);
                          saveConfig(agentId, next);
                        }}
                        className="grid h-4 w-4 place-items-center rounded-full text-text-faint hover:bg-surface-active hover:text-text-primary"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-text-faint">
                  {t('pages.channels.modal.allowlistEmpty')}
                </p>
              )}
            </div>
          )}

          {/* QR */}
          {showQr && (
            <div className="flex flex-col items-center gap-2.5 border-t border-hairline pt-5">
              <div className="rounded-xl border border-hairline bg-white p-2.5">
                <img
                  src={account?.qrDataUrl ?? ''}
                  alt={brand.name}
                  className="h-[208px] w-[208px]"
                />
              </div>
              <p className="max-w-[280px] text-center text-[11.5px] text-text-muted">
                {isSignal ? t('pages.channels.signal.qrHint') : t('pages.channels.modal.qrHint')}
              </p>
            </div>
          )}

          {/* Conectado */}
          {connected && account?.selfId && (
            <p className="text-[12px] text-text-secondary">
              {t('pages.channels.modal.connectedAs', {
                id: account.selfId.split(':')[0].split('@')[0],
              })}
              <span className="ml-1.5 text-text-faint">
                · {t('pages.channels.modal.sessions', { count: account.sessionCount })}
              </span>
            </p>
          )}

          {/* Erros */}
          {(uiError || (account?.lastError && status !== 'connected')) && (
            <p className="text-[11.5px] text-accent-red">{uiError ?? account?.lastError}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-hairline px-6 py-4">
          {!connected ? (
            <button
              type="button"
              onClick={() => void handleConnect()}
              disabled={busy || !agentId || !tokenReady}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {busy || status === 'connecting' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : isDiscord || isTeams || isTelegram ? (
                <Plug className="h-3.5 w-3.5" />
              ) : status === 'qr' ? (
                <RefreshCw className="h-3.5 w-3.5" />
              ) : (
                <QrCode className="h-3.5 w-3.5" />
              )}
              {status === 'qr'
                ? t('pages.channels.modal.waiting')
                : status === 'connecting'
                  ? t('pages.channels.modal.connecting')
                  : t('pages.channels.modal.connect')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-hairline-heavy bg-surface-2 px-3.5 py-2 text-[12.5px] font-medium text-accent-red transition-colors hover:bg-accent-red/10 disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              {t('pages.channels.modal.disconnect')}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Caixa do código de device login (mono grande + click-to-copy + abrir página). */
function TeamsDeviceCode({ code, url }: { code: string; url: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => undefined);
  };
  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={copy}
        title={
          copied ? t('pages.channels.modal.teamsCopied') : t('pages.channels.modal.teamsCopyCode')
        }
        className={cn('group rounded-lg border py-4 transition-colors', {
          'border-accent-green/40 bg-accent-green/[0.08]': copied,
          'border-hairline bg-surface-2 hover:bg-surface-3': !copied,
        })}
      >
        <div className="text-center font-mono text-[24px] font-medium tracking-[0.3em] text-text-primary">
          {code}
        </div>
        <div
          className={cn('mt-1 flex items-center justify-center gap-1.5 text-[10.5px]', {
            'text-accent-green': copied,
            'text-text-muted group-hover:text-text-secondary': !copied,
          })}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              {t('pages.channels.modal.teamsCopied')}
            </>
          ) : (
            t('pages.channels.modal.teamsCopyCode')
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={() => void window.orkestral['channels:teams-open-page']({ url })}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-hairline-heavy bg-surface-2 text-[12.5px] font-medium text-text-primary transition-colors hover:bg-surface-3"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {t('pages.channels.modal.teamsOpenPage')}
      </button>
      <p className="text-center text-[11px] leading-relaxed text-text-faint">
        {t('pages.channels.modal.teamsDeviceInstruction')}
      </p>
      <div className="flex items-start gap-1.5 rounded-lg border border-accent-yellow/20 bg-accent-yellow/[0.06] px-2.5 py-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-yellow" />
        <p className="text-[11px] leading-relaxed text-accent-yellow">
          {t('pages.channels.modal.teamsAccountWarning')}
        </p>
      </div>
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        {children}
      </div>
    </div>
  );
}
