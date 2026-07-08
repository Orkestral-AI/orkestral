import { useMemo } from 'react';
import { createAvatar } from '@dicebear/core';
import { toonHead } from '@dicebear/collection';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';

/**
 * Avatar de agente — DiceBear estilo `toon-head` (cabeças cartoon humanas).
 * Cada agente tem uma seed única; o SVG é gerado in-memory (sem internet) e
 * cacheado por seed via `useMemo`. Tamanho controlado por prop (px). Fallback:
 * deriva seed do nome do agente quando não há seed explícita salva.
 */

/** Gera uma seed determinística a partir do nome quando o agente não tem uma. */
export function seedFromName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-') || 'agent';
}

/** Resolve a seed efetiva: explícita → fallback do nome. */
export function resolveSeed(input: { avatarSeed?: string | null; name?: string | null }): string {
  if (input.avatarSeed && input.avatarSeed.trim()) return input.avatarSeed;
  return seedFromName(input.name ?? 'agent');
}

/** Gera o data URI do SVG do toon-head pra uma seed. */
export function buildAvatarDataUri(seed: string): string {
  const avatar = createAvatar(toonHead, {
    seed,
    size: 96,
  });
  return avatar.toDataUri();
}

/** @deprecated alias retrocompat — use buildAvatarDataUri. */
export const buildBotttsDataUri = buildAvatarDataUri;

interface AgentAvatarProps {
  /** Seed explícita ou null pra usar o nome como fallback. */
  seed?: string | null;
  /** Nome do agente — usado como fallback se seed estiver vazia. */
  name?: string | null;
  /** Tamanho em px (default 32). */
  size?: number;
  /** Classes extras pro wrapper. */
  className?: string;
  /** Border radius — default sólido (rounded-md). Use 'full' pra circular. */
  rounded?: 'md' | 'lg' | 'full';
}

export function AgentAvatar({
  seed,
  name,
  size = 32,
  className,
  rounded = 'md',
}: AgentAvatarProps) {
  const { t } = useT();
  const resolved = resolveSeed({ avatarSeed: seed, name });
  const dataUri = useMemo(() => buildAvatarDataUri(resolved), [resolved]);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden bg-surface-1 ring-1 ring-hairline',
        rounded === 'full' && 'rounded-full',
        rounded === 'lg' && 'rounded-lg',
        rounded === 'md' && 'rounded-md',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <img
        src={dataUri}
        alt={name ?? t('agents.avatar.alt')}
        width={size}
        height={size}
        draggable={false}
        style={{ width: size, height: size }}
      />
    </span>
  );
}
