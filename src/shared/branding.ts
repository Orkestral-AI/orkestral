/**
 * Constantes de marca do Orkestral — fonte ÚNICA pro nome do produto e do modelo
 * local (Orkestral Forge). Evita strings de branding espalhadas pelo código e
 * mantém chat, issues, sidebar e marketplace consistentes (P1-01).
 */
export const BRANDING = {
  /** Nome do produto, exibido no chat/sidebar/issues. */
  appName: 'Orkestral',
  /** Modelo local (executor primário) — rótulo nos adapters e na orquestração. */
  forgeName: 'Orkestral Forge',
} as const;
