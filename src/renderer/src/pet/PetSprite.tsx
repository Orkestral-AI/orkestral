import type { PetVisualState } from './pet-state';

/**
 * Sprite do pet — criatura de CRISTAL FACETADO, mesma linguagem low-poly do
 * logo do Orkestral (o "O" diamante): corpo em facetas roxas com luz vindo do
 * alto-esquerdo, placa de rosto escura ecoando o furo do "O", dois estilhaços
 * de cristal flutuando como mãos. Sem pés: ele levita (sombra elíptica embaixo).
 *
 * Vetor puro: estados trocam olhos/cores por props e as animações ficam no CSS
 * (classes pet--<estado> no wrapper) — nada de sprite sheet binária.
 */

interface PetSpriteProps {
  state: PetVisualState;
}

/** Facetas do corpo: anel externo → anel interno, luz do alto-esquerdo.
 *  Paleta tirada do icon.svg do app (violetas + glints quase-brancos). */
const BODY_FACETS: Array<{ points: string; fill: string }> = [
  // coroa (topo) — mais clara, pega a luz
  { points: '60,8 34,22 60,30', fill: '#DDD6FE' },
  { points: '60,8 60,30 86,22', fill: '#C4B5FD' },
  // ombros
  { points: '34,22 18,50 40,44', fill: '#A78BFA' },
  { points: '34,22 40,44 60,30', fill: '#B7A5F8' },
  { points: '86,22 60,30 80,44', fill: '#9F7EF5' },
  { points: '86,22 80,44 102,50', fill: '#8B5CF6' },
  // flancos
  { points: '18,50 16,72 38,68', fill: '#8B5CF6' },
  { points: '18,50 38,68 40,44', fill: '#977BF2' },
  { points: '102,50 80,44 82,68', fill: '#7C3AED' },
  { points: '102,50 82,68 104,72', fill: '#6D28D9' },
  // base — mais escura, sombra própria
  { points: '16,72 34,96 38,68', fill: '#6D28D9' },
  { points: '34,96 60,104 56,84', fill: '#5B21B6' },
  { points: '34,96 56,84 38,68', fill: '#6524CE' },
  { points: '104,72 82,68 86,96', fill: '#5B21B6' },
  { points: '86,96 64,84 60,104', fill: '#4C1D95' },
  { points: '86,96 82,68 64,84', fill: '#54209F' },
  { points: '60,104 34,96 86,96', fill: '#47188C' },
  // miolo atrás da placa do rosto
  { points: '40,44 38,68 56,84 64,84 82,68 80,44 60,30', fill: '#7C3AED' },
];

/** Glints: facetas quase-brancas que "faíscam" no estado working (CSS). */
const GLINT_FACETS: Array<{ points: string; fill: string }> = [
  { points: '60,8 48,15 60,19', fill: '#F5F3FF' },
  { points: '18,50 26,48 24,60', fill: '#EDE9FE' },
  { points: '86,22 92,34 80,32', fill: '#EDE9FE' },
];

function Eyes({ state }: { state: PetVisualState }) {
  const stroke = state === 'error' ? '#FCA5A5' : '#C4B5FD';
  const common = {
    stroke,
    strokeWidth: 4,
    strokeLinecap: 'round' as const,
    fill: 'none' as const,
  };
  switch (state) {
    case 'working':
      // olhos focados: traços retos, levemente caídos pro centro (concentração)
      return (
        <g className="pet-eyes">
          <path d="M44 59 l11 -2" {...common} />
          <path d="M76 59 l-11 -2" {...common} />
        </g>
      );
    case 'done':
      // arcos altos de celebração
      return (
        <g className="pet-eyes">
          <path d="M43 60 q6 -10 12 0" {...common} />
          <path d="M65 60 q6 -10 12 0" {...common} />
        </g>
      );
    case 'error':
      // x_x
      return (
        <g className="pet-eyes">
          <path d="M44 53 l10 10 M54 53 l-10 10" {...common} strokeWidth={3.5} />
          <path d="M66 53 l10 10 M76 53 l-10 10" {...common} strokeWidth={3.5} />
        </g>
      );
    case 'attention':
      // uma sobrancelha erguida: arco + olho arregalado
      return (
        <g className="pet-eyes">
          <path d="M44 59 q5 -7 10 0" {...common} />
          <circle cx="71" cy="58" r="4" fill={common.stroke} />
        </g>
      );
    case 'idle':
    default:
      // arcos felizes suaves (piscada via CSS)
      return (
        <g className="pet-eyes pet-eyes--blink">
          <path d="M44 59 q5 -8 10 0" {...common} />
          <path d="M66 59 q5 -8 10 0" {...common} />
        </g>
      );
  }
}

/** Estilhaço de cristal (mão flutuante). Espelhado via transform no uso. */
function Shard() {
  return (
    <g>
      <polygon points="0,-10 6,0 0,12 -6,0" fill="#8B5CF6" />
      <polygon points="0,-10 6,0 0,2" fill="#C4B5FD" />
      <polygon points="0,2 6,0 0,12" fill="#6D28D9" />
    </g>
  );
}

export function PetSprite({ state }: PetSpriteProps) {
  return (
    <svg viewBox="0 0 120 132" role="img" aria-label="Orkestral pet">
      {/* sombra de levitação (não é drop-shadow: acompanha o bob no CSS) */}
      <ellipse
        className="pet-shadow"
        cx="60"
        cy="124"
        rx="26"
        ry="5"
        fill="#1E1033"
        opacity="0.5"
      />

      {/* Estilhaços-mãos: orbitam no working, caem no error (CSS). O transform
          de POSIÇÃO fica no <g> externo (atributo SVG) e a animação no interno —
          CSS transform sobrescreveria o atributo e jogaria o shard pra origem. */}
      <g transform="translate(10 64)">
        <g className="pet-shard pet-shard--left">
          <Shard />
        </g>
      </g>
      <g transform="translate(110 64) scale(-1 1)">
        <g className="pet-shard pet-shard--right">
          <Shard />
        </g>
      </g>

      {/* corpo facetado */}
      <g className="pet-body">
        {BODY_FACETS.map((f) => (
          <polygon key={f.points} points={f.points} fill={f.fill} />
        ))}
        <g className="pet-glints">
          {GLINT_FACETS.map((f) => (
            <polygon key={f.points} points={f.points} fill={f.fill} />
          ))}
        </g>

        {/* placa do rosto — eco do furo do "O" do logo */}
        <rect
          className="pet-face"
          x="36"
          y="42"
          width="48"
          height="32"
          rx="16"
          fill="#0B0C10"
          stroke={state === 'error' ? 'rgba(252,165,165,0.4)' : 'rgba(196,181,253,0.28)'}
          strokeWidth="1.5"
        />
        <Eyes state={state} />
      </g>
    </svg>
  );
}
