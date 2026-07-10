/**
 * Desktop pet — Fase 0: sprite placeholder estático, arrastável, com
 * click-through fora dele. Estados/animações por evento entram na Fase 1
 * (docs/DESKTOP_PET.md).
 *
 * A janela nasce com setIgnoreMouseEvents(true, {forward:true}): tudo
 * atravessa, mas os mousemove chegam aqui. No hover do sprite ligamos a
 * interação; ao sair, devolvemos o click-through.
 */

function setIgnoreMouse(ignore: boolean): void {
  // Best-effort: se o IPC falhar o pior caso é a janela ficar num dos modos.
  void window.orkestral['pet:set-ignore-mouse']({ ignore }).catch(() => {});
}

/** Placeholder da Fase 0 — vira sprite sheet pixel art na Fase 3. */
function PetSprite() {
  return (
    <svg viewBox="0 0 96 96" role="img" aria-label="Orkestral pet">
      {/* corpo */}
      <path
        d="M48 10c-8 0-13 4-16 9-6-2-14 1-16 8-2 6 1 11 5 14-3 3-5 7-5 12 0 12 14 21 32 21s32-9 32-21c0-5-2-9-5-12 4-3 7-8 5-14-2-7-10-10-16-8-3-5-8-9-16-9z"
        fill="#7C3AED"
      />
      {/* barriga mais clara */}
      <ellipse cx="48" cy="62" rx="22" ry="14" fill="#8B5CF6" />
      {/* placa do rosto */}
      <rect x="26" y="30" width="44" height="26" rx="13" fill="#0E0F10" />
      {/* olhos felizes (arcos) */}
      <path
        d="M36 45c2-4 8-4 10 0"
        stroke="#C4B5FD"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M52 45c2-4 8-4 10 0"
        stroke="#C4B5FD"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
      />
      {/* pés */}
      <ellipse cx="36" cy="86" rx="8" ry="5" fill="#6D28D9" />
      <ellipse cx="60" cy="86" rx="8" ry="5" fill="#6D28D9" />
    </svg>
  );
}

export function PetApp() {
  return (
    <div className="pet-root">
      <div
        className="pet-sprite"
        onMouseEnter={() => setIgnoreMouse(false)}
        onMouseLeave={() => setIgnoreMouse(true)}
      >
        <PetSprite />
      </div>
    </div>
  );
}
