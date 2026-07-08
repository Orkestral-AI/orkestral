/**
 * Gerencia o dev server de PREVIEW por workspace (1 por workspace). Reusa o preview-launcher
 * e a preview-policy do motor-v2, mas liga isso ao caminho de board (botão Play na UI + auto
 * detecção de "ficou runnable"). O processo do dev server roda detached; este manager guarda o
 * handle pra parar no stop/quit e evitar órfão.
 */
import * as net from 'node:net';

import { broadcast as hostBroadcast } from '../platform/host';

import { launchPreview, type PreviewHandle } from './engine-v2/preview-launcher';
import { planPreview } from './engine-v2/preview-policy';
import { WorkspaceSourceRepository } from '../db/repositories/workspace-source.repo';

interface PreviewState {
  handle: PreviewHandle;
  url: string;
}

export interface PreviewStatus {
  running: boolean;
  url: string | null;
  runnable: boolean;
  reason?: string;
}

const active = new Map<string, PreviewState>();
// Start em andamento por workspace: 2 cliques no Play não sobem 2 dev servers.
const pending = new Map<string, Promise<PreviewStatus>>();
// Workspaces que já tiveram o "preview disponível" anunciado no chat (1x por sessão de app).
const announced = new Set<string>();
const sourceRepo = new WorkspaceSourceRepository();

// Teto de espera pelo dev server aceitar conexão (npm + boot do framework; a porta
// abre bem antes do primeiro compile terminar).
const BOOT_TIMEOUT_MS = 45_000;
const BOOT_POLL_INTERVAL_MS = 400;

/** Uma tentativa de conexão TCP na porta (127.0.0.1). true = tem alguém ouvindo. */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

/**
 * Espera o dev server ACEITAR conexão antes de reportar running — sem isto o webview
 * carrega antes da porta abrir e o usuário vê tela branca/erro. Aborta cedo se o
 * processo morrer (crash de compile, dep faltando).
 */
async function waitForServer(port: number, handle: PreviewHandle): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (handle.exited) return false;
    if (await probePort(port)) return true;
    await new Promise((r) => setTimeout(r, BOOT_POLL_INTERVAL_MS));
  }
  return false;
}

function broadcast(workspaceId: string): void {
  hostBroadcast('preview:changed', { workspaceId });
}

function resolveRoot(workspaceId: string, projectRoot?: string): string | null {
  if (projectRoot) return projectRoot;
  const primary = sourceRepo.getPrimary(workspaceId);
  return primary?.path ?? null;
}

/** Status quando não há pasta local: distingue github-sem-clone de sem-projeto, pra a UI dar contexto. */
function noRootStatus(workspaceId: string): PreviewStatus {
  const primary = sourceRepo.getPrimary(workspaceId);
  const reason =
    primary?.kind === 'github_repo'
      ? 'Repo do GitHub conectado sem clone local. Clone na aba Fontes pra usar o preview.'
      : 'Sem pasta de projeto local pra rodar.';
  return { running: false, url: null, runnable: false, reason };
}

/** Porta determinística por workspace (3000-3999) pra previews de workspaces diferentes não colidirem. */
function portFor(workspaceId: string): number {
  let h = 0;
  for (let i = 0; i < workspaceId.length; i++) h = (h * 31 + workspaceId.charCodeAt(i)) | 0;
  return 3000 + (Math.abs(h) % 1000);
}

export function getPreviewStatus(workspaceId: string, projectRoot?: string): PreviewStatus {
  const live = active.get(workspaceId);
  if (live) return { running: true, url: live.url, runnable: true };
  const root = resolveRoot(workspaceId, projectRoot);
  if (!root) return noRootStatus(workspaceId);
  const plan = planPreview({ projectRoot: root, port: portFor(workspaceId) });
  return { running: false, url: plan.url, runnable: plan.runnable, reason: plan.reason };
}

export function startPreview(workspaceId: string, projectRoot?: string): Promise<PreviewStatus> {
  const inFlight = pending.get(workspaceId);
  if (inFlight) return inFlight;
  const p = doStartPreview(workspaceId, projectRoot).finally(() => pending.delete(workspaceId));
  pending.set(workspaceId, p);
  return p;
}

async function doStartPreview(workspaceId: string, projectRoot?: string): Promise<PreviewStatus> {
  const live = active.get(workspaceId);
  if (live) return { running: true, url: live.url, runnable: true };
  const root = resolveRoot(workspaceId, projectRoot);
  if (!root) return noRootStatus(workspaceId);
  const plan = planPreview({ projectRoot: root, port: portFor(workspaceId) });
  if (!plan.runnable || !plan.url) {
    return { running: false, url: null, runnable: false, reason: plan.reason };
  }
  const handle = launchPreview(root, plan);
  if (!handle?.url) {
    return { running: false, url: null, runnable: false, reason: 'Falha ao subir o dev server.' };
  }
  // Dev server morreu por conta própria (crash de compile, porta roubada): tira do Map e
  // avisa a UI — senão o card mente "rodando" pra sempre com um processo morto.
  handle.onExit(() => {
    const current = active.get(workspaceId);
    if (current?.handle === handle) {
      active.delete(workspaceId);
      broadcast(workspaceId);
    }
  });
  // Só reporta running quando a porta REALMENTE aceita conexão. Antes disso o webview
  // carregava um connection-refused e o usuário via tela branca.
  const port = Number(new URL(handle.url).port) || portFor(workspaceId);
  const up = await waitForServer(port, handle);
  if (!up) {
    handle.stop();
    return {
      running: false,
      url: null,
      runnable: true,
      reason: handle.exited
        ? 'O dev server morreu ao subir (erro de build/dependência). Veja o projeto e tente de novo.'
        : 'O dev server não respondeu a tempo. Tente de novo.',
    };
  }
  active.set(workspaceId, { handle, url: handle.url });
  broadcast(workspaceId);
  return { running: true, url: handle.url, runnable: true };
}

export function stopPreview(workspaceId: string): void {
  const live = active.get(workspaceId);
  if (!live) return;
  try {
    live.handle.stop();
  } catch {
    /* já morreu */
  }
  active.delete(workspaceId);
  // Mantém o Set `announced` sincronizado (sem isto cresce sem limite com os workspaces).
  announced.delete(workspaceId);
  broadcast(workspaceId);
}

/** Mata todos os dev servers. Chamado no before-quit pra não deixar processo órfão. */
export function stopAllPreviews(): void {
  for (const state of active.values()) {
    try {
      state.handle.stop();
    } catch {
      /* já morreu */
    }
  }
  active.clear();
}

/**
 * Best-effort: quando uma issue fecha e o projeto VIROU runnable, devolve true UMA vez (por
 * sessão de app) pro caller anunciar "Preview disponível" no chat. NÃO sobe o server sozinho,
 * o usuário inicia pelo botão Play, mas o card aparece e o broadcast acende a UI.
 */
export function shouldAnnouncePreview(workspaceId: string): boolean {
  if (announced.has(workspaceId) || active.has(workspaceId)) return false;
  const root = resolveRoot(workspaceId);
  if (!root) return false;
  const plan = planPreview({ projectRoot: root });
  if (!plan.runnable) return false;
  announced.add(workspaceId);
  broadcast(workspaceId);
  return true;
}
