import { eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { settings } from '../schema';
import type { SettingsRecord } from '../../../shared/types';
import { DEFAULT_PERFORMANCE_PRESET } from '../../../shared/performance-presets';

const SETTINGS_KEY = 'app';

/**
 * Chave dedicada (separada do blob `app` da GUI) que guarda o estado do daemon
 * headless — o workspace ativo escolhido pelo `orkestral init` e o modo de
 * permissão escolhido no REPL (`/permissions`/Shift+Tab). Fica no mesmo
 * key-value `settings` (sem tabela/migration nova) e isolada das settings
 * tipadas da UI pra não esbarrar no merge defensivo de `SettingsRecord`.
 */
const DAEMON_KEY = 'daemon';

interface DaemonState {
  activeWorkspaceId: string | null;
  /**
   * Modo de permissão persistido pela CLI (string crua — quem valida contra os
   * modos reais é o consumidor, com `isPermissionMode`; o repo não importa da
   * camada de CLI). `null` = nunca escolhido, fica no default do processo.
   */
  permissionMode: string | null;
}

const DEFAULT_DAEMON_STATE: DaemonState = { activeWorkspaceId: null, permissionMode: null };

const DEFAULT_SETTINGS: SettingsRecord = {
  appearance: {
    theme: 'dark',
    language: 'system',
    fontSize: 'md',
    density: 'comfortable',
    accentColor: 'purple',
    extraWideChat: false,
    codeBlockWrap: true,
    codeTheme: 'default',
  },
  system: {
    launchOnStartup: false,
    notifications: true,
    notificationSound: true,
    inboxNotifications: true,
    timeFormat: '24h',
    showAppIn: 'dock-and-status',
    hardwareAcceleration: true,
  },
  privacy: {
    localTelemetry: true,
    cloudSync: false,
    maskSecrets: true,
    blockSensitiveFiles: true,
    askBeforeExternalContext: true,
    privateMode: false,
  },
  aiRouting: {
    // LOCAL-FIRST out-of-the-box: roteamento LIGADO, modo local_first, risco ALTO —
    // o Forge assume o trabalho elegível sozinho, sem o usuário configurar nada.
    // Sincronia OBRIGATÓRIA com DEFAULT_AI_ROUTING_SETTINGS (model-routing-policy.ts).
    enabled: true,
    mode: 'local_first',
    localModelRequired: true,
    preserveCliContext: true,
    requireApprovalForLocal: false,
    maxLocalRisk: 'high',
    preferLocalPhases: [
      'source_classification',
      'kb_coverage',
      'kb_summary',
      'rag_search',
      'rag_rerank',
      'agent_assignment',
      'cleanup_suggestion',
    ],
    // Fallback premium LIGADO por padrão: o Forge tenta local primeiro (economia),
    // mas o premium é a rede que garante que o trabalho TERMINA. Este é o default
    // LIDO EM RUNTIME (settingsRepo.get().aiRouting) — tem que casar com
    // DEFAULT_AI_ROUTING_SETTINGS (model-routing-policy.ts).
    allowPremiumFallback: true,
    // Comportamento do agente: nº de tentativas locais antes de cair pro premium.
    localAttemptsBeforeFallback: 2,
  },
  knowledge: {
    autoApproveTrainingExamples: false,
    autoApprovalMinScore: 0.72,
  },
  audio: {
    inputDeviceId: null,
    outputDeviceId: null,
  },
  performance: {
    preset: DEFAULT_PERFORMANCE_PRESET,
  },
};

function nowIso(): string {
  return new Date().toISOString();
}

export class SettingsRepository {
  get(): SettingsRecord {
    const db = getDatabase();
    const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
    if (!row) {
      this.replace(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    // Merge defensivo com os defaults: instalações antigas podem não ter
    // campos novos (ex: appearance.language). Garante que toda chave exista.
    const stored = row.value as Partial<SettingsRecord>;
    return {
      appearance: { ...DEFAULT_SETTINGS.appearance, ...(stored.appearance ?? {}) },
      system: { ...DEFAULT_SETTINGS.system, ...(stored.system ?? {}) },
      privacy: { ...DEFAULT_SETTINGS.privacy, ...(stored.privacy ?? {}) },
      audio: { ...DEFAULT_SETTINGS.audio, ...(stored.audio ?? {}) },
      aiRouting: { ...DEFAULT_SETTINGS.aiRouting, ...(stored.aiRouting ?? {}) },
      knowledge: { ...DEFAULT_SETTINGS.knowledge, ...(stored.knowledge ?? {}) },
      performance: { ...DEFAULT_SETTINGS.performance, ...(stored.performance ?? {}) },
    };
  }

  update(patch: Partial<SettingsRecord>): SettingsRecord {
    const current = this.get();
    const next: SettingsRecord = {
      appearance: { ...current.appearance, ...(patch.appearance ?? {}) },
      system: { ...current.system, ...(patch.system ?? {}) },
      privacy: { ...current.privacy, ...(patch.privacy ?? {}) },
      audio: { ...current.audio, ...(patch.audio ?? {}) },
      aiRouting: { ...current.aiRouting, ...(patch.aiRouting ?? {}) },
      knowledge: { ...current.knowledge, ...(patch.knowledge ?? {}) },
      performance: { ...current.performance, ...(patch.performance ?? {}) },
    };
    this.replace(next);
    return next;
  }

  /**
   * Id do workspace ativo do daemon headless (persistido pelo `orkestral init`).
   * `null` quando o init nunca rodou — aí o CLI cai no primeiro workspace.
   */
  getDaemonActiveWorkspaceId(): string | null {
    return this.getDaemonState().activeWorkspaceId;
  }

  setDaemonActiveWorkspaceId(workspaceId: string | null): void {
    this.patchDaemonState({ activeWorkspaceId: workspaceId });
  }

  /**
   * Modo de permissão persistido pela CLI (`/permissions`/Shift+Tab do REPL).
   * `null` = nunca escolhido. Devolve a string crua — validar com
   * `isPermissionMode` no consumo.
   */
  getDaemonPermissionMode(): string | null {
    return this.getDaemonState().permissionMode;
  }

  setDaemonPermissionMode(mode: string | null): void {
    this.patchDaemonState({ permissionMode: mode });
  }

  /** Blob `daemon` completo, com defaults pra instalações antigas. 1 SELECT por PK. */
  private getDaemonState(): DaemonState {
    const db = getDatabase();
    const row = db.select().from(settings).where(eq(settings.key, DAEMON_KEY)).get();
    if (!row) return { ...DEFAULT_DAEMON_STATE };
    const stored = row.value as Partial<DaemonState>;
    return {
      activeWorkspaceId: stored.activeWorkspaceId ?? null,
      permissionMode: stored.permissionMode ?? null,
    };
  }

  /**
   * Read-modify-write do blob `daemon`: um patch de UMA chave preserva as
   * outras (setar o workspace não pode apagar o permissionMode e vice-versa).
   * Ação rara de CLI — 2 queries por PK não é hot path.
   */
  private patchDaemonState(patch: Partial<DaemonState>): void {
    const db = getDatabase();
    const value: DaemonState = { ...this.getDaemonState(), ...patch };
    db.insert(settings)
      .values({ key: DAEMON_KEY, value, updatedAt: nowIso() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: nowIso() },
      })
      .run();
  }

  private replace(value: SettingsRecord): void {
    const db = getDatabase();
    db.insert(settings)
      .values({ key: SETTINGS_KEY, value, updatedAt: nowIso() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: nowIso() },
      })
      .run();
  }
}
