import { useState } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';

/**
 * Teaser de FEATURE FUTURA: conversar com o Orkestral pelos apps de mensagem
 * (Discord/Slack/Telegram/WhatsApp). Por ora é só visual — dismissível e
 * persistido em localStorage pra não reaparecer depois de fechado.
 */
// v2: a chave foi bumpada de propósito pra "ressuscitar" o banner pra quem já tinha
// dispensado (o flag antigo some). Bump de novo se precisar reexibir no futuro.
const DISMISS_KEY = 'ork:messaging-channels-banner:dismissed:v2';

/** Logos de marca inline (paths oficiais simplificados), tintados na cor da marca. */
const CHANNELS: { name: string; color: string; path: string }[] = [
  {
    name: 'Discord',
    color: '#5865F2',
    path: 'M20.317 4.369A19.79 19.79 0 0 0 15.885 3c-.21.375-.444.88-.608 1.28a18.27 18.27 0 0 0-5.487 0A12.6 12.6 0 0 0 9.18 3a19.74 19.74 0 0 0-4.435 1.37C1.9 8.59 1.12 12.7 1.51 16.76a19.9 19.9 0 0 0 5.993 3.04c.484-.66.915-1.36 1.286-2.1-.708-.27-1.385-.6-2.025-.99.17-.124.336-.254.496-.388a14.2 14.2 0 0 0 12.49 0c.162.14.328.27.496.388-.642.39-1.32.72-2.028.99.37.74.8 1.44 1.285 2.1a19.86 19.86 0 0 0 5.996-3.04c.46-4.7-.787-8.77-3.282-12.39zM8.02 14.33c-1.18 0-2.157-1.08-2.157-2.41 0-1.33.955-2.42 2.157-2.42 1.21 0 2.177 1.09 2.157 2.42 0 1.33-.955 2.41-2.157 2.41zm7.96 0c-1.18 0-2.157-1.08-2.157-2.41 0-1.33.955-2.42 2.157-2.42 1.21 0 2.178 1.09 2.157 2.42 0 1.33-.946 2.41-2.157 2.41z',
  },
  {
    name: 'Slack',
    color: '#E01E5A',
    path: 'M5.04 15.16a2.52 2.52 0 0 1-2.52 2.52A2.52 2.52 0 0 1 0 15.16a2.52 2.52 0 0 1 2.52-2.52h2.52v2.52zm1.27 0a2.52 2.52 0 0 1 2.52-2.52 2.52 2.52 0 0 1 2.52 2.52v6.32A2.52 2.52 0 0 1 8.83 24a2.52 2.52 0 0 1-2.52-2.52v-6.32zM8.83 5.04a2.52 2.52 0 0 1-2.52-2.52A2.52 2.52 0 0 1 8.83 0a2.52 2.52 0 0 1 2.52 2.52v2.52H8.83zm0 1.27a2.52 2.52 0 0 1 2.52 2.52 2.52 2.52 0 0 1-2.52 2.52H2.52A2.52 2.52 0 0 1 0 8.83a2.52 2.52 0 0 1 2.52-2.52h6.31zM18.96 8.83a2.52 2.52 0 0 1 2.52-2.52A2.52 2.52 0 0 1 24 8.83a2.52 2.52 0 0 1-2.52 2.52h-2.52V8.83zm-1.27 0a2.52 2.52 0 0 1-2.52 2.52 2.52 2.52 0 0 1-2.52-2.52V2.52A2.52 2.52 0 0 1 15.17 0a2.52 2.52 0 0 1 2.52 2.52v6.31zM15.17 18.96a2.52 2.52 0 0 1 2.52 2.52A2.52 2.52 0 0 1 15.17 24a2.52 2.52 0 0 1-2.52-2.52v-2.52h2.52zm0-1.27a2.52 2.52 0 0 1-2.52-2.52 2.52 2.52 0 0 1 2.52-2.52h6.32A2.52 2.52 0 0 1 24 15.17a2.52 2.52 0 0 1-2.52 2.52h-6.31z',
  },
  {
    name: 'Telegram',
    color: '#26A5E4',
    path: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
  },
  {
    name: 'WhatsApp',
    color: '#25D366',
    path: 'M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 0 1 8.413 3.488 11.824 11.824 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884a9.86 9.86 0 0 0 1.51 5.26l-.999 3.648 3.978-1.207zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413z',
  },
];

export function MessagingChannelsBanner() {
  const { t } = useT();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed) return null;

  const dismiss = (): void => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignora storage indisponível */
    }
  };

  return (
    // Flush: vive DENTRO do card do prompt como EXTENSÃO inferior (o wrapper no
    // ChatPrompt já dá o fundo escuro `bg-sidebar` + cantos `rounded-b-2xl`).
    // Aqui só o conteúdo, sem borda/rounded/bg próprios.
    // -mb-1.5: tira espaço EMBAIXO do conteúdo (texto + ícones + X) → ele desce e fica mais
    // centrado na faixa VISÍVEL do banner (a parte que sobra abaixo do input).
    <div className="-mb-1.5 flex items-center gap-2.5 px-3.5 py-2.5">
      <MessageCircle className="h-4 w-4 shrink-0 text-text-muted" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-secondary">
        {t('dashboard.home.channelsTeaser')}
      </span>
      <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide text-text-faint">
        {t('dashboard.home.channelsSoon')}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        {CHANNELS.map((c) => (
          <svg
            key={c.name}
            viewBox="0 0 24 24"
            className="h-4 w-4"
            role="img"
            aria-label={c.name}
            fill={c.color}
          >
            <path d={c.path} />
          </svg>
        ))}
      </div>
      <button
        type="button"
        onClick={dismiss}
        className={cn(
          'grid h-6 w-6 shrink-0 place-items-center rounded-md text-text-muted',
          'transition-colors hover:bg-surface-active hover:text-text-primary',
        )}
        title={t('dashboard.home.channelsDismiss')}
        aria-label={t('dashboard.home.channelsDismiss')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
