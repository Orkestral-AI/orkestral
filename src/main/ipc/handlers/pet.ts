import { registerHandler } from '../register';
import {
  setPetIgnoreMouse,
  setPetEnabled,
  openTargetFromPet,
  startPetDrag,
  endPetDrag,
  resizePetWindow,
} from '../../pet/pet-window';

/**
 * Handlers do desktop pet (docs/DESKTOP_PET.md). Ambos são desktop-only
 * (GATEWAY_WEB_UNAVAILABLE_CHANNELS) — no CLI Node puro o pet-window vira
 * no-op pelos guards do platform shim, então registrar aqui é sempre seguro.
 */
export function registerPetHandlers(): void {
  // Chamado pelo renderer DO PET em mouseenter/mouseleave das áreas interativas:
  // fora delas o clique atravessa a janela (o pet nunca bloqueia a tela).
  registerHandler('pet:set-ignore-mouse', (req) => {
    setPetIgnoreMouse(req.ignore);
    return { ok: true as const };
  });

  // Toggle das Configurações. Persiste pet.enabled + cria/destrói a janela.
  registerHandler('pet:set-enabled', (req) => {
    setPetEnabled(req.enabled);
    return { enabled: req.enabled };
  });

  // Clique num card/menu do pet → foca o app e navega/abre Configurações.
  registerHandler('pet:open-target', (req) => {
    openTargetFromPet(req.hash, req.openSettings);
    return { ok: true as const };
  });

  // Drag manual do sprite (segurar e arrastar) — janela segue o cursor.
  registerHandler('pet:drag-start', () => {
    startPetDrag();
    return { ok: true as const };
  });
  registerHandler('pet:drag-end', () => {
    endPetDrag();
    return { ok: true as const };
  });

  // Janela abraça o conteúdo (renderer mede e pede; âncora inferior-direita).
  registerHandler('pet:resize', (req) => {
    resizePetWindow(req.width, req.height);
    return { ok: true as const };
  });
}
