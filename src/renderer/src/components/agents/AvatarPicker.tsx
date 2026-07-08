import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Shuffle, Check } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';
import { AgentAvatar, buildAvatarDataUri, resolveSeed } from './AgentAvatar';

/**
 * Picker de avatar: clica no avatar atual → abre popover via portal com
 * uma grade de 12 variações pré-geradas + botão de "embaralhar" pra gerar
 * outras 12. Selecionar chama onChange com a seed escolhida.
 *
 * Padrão visual: card neutro escuro, hover sutil, ring no avatar atual.
 */

interface AvatarPickerProps {
  seed: string | null | undefined;
  name?: string | null;
  onChange: (seed: string) => void;
  /** Tamanho do trigger principal (px). Default 64. */
  size?: number;
  /** Desabilita o picker quando true (mostra só o avatar atual). */
  disabled?: boolean;
}

/** Pool de seeds base — palavras curtas, diversas, geram robôs visualmente distintos. */
const BASE_POOL = [
  'apollo',
  'nova',
  'ada',
  'turing',
  'echo',
  'mira',
  'orion',
  'pixel',
  'byte',
  'cipher',
  'quark',
  'atlas',
  'rune',
  'sigma',
  'helix',
  'nyx',
  'flux',
  'glitch',
  'lumen',
  'vesper',
  'circuit',
  'oracle',
  'pulse',
  'titan',
  'zephyr',
  'cobalt',
  'neon',
  'plasma',
  'binary',
  'static',
  'vector',
  'kernel',
  'cipher2',
  'matrix',
  'syntax',
  'logic',
  'arcane',
  'mecha',
  'photon',
  'quark2',
];

function randomBatch(currentSeed?: string | null, size = 12): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  if (currentSeed) used.add(currentSeed);
  // Mistura pool + sufixos aleatórios pra ter variedade infinita
  const shuffled = [...BASE_POOL].sort(() => Math.random() - 0.5);
  for (const s of shuffled) {
    if (out.length >= size) break;
    if (used.has(s)) continue;
    out.push(s);
    used.add(s);
  }
  // Se o pool acabar (pediu mais que 40), gera com sufixos aleatórios
  while (out.length < size) {
    const candidate = `${BASE_POOL[Math.floor(Math.random() * BASE_POOL.length)]}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    if (!used.has(candidate)) {
      out.push(candidate);
      used.add(candidate);
    }
  }
  return out;
}

export function AvatarPicker({
  seed,
  name,
  onChange,
  size = 64,
  disabled = false,
}: AvatarPickerProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [batch, setBatch] = useState<string[]>(() => randomBatch(seed));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const currentSeed = resolveSeed({ avatarSeed: seed, name });

  // Fecha em clique fora / ESC. Usamos `closest('[data-avatar-popover]')`
  // em vez de `popoverRef.current.contains(target)` porque com portais o
  // ref pode chegar tarde demais ao primeiro click — o atributo data viaja
  // junto com o nó no DOM independente de ref timing.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as HTMLElement;
      if (t.closest('[data-avatar-popover]')) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle() {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setPos({
        left: rect.left,
        top: rect.bottom + 6,
      });
    }
    setBatch(randomBatch(currentSeed));
    setOpen(true);
  }

  function pick(s: string) {
    onChange(s);
    setOpen(false);
  }

  // Pré-gera os data URIs uma vez por batch
  const previews = useMemo(
    () => batch.map((s) => ({ seed: s, uri: buildAvatarDataUri(s) })),
    [batch],
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        className={cn(
          'group relative inline-flex items-center justify-center rounded-md transition-opacity',
          !disabled && 'hover:opacity-90',
          disabled && 'cursor-default',
        )}
        title={disabled ? '' : t('agents.avatar.change')}
      >
        <AgentAvatar seed={seed} name={name} size={size} />
        {!disabled && (
          <span className="pointer-events-none absolute inset-0 flex items-end justify-end rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="rounded-md bg-black/50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white">
              {t('agents.avatar.edit')}
            </span>
          </span>
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            data-avatar-popover
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.top,
              zIndex: 1000,
              backgroundColor: '#15161b',
            }}
            className="w-[300px] rounded-xl border border-hairline-strong p-3 shadow-2xl"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-faint">
                {t('agents.avatar.choose')}
              </span>
              <button
                type="button"
                onClick={() => setBatch(randomBatch(currentSeed))}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-1 px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-6 hover:text-text-primary active:bg-surface-5"
                title={t('agents.avatar.shuffle')}
              >
                <Shuffle className="pointer-events-none h-3 w-3" />
                <span className="pointer-events-none">{t('agents.avatar.shuffle')}</span>
              </button>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {previews.map((p) => (
                <button
                  key={p.seed}
                  type="button"
                  onClick={() => pick(p.seed)}
                  className={cn(
                    'group relative grid h-14 w-14 place-items-center overflow-hidden rounded-md bg-surface-1 transition-all',
                    p.seed === currentSeed
                      ? 'ring-2 ring-accent-blue'
                      : 'ring-1 ring-hairline hover:ring-hairline-ultra',
                  )}
                  title={p.seed}
                >
                  <img src={p.uri} alt={p.seed} width={56} height={56} draggable={false} />
                  {p.seed === currentSeed && (
                    <span className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-accent-blue text-white">
                      <Check className="h-2.5 w-2.5" />
                    </span>
                  )}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10.5px] text-text-faint">{t('agents.avatar.credit')}</p>
          </div>,
          document.body,
        )}
    </>
  );
}
