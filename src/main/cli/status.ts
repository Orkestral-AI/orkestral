import { join } from 'node:path';
import { appInfo } from '../platform/host';
import { ORKESTRAL_DB_DIR } from '../db/connection';
import { ChannelRepository } from '../db/repositories/channel.repo';
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import { AgentRepository } from '../db/repositories/agent.repo';

export interface DaemonStatus {
  version: string;
  dbPath: string;
  workspace: { id: string; name: string } | null;
  agent: { name: string; adapter: string; model: string | null } | null;
  channels: { type: string; status: string }[];
}

/**
 * Reúne o estado do daemon (versão, banco, workspace ativo, agente orquestrador
 * e canais) pro cockpit/status do CLI. Lê dos repos reais — não dispara efeitos.
 *
 * `activeWorkspaceId` vem da escolha de workspace do daemon. Quando nulo (ou o id
 * não existe mais), `workspace`/`agent` ficam nulos.
 */
export function collectStatus(activeWorkspaceId: string | null): DaemonStatus {
  const dbPath = join(ORKESTRAL_DB_DIR, 'orkestral.db');

  const channels = new ChannelRepository().listAccounts().map((account) => ({
    type: account.channelType,
    status: account.status,
  }));

  const workspaceRow = activeWorkspaceId
    ? (new WorkspaceRepository().listAll().find((w) => w.id === activeWorkspaceId) ?? null)
    : null;

  let agent: DaemonStatus['agent'] = null;
  if (workspaceRow) {
    // Orquestrador primeiro (listByWorkspace ordena ele no topo); é o agente
    // "rosto" do workspace no cockpit. Sem orquestrador, cai pro primeiro agente.
    const agents = new AgentRepository().listByWorkspace(workspaceRow.id);
    const chosen = agents.find((a) => a.isOrchestrator) ?? agents[0] ?? null;
    if (chosen) {
      agent = {
        name: chosen.name,
        adapter: chosen.adapterType ?? 'unknown',
        model: chosen.model ?? null,
      };
    }
  }

  return {
    version: appInfo.version(),
    dbPath,
    workspace: workspaceRow ? { id: workspaceRow.id, name: workspaceRow.name } : null,
    agent,
    channels,
  };
}

/**
 * Snapshot do status em TEXTO alinhado (padEnd) pro `/status` do REPL — vira
 * uma nota multi-linha no transcript, com a primeira linha de título ("status")
 * seguindo o mesmo formato do `/help`. Puro: não lê repo nenhum — quem chama
 * passa o `collectStatus` (com o agente/modelo REAIS do REPL, se quiser) e o
 * modo de permissão atual.
 */
export function formatStatusText(s: DaemonStatus, permissionMode: string): string {
  const rows: [string, string][] = [
    ['workspace', s.workspace?.name ?? '— (rode `orkestral init`)'],
    ['agente', s.agent ? `${s.agent.name} (${s.agent.adapter})` : '—'],
    ['modelo', s.agent?.model ?? 'default'],
    ['permissão', permissionMode],
    [
      'canais',
      s.channels.length > 0
        ? s.channels.map((c) => `${c.type}=${c.status}`).join(' · ')
        : 'nenhum conectado — /channels',
    ],
    ['banco', s.dbPath],
    ['versão', s.version],
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return ['status', ...rows.map(([label, value]) => `  ${label.padEnd(width)}${value}`)].join('\n');
}
