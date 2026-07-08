/**
 * Contrato de design do projeto + auditoria de UI do motor v2.
 *
 * Forge removido: o sistema NÃO impõe mais um design system nem audita a UI. O
 * contrato fica sempre "não congelado" e a auditoria nunca acusa violação, o
 * modelo do usuário decide a UI a partir das instruções dele. Mantido como ponto
 * de extensão pra o motor v2 (mesma interface dos call-sites).
 */

export interface DesignContract {
  /** Quando true, o kit de componentes é fixo e novas libs de UI seriam barradas. */
  frozen: boolean;
  /** Componentes disponíveis no kit (vazio = sem restrição). */
  components: string[];
  /** Caminhos de import do kit de UI (vazio = sem restrição). */
  uiImportPaths: string[];
}

export interface UiViolation {
  source: string;
  detail: string;
}

/** Sem imposição de design: contrato não-congelado, sem componentes fixos. */
export function extractDesignContract(_projectRoot: string): DesignContract {
  return { frozen: false, components: [], uiImportPaths: [] };
}

/** Auditoria desativada: o modelo do usuário decide a UI, nunca acusa violação. */
export function auditUiUsage(_code: string, _contract: DesignContract): UiViolation[] {
  return [];
}
