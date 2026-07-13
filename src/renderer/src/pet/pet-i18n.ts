import type { SettingsRecord } from '@shared/types';

/**
 * Mini-dicionário do pet. O i18n do app (useT + JSONs) depende do provider da
 * árvore React do app principal — puxar isso pro bundle do pet arrastaria o
 * runtime inteiro pra meia dúzia de labels. Segue a mesma decisão de idioma
 * das settings ('system' = locale do SO, pt* → pt-BR).
 */

const MESSAGES = {
  'pt-BR': {
    executionDone: 'Concluído',
    executionFailed: 'Falhou',
    sessionReady: 'Sessão pronta',
    sessionReadyDescription: 'Uma nova sessão de chat foi preparada.',
    updateReady: 'Atualização baixada',
    updateReadyDescription: 'Reinicie o Orkestral para aplicar.',
    inboxProposal: 'Proposta nova no Inbox',
    openApp: 'Abrir Orkestral',
    hidePet: 'Ocultar pet',
    openSettings: 'Configurações',
    collapseCards: 'Recolher avisos',
    expandCards: 'Mostrar avisos',
    dismiss: 'Dispensar',
    queued: 'na fila',
  },
  en: {
    executionDone: 'Completed',
    executionFailed: 'Failed',
    sessionReady: 'Session ready',
    sessionReadyDescription: 'A new chat session is ready.',
    updateReady: 'Update downloaded',
    updateReadyDescription: 'Restart Orkestral to apply.',
    inboxProposal: 'New Inbox proposal',
    openApp: 'Open Orkestral',
    hidePet: 'Hide pet',
    openSettings: 'Settings',
    collapseCards: 'Collapse alerts',
    expandCards: 'Show alerts',
    dismiss: 'Dismiss',
    queued: 'queued',
  },
} as const;

/** Chaves do pt-BR, valores string (o `as const` fixa literais por locale). */
export type PetMessages = Record<keyof (typeof MESSAGES)['pt-BR'], string>;

export function petMessages(language: SettingsRecord['appearance']['language']): PetMessages {
  if (language === 'pt-BR') return MESSAGES['pt-BR'];
  if (language === 'en') return MESSAGES.en;
  // 'system': mesma regra do app — locale pt* cai no pt-BR, resto en.
  return navigator.language?.toLowerCase().startsWith('pt') ? MESSAGES['pt-BR'] : MESSAGES.en;
}
