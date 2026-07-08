/**
 * Editor de configs CURADAS do REPL (`/config`). Expõe um conjunto MÍNIMO de
 * settings que (a) existem de verdade num repo/setter persistido e (b) fazem
 * sentido headless. Cada item é um enum simples (Selector-driven): `get()` lê o
 * valor real e `set(v)` persiste pelo mesmo caminho que a GUI usa.
 *
 * O Forge está DESLIGADO no headless — nenhuma opção de Forge é exposta aqui.
 *
 * Fontes reais:
 *   - permission mode → permission.ts (estado de processo da CLI).
 *   - performance preset → SettingsRepository.performance.preset.
 *   - model routing mode → SettingsRepository.aiRouting.mode.
 *   - autonomia do agente ativo → AgentRepository runtimeConfig.autonomyLevel.
 */
import {
  PERMISSION_MODE_VALUES,
  getPermissionMode,
  setPermissionMode,
  type PermissionMode,
} from './permission';
import { SettingsRepository } from '../db/repositories/settings.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import { getPerformancePreset } from '../services/performance-preset';
import { PERFORMANCE_PRESETS, type PerformancePreset } from '../../shared/performance-presets';
import type { HybridModelRoutingMode } from '../../shared/types';

export interface EditableConfig {
  key: string;
  label: string;
  kind: 'enum';
  options: string[];
  get(): string;
  set(v: string): void;
}

/** Modos de permissão expostos — a fonte canônica de permission.ts. */
const PERMISSION_OPTIONS: readonly PermissionMode[] = PERMISSION_MODE_VALUES;

/**
 * Modos de roteamento expostos — espelha ROUTING_MODES do AgentBehaviorPanel da
 * GUI (exclui 'off' de propósito; desligar roteamento é via toggle, não modo).
 */
const ROUTING_MODE_OPTIONS: HybridModelRoutingMode[] = [
  'observe',
  'ask',
  'local_assist',
  'local_first',
];

/** Níveis de autonomia do agente (runtimeConfig.autonomyLevel). */
const AUTONOMY_OPTIONS = ['low', 'medium', 'high'] as const;
type AutonomyLevel = (typeof AUTONOMY_OPTIONS)[number];

/**
 * Configs editáveis pelo `/config`. `agentId` é o agente ATIVO do REPL — a
 * autonomia é editada nesse agente (o item de autonomia some quando não há
 * agente ativo, evitando um setter sem alvo).
 */
export function listEditableConfigs(workspaceId: string, agentId?: string): EditableConfig[] {
  const settingsRepo = new SettingsRepository();
  const agentRepo = new AgentRepository();

  const configs: EditableConfig[] = [
    {
      key: 'permissionMode',
      label: 'Modo de permissão',
      kind: 'enum',
      options: [...PERMISSION_OPTIONS],
      get: () => getPermissionMode(),
      set: (v) => {
        // Estado de processo + persistência na chave `daemon` — mesmo contrato
        // do `/permissions`/Shift+Tab do REPL (o próximo boot carrega).
        setPermissionMode(v as PermissionMode);
        settingsRepo.setDaemonPermissionMode(v);
      },
    },
    {
      key: 'performancePreset',
      label: 'Preset de desempenho',
      kind: 'enum',
      options: [...PERFORMANCE_PRESETS],
      get: () => getPerformancePreset(),
      set: (v) => {
        settingsRepo.update({ performance: { preset: v as PerformancePreset } });
      },
    },
    {
      key: 'routingMode',
      label: 'Modo de roteamento de modelo',
      kind: 'enum',
      options: [...ROUTING_MODE_OPTIONS],
      get: () => settingsRepo.get().aiRouting.mode,
      set: (v) => {
        // `settings:update` torna só as CHAVES DE TOPO opcionais — aiRouting tem
        // que ir COMPLETO. Lê o atual e troca só o mode (igual updateAiRouting da GUI).
        const current = settingsRepo.get().aiRouting;
        settingsRepo.update({ aiRouting: { ...current, mode: v as HybridModelRoutingMode } });
      },
    },
  ];

  if (agentId) {
    configs.push({
      key: 'agentAutonomy',
      label: 'Autonomia do agente ativo',
      kind: 'enum',
      options: [...AUTONOMY_OPTIONS],
      get: () => {
        const rc = (agentRepo.get(agentId)?.runtimeConfig ?? {}) as {
          autonomyLevel?: AutonomyLevel;
        };
        return rc.autonomyLevel ?? 'medium';
      },
      set: (v) => {
        const current = agentRepo.get(agentId);
        if (!current) return;
        agentRepo.update(agentId, {
          runtimeConfig: { ...(current.runtimeConfig ?? {}), autonomyLevel: v as AutonomyLevel },
        });
      },
    });
  }

  // workspaceId fica disponível pra futuras configs escopadas; hoje as configs
  // curadas são de processo (permission) ou globais (settings/agent).
  void workspaceId;

  return configs;
}
