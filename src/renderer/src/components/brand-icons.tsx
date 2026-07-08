import { Cpu } from 'lucide-react';
import type { AdapterType } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import logoIcon from '@renderer/assets/logo_icon.png';
import claudecode from '@renderer/assets/icons/claudecode.svg?raw';
import codex from '@renderer/assets/icons/codex.svg?raw';
import geminicli from '@renderer/assets/icons/geminicli.svg?raw';
import grok from '@renderer/assets/icons/grok.svg?raw';
import cursor from '@renderer/assets/icons/cursor.svg?raw';
import opencode from '@renderer/assets/icons/opencode.svg?raw';
import hermesagent from '@renderer/assets/icons/hermesagent.svg?raw';
import openclaw from '@renderer/assets/icons/openclaw.svg?raw';

/**
 * Ícones de marca dos provedores de adapter (Claude/Anthropic, Codex/OpenAI,
 * Cursor, Gemini, Grok/xAI, Hermes, OpenCode, Pi, etc.).
 *
 * As marcas que já têm SVG oficial no repo (Anthropic, OpenAI, Google/Gemini,
 * xAI/Grok, OpenCode) são reaproveitadas via import `?raw` e inlinadas — todas
 * monocromáticas com `fill="currentColor"`, então herdam a cor do texto e
 * funcionam nos temas claro E escuro. As que ainda não têm asset (Cursor,
 * Hermes, Pi, OpenClaw Gateway) recebem um SVG desenhado aqui, também em
 * `currentColor`. Onde uma marca fiel é incerta, usamos um monograma limpo em
 * vez de um logo errado. Todos legíveis em 16–20px.
 *
 * Use `adapterBrandIcon(type)` pra resolver o componente certo a partir do
 * AdapterType — com fallback genérico (Cpu) pra tipos desconhecidos.
 */

type IconProps = { className?: string };

/** Inlina um SVG `?raw` (monocromático/currentColor) herdando a cor do texto. */
function rawSvgIcon(raw: string) {
  return function RawSvgIcon({ className }: IconProps) {
    return (
      <span
        aria-hidden
        className={cn(
          'inline-flex shrink-0 items-center justify-center [&_svg]:block [&_svg]:h-full [&_svg]:w-full',
          className,
        )}
        dangerouslySetInnerHTML={{ __html: raw }}
      />
    );
  };
}

/** Props base de um SVG desenhado localmente: viewBox 24 + currentColor. */
function svgProps(className?: string) {
  return {
    className,
    viewBox: '0 0 24 24',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true,
    focusable: false as const,
  };
}

/** Anthropic / Claude Code — marca oficial (asset do repo). */
export const AnthropicIcon = rawSvgIcon(claudecode);

/** OpenAI / Codex — marca oficial (asset do repo). */
export const OpenAIIcon = rawSvgIcon(codex);

/** Google Gemini CLI — marca oficial (asset do repo). */
export const GeminiIcon = rawSvgIcon(geminicli);

/** xAI / Grok — marca oficial (asset do repo). */
export const GrokIcon = rawSvgIcon(grok);

/** Sentry — logo oficial, monocromático em currentColor (herda a cor do texto). */
export function SentryIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 72 66"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      focusable={false}
    >
      <path
        d="M29,2.26a4.67,4.67,0,0,0-8,0L14.42,13.53A32.21,32.21,0,0,1,32.17,40.19H27.55A27.68,27.68,0,0,0,12.09,17.47L6,28a15.92,15.92,0,0,1,9.23,12.17H4.62A.76.76,0,0,1,4,39.06l2.94-5a10.74,10.74,0,0,0-3.36-1.9l-2.91,5a4.54,4.54,0,0,0,1.69,6.24A4.66,4.66,0,0,0,4.62,44H19.15a19.4,19.4,0,0,0-8-17.31l2.31-4A23.87,23.87,0,0,1,23.76,44H36.07a35.88,35.88,0,0,0-16.41-31.8l4.67-8a.77.77,0,0,1,1.05-.27c.53.29,20.29,34.77,20.66,35.17a.76.76,0,0,1-.68,1.13H40.6q.09,1.91,0,3.81h4.78A4.59,4.59,0,0,0,50,39.43a4.49,4.49,0,0,0-.62-2.28Z"
        transform="translate(11, 11)"
        fill="currentColor"
      />
    </svg>
  );
}

/** OpenCode — marca oficial (asset do repo). */
export const OpenCodeIcon = rawSvgIcon(opencode);

/** Cursor — marca oficial (asset do repo). */
export const CursorIcon = rawSvgIcon(cursor);

/** Cursor Cloud — mesma marca do Cursor. */
export const CursorCloudIcon = CursorIcon;

/** Nous Hermes — marca oficial (asset do repo). */
export const HermesIcon = rawSvgIcon(hermesagent);

/** OpenClaw Gateway — marca oficial (asset do repo). */
export const GatewayIcon = rawSvgIcon(openclaw);

/** Inflection Pi — glifo π (sem asset dedicado; desenhado em currentColor). */
export function PiIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)} fill="currentColor">
      <path d="M4 6h16v2.4h-3.1V18h-2.5V8.4H9.6V18a2.4 2.4 0 0 1-2.4 2.4A2.4 2.4 0 0 1 4.8 18h2.3a.1.1 0 0 0 .2 0V8.4H4V6Z" />
    </svg>
  );
}

/**
 * Orkestral Forge (orkestral_local) — reaproveita o logo do app via <img>
 * (mesmo asset usado na Sidebar). Não é SVG currentColor por ser a marca do
 * próprio app; mas é legível nos dois temas. `object-contain` respeita o size
 * passado via className.
 */
export function OrkestralIcon({ className }: IconProps) {
  return (
    <img
      src={logoIcon}
      alt=""
      aria-hidden
      className={cn('shrink-0', className)}
      style={{ objectFit: 'contain' }}
    />
  );
}

/** Fallback genérico (Cpu lucide) pra AdapterTypes desconhecidos. */
function FallbackIcon({ className }: IconProps) {
  return <Cpu className={cn('shrink-0', className)} />;
}

/**
 * Resolve o componente de ícone de marca a partir do AdapterType.
 * Fallback: Cpu genérico pra tipos desconhecidos.
 */
export function adapterBrandIcon(type: AdapterType): React.ComponentType<{ className?: string }> {
  switch (type) {
    case 'claude_local':
      return AnthropicIcon;
    case 'codex_local':
      return OpenAIIcon;
    case 'orkestral_local':
      return OrkestralIcon;
    case 'cursor_cloud':
      return CursorCloudIcon;
    case 'cursor_local':
      return CursorIcon;
    case 'gemini_local':
      return GeminiIcon;
    case 'grok_local':
      return GrokIcon;
    case 'hermes_local':
      return HermesIcon;
    case 'opencode_local':
      return OpenCodeIcon;
    case 'pi_local':
      return PiIcon;
    case 'openclaw_gateway':
      return GatewayIcon;
    default:
      return FallbackIcon;
  }
}

export function AdapterBrandIcon({ type, className }: { type: AdapterType; className?: string }) {
  switch (type) {
    case 'claude_local':
      return <AnthropicIcon className={className} />;
    case 'codex_local':
      return <OpenAIIcon className={className} />;
    case 'orkestral_local':
      return <OrkestralIcon className={className} />;
    case 'cursor_cloud':
      return <CursorCloudIcon className={className} />;
    case 'cursor_local':
      return <CursorIcon className={className} />;
    case 'gemini_local':
      return <GeminiIcon className={className} />;
    case 'grok_local':
      return <GrokIcon className={className} />;
    case 'hermes_local':
      return <HermesIcon className={className} />;
    case 'opencode_local':
      return <OpenCodeIcon className={className} />;
    case 'pi_local':
      return <PiIcon className={className} />;
    case 'openclaw_gateway':
      return <GatewayIcon className={className} />;
    default:
      return <FallbackIcon className={className} />;
  }
}
