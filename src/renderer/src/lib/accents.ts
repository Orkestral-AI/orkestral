/**
 * Accent do app = cor do workspace ativo.
 *
 * O sistema de tema usa tokens nomeados (`data-accent="blue"` etc.) que o
 * global.css mapeia pros hues reais. A cor do workspace é guardada como hex.
 * Aqui ficam: a paleta única (token ↔ hex), o mapeamento hex→token (match
 * exato ou mais próximo) e o apply do `data-accent` no <html>.
 *
 * `purple` é o default — sem `data-accent` o app cai nos tokens base do @theme,
 * idêntico ao visual histórico.
 */

export type AccentToken = 'purple' | 'blue' | 'green' | 'yellow' | 'orange' | 'red';

export interface AccentOption {
  id: AccentToken;
  /** Hex exibido no seletor e salvo em `workspace.color`. */
  hex: string;
}

// Hexes espelham os hues realmente aplicados em runtime (ver global.css).
export const ACCENTS: AccentOption[] = [
  { id: 'purple', hex: '#a78bfa' },
  { id: 'blue', hex: '#60a5fa' },
  { id: 'green', hex: '#34d399' },
  { id: 'yellow', hex: '#facc15' },
  { id: 'orange', hex: '#fb923c' },
  { id: 'red', hex: '#f87171' },
];

const DEFAULT_ACCENT: AccentToken = 'purple';

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Resolve o token de accent a partir de uma cor de workspace (hex).
 * Match exato na paleta primeiro; senão o token de menor distância RGB.
 * Cor ausente/ inválida → default (`purple`).
 */
export function accentTokenFromColor(color: string | null | undefined): AccentToken {
  if (!color) return DEFAULT_ACCENT;
  const normalized = color.trim().toLowerCase();
  const exact = ACCENTS.find((a) => a.hex.toLowerCase() === normalized);
  if (exact) return exact.id;

  const rgb = hexToRgb(normalized);
  if (!rgb) return DEFAULT_ACCENT;

  let best: AccentToken = DEFAULT_ACCENT;
  let bestDist = Infinity;
  for (const a of ACCENTS) {
    const arr = hexToRgb(a.hex);
    if (!arr) continue;
    const d = (arr[0] - rgb[0]) ** 2 + (arr[1] - rgb[1]) ** 2 + (arr[2] - rgb[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = a.id;
    }
  }
  return best;
}

/**
 * Aplica o accent no <html> a partir da cor do workspace ativo. `purple`
 * remove o atributo (cai no default do @theme). Chamado sempre que o workspace
 * ativo muda ou sua cor é editada.
 */
export function applyWorkspaceAccent(color: string | null | undefined): void {
  if (typeof document === 'undefined') return;
  const token = accentTokenFromColor(color);
  const root = document.documentElement;
  if (token === DEFAULT_ACCENT) {
    root.removeAttribute('data-accent');
  } else {
    root.setAttribute('data-accent', token);
  }
}
