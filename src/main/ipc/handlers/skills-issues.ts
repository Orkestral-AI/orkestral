import { randomUUID } from 'node:crypto';
import { broadcast } from '../../platform/host';
import { registerHandler } from '../register';
import { SkillRepository } from '../../db/repositories/skill.repo';
import { IssueRepository } from '../../db/repositories/issue.repo';
import { ActivityRepository } from '../../db/repositories/activity.repo';
import { IssueRelationsRepository } from '../../db/repositories/issue-relations.repo';
import { RoutineRepository, GoalRepository } from '../../db/repositories/routine-goal.repo';
import { AgentRepository } from '../../db/repositories/agent.repo';
import { ChatSessionRepository } from '../../db/repositories/session.repo';
import { WorkspaceRepository } from '../../db/repositories/workspace.repo';
import { sendMessage, postAgentMessageToSession } from '../../services/chat-service';
import {
  launchGoalVerification,
  maybeAutoVerifyGoal,
} from '../../services/goal-verification-service';
import { readPlanState, type IssuePlanState } from '../../../shared/plan';
import { runRoutine } from '../../services/routine-service';
import { CodeReviewRepository } from '../../db/repositories/code-review.repo';
import type {
  MarketplaceCatalogItem,
  MarketplaceRequiredEnv,
  MarketplaceMcpSecurity,
  ExecutionCheckbox,
} from '../../../shared/types';
import { ALL_MODELS_SCOPE } from '../../../shared/types';
import { toolSecretRepo, mcpSkillSecretKey } from '../../db/repositories/tool-secret.repo';
import { MARKETPLACE_CATALOG } from '../../data/marketplace-catalog';
import { detectCliMcps } from '../../services/cli-mcp-detect';
import { fetchGithubSkills } from '../../services/github-skills';
import {
  runCodeReview,
  postReviewToGithub,
  cancelCodeReview,
  getDiffByFile,
  applyCommentSuggestion,
} from '../../services/code-review-service';
import {
  cancelIssueExecution,
  maybeAutoExecuteIssue,
  startRunnablePlanIssueWave,
} from '../../services/issue-execution-service';

// Dedupe da mensagem "Plano aprovado": o approve-all chama issue:decide-plan 1x por épico, e sem
// isto a confirmação spamava N vezes no chat. Janela curta = a rajada de aprovações conta como uma.
const approvalReportedAt = new Map<string, number>();
function approvalRecentlyReported(sessionId: string): boolean {
  const now = Date.now();
  if (now - (approvalReportedAt.get(sessionId) ?? 0) < 15000) return true;
  approvalReportedAt.set(sessionId, now);
  return false;
}

const skillRepo = new SkillRepository();
const issueRepo = new IssueRepository();
const activityRepo = new ActivityRepository();
const relationsRepo = new IssueRelationsRepository();
const routineRepo = new RoutineRepository();
const goalRepo = new GoalRepository();
const agentRepo = new AgentRepository();
const sessionRepo = new ChatSessionRepository();
const workspaceRepo = new WorkspaceRepository();
const codeReviewRepo = new CodeReviewRepository();

function nowIso(): string {
  return new Date().toISOString();
}

/** Broadcasta uma mudança de issues (inbox/épico refrescam) — janelas + pushBus. */
function broadcastIssuesChanged(workspaceId: string, reason: string): void {
  broadcast('issues:changed-by-mcp', { workspaceId, reason });
}

function normalizeQuery(input?: string): string {
  return (input ?? '').trim().toLowerCase();
}

/** Referência a um secret cifrado (em vez do valor em claro) dentro do config. */
interface SecretRef {
  $secretRef: string;
}

/** Uma credencial é secret a menos que o spec marque `secret: false` (default true). */
function isSecretValue(spec: MarketplaceRequiredEnv | undefined): boolean {
  return spec?.secret !== false;
}

/**
 * Aplica os valores de credenciais coletados na instalação ao spec do MCP:
 *  - valores SECRET (default) são cifrados no secret store; o config guarda só
 *    uma referência (`{ $secretRef }`) em env/headers, e os tokens `{KEY}` em
 *    `mcpServer.args` ficam intactos (resolvidos no spawn). Nunca em claro no .db.
 *  - valores NÃO-secret seguem inline: env[KEY] / header / substituição de args.
 *  - entries marcadas com `asHeader` viram `mcpServer.headers[<header>]`.
 * Retorna uma cópia profunda do config (não muta o catálogo).
 *
 * `secretBundleId` ancora as chaves do secret store (`mcp.<bundle>.<KEY>`) e é
 * persistido no config pra resolução no spawn (ver normalizedMcpServerFromSkill).
 */
function buildInstallConfig(
  item: MarketplaceCatalogItem,
  envValues: Record<string, string> = {},
  secretBundleId: string = randomUUID(),
): Record<string, unknown> {
  const config: Record<string, unknown> = JSON.parse(JSON.stringify(item.install.config ?? {}));
  const server = (config.mcpServer ?? null) as Record<string, unknown> | null;
  const reqByKey = new Map<string, MarketplaceRequiredEnv>();
  for (const r of item.requiredEnv ?? []) reqByKey.set(r.key, r);

  if (server) {
    const env = (server.env ?? {}) as Record<string, unknown>;
    const headers = (server.headers ?? {}) as Record<string, unknown>;
    let args = Array.isArray(server.args) ? (server.args as string[]).slice() : null;
    // Tokens {KEY} em args que devem ser resolvidos no spawn (valor é secret).
    const secretArgs: Record<string, string> = {};
    let usedSecretStore = false;

    for (const [key, rawValue] of Object.entries(envValues)) {
      const value = (rawValue ?? '').trim();
      if (!value) continue;
      const spec = reqByKey.get(key);
      const secret = isSecretValue(spec);
      const storeKey = mcpSkillSecretKey(secretBundleId, key);

      // Tenta cifrar valores secret. Se a cripto não estiver disponível,
      // `set` lança — caímos pro comportamento inline antigo (degradado mas
      // funcional), nunca quebrando o install.
      let ref: SecretRef | null = null;
      if (secret) {
        try {
          toolSecretRepo.set(storeKey, value);
          ref = { $secretRef: storeKey };
          usedSecretStore = true;
        } catch {
          ref = null;
        }
      }

      if (spec?.asHeader) {
        const tpl = spec.headerTemplate ?? '{value}';
        // Header com template e secret: guarda a referência + template; o valor
        // em claro só existe no spawn. Sem secret (ou sem cripto): inline.
        headers[spec.asHeader] =
          ref && tpl === '{value}'
            ? ref
            : ref
              ? { $secretRef: storeKey, template: tpl }
              : tpl.replace('{value}', value);
      } else {
        env[key] = ref ?? value;
      }

      // Templating de args: {KEY} fica intacto e resolve no spawn quando secret;
      // senão substitui o valor inline (comportamento antigo).
      if (args) {
        if (ref) {
          if (args.some((a) => a.includes(`{${key}}`))) secretArgs[key] = storeKey;
        } else {
          args = args.map((a) => a.split(`{${key}}`).join(value));
        }
      }
    }

    if (args) server.args = args;
    server.env = env;
    if (Object.keys(headers).length > 0) server.headers = headers;
    if (Object.keys(secretArgs).length > 0) server.secretArgs = secretArgs;
    if (usedSecretStore) server.secretBundleId = secretBundleId;
  }

  return config;
}

/**
 * Mascara credenciais antes de devolver a skill pro renderer. Valores cifrados
 * (`{ $secretRef }`) viram string vazia — o renderer nunca vê o valor em claro
 * (nem um sentinel que ele reenviaria por engano). Valores ainda inline (skills
 * legadas pré-cifragem) também são mascarados aqui pra não vazarem na UI.
 * Retorna uma cópia (não muta o registro do DB).
 */
function sanitizeSkillForRenderer<T extends { config?: Record<string, unknown> } | null>(
  skill: T,
): T {
  if (!skill || !skill.config) return skill;
  const server = (skill.config as any).mcpServer;
  if (!server || typeof server !== 'object') return skill;
  const clone = JSON.parse(JSON.stringify(skill)) as T & { config: Record<string, unknown> };
  const srv = (clone.config as any).mcpServer as Record<string, unknown>;
  // Sem o catálogo aqui: trata toda entry de env/header de MCP como sensível
  // (o caso comum é credencial). Mascara tanto ref cifrada quanto valor inline.
  const env = srv.env as Record<string, unknown> | undefined;
  if (env) for (const k of Object.keys(env)) if (env[k]) env[k] = '';
  const headers = srv.headers as Record<string, unknown> | undefined;
  if (headers) for (const k of Object.keys(headers)) if (headers[k]) headers[k] = '';
  return clone;
}

/** Lista de model-scopes a habilitar, com fallback pra "todos os modelos". */
function resolveScopes(modelScopes?: string[]): string[] {
  const list = (modelScopes ?? []).filter((s) => typeof s === 'string' && s.trim());
  return list.length > 0 ? Array.from(new Set(list)) : [ALL_MODELS_SCOPE];
}

async function fetchRemoteMarketplace(
  kind: 'skill' | 'mcp',
): Promise<MarketplaceCatalogItem[] | null> {
  const envUrl =
    kind === 'skill'
      ? process.env.ORKESTRAL_MARKETPLACE_SKILLS_API
      : process.env.ORKESTRAL_MARKETPLACE_MCPS_API;
  if (!envUrl) return null;
  try {
    const res = await fetch(envUrl);
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return null;
    return data.filter(Boolean) as MarketplaceCatalogItem[];
  } catch {
    return null;
  }
}

// ---- Registro vivo de MCP (PulseMCP) ------------------------------------
// API pública sem auth: https://api.pulsemcp.com/v0beta/servers
// Retorna 16k+ servers com github_stars, repo (→ logo do owner) e package npm
// (→ instalável via `npx`). Filtramos pros que dão pra instalar de fato.

function slugifyPkg(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

interface PulseServer {
  name?: string;
  url?: string;
  external_url?: string;
  short_description?: string;
  source_code_url?: string | null;
  github_stars?: number | null;
  package_registry?: string | null;
  package_name?: string | null;
  EXPERIMENTAL_ai_generated_description?: string;
}

// ---- Supply-chain: pin de versão + aviso de execução --------------------
// P0-10: MCPs do registro vivo (PulseMCP) são pacotes NÃO auditados. Rodar
// `npx -y <pkg>` baixa e executa código arbitrário, e sem versão pinada cada
// run pode resolver um `latest` diferente (supply-chain attack surface). Aqui:
//  1. resolvemos a versão publicada AGORA no registro (npm/pypi) e pinamos ela
//     no comando — nunca `@latest` implícito;
//  2. anexamos `security` (comando exato + aviso) pra UI confirmar antes de
//     rodar pela primeira vez. Se não der pra resolver a versão, o item NÃO é
//     listável (mesma convenção do `null` abaixo) — não mostramos "Instalar"
//     pra algo que rodaríamos sem pin.

/** Aviso (EN, user-facing) pra confirmação antes da 1ª execução de um MCP de comunidade. */
const COMMUNITY_MCP_RUN_WARNING =
  'This is an unverified community MCP server. Installing and enabling it will download and run third-party code on your machine with your permissions. Only proceed if you trust the source.';

// Cache de versões resolvidas (mesmo TTL do registro vivo). Só guardamos
// resultados DEFINITIVOS (versão achada / pacote inexistente) — falhas
// transientes (429/timeout/rede) não são cacheadas pra não "fixar" um item
// como não-pinável só porque o registro rate-limitou neste momento.
const pkgVersionCache = new Map<string, { version: string | null; ts: number }>();
const PKG_VERSION_TTL_MS = 10 * 60_000;
// Resoluções de versão em voo POR BLOCO cru. Os blocos de uma página rodam em
// paralelo (PULSE_BLOCKS_PER_PAGE), então o teto global ≈ blocos × este número;
// mantemos baixo pra não disparar centenas de fetches ao registro de uma vez.
const PKG_RESOLVE_CONCURRENCY = 6;

/**
 * Resultado de resolução de versão:
 *  - `version: string`  → resolvida e pinável;
 *  - `version: null, transient: false` → pacote não existe / sem versão (definitivo);
 *  - `version: null, transient: true`  → registro indisponível AGORA (429/timeout/rede).
 * O chamador trata `transient` diferente de "não encontrado": rate-limit não
 * deve descartar o item permanentemente nem blankar a listagem inteira.
 */
interface VersionResult {
  version: string | null;
  transient: boolean;
}

/**
 * Concorrência limitada: roda `fn` sobre `items` com no máximo `limit` chamadas
 * em voo. Evita disparar centenas de fetches paralelos ao registro (que o
 * rate-limit silenciaria, blankando a listagem). Preserva a ordem de entrada.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Resolve a versão publicada mais recente de um pacote no registro. Distingue
 * "pacote não existe" (definitivo, cacheável) de "registro indisponível agora"
 * (429/timeout/rede, `transient`) — o chamador não descarta itens transientes.
 */
async function resolveLatestVersion(registry: 'npm' | 'pypi', pkg: string): Promise<VersionResult> {
  const key = `${registry}:${pkg}`;
  const now = Date.now();
  const cached = pkgVersionCache.get(key);
  if (cached && now - cached.ts < PKG_VERSION_TTL_MS)
    return { version: cached.version, transient: false };
  let version: string | null = null;
  try {
    const url =
      registry === 'npm'
        ? `https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`
        : `https://pypi.org/pypi/${pkg}/json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    // 429 (rate-limit) / 5xx ⇒ transiente: não cacheia, não descarta o item.
    if (res.status === 429 || res.status >= 500) return { version: null, transient: true };
    if (res.ok) {
      if (registry === 'npm') {
        const data = (await res.json()) as { version?: string };
        version = typeof data.version === 'string' ? data.version : null;
      } else {
        const data = (await res.json()) as { info?: { version?: string } };
        version = typeof data.info?.version === 'string' ? data.info.version : null;
      }
    }
    // 404 / outro não-ok ⇒ definitivo (pacote inexistente): cacheia `null`.
  } catch {
    // Abort (timeout) / falha de rede ⇒ transiente: não cacheia.
    return { version: null, transient: true };
  }
  pkgVersionCache.set(key, { version, ts: now });
  return { version, transient: false };
}

/**
 * Comando de execução stdio a partir do registro do pacote, com a versão JÁ
 * pinada (sem `@latest` implícito):
 *  - npm  → `npx -y <pkg>@<version>`
 *  - pypi → `uvx <pkg>==<version>` (precisa do `uv`/`uvx` instalado)
 * Retorna null pros registros que não dá pra rodar direto (sem pacote, docker,
 * remote-only) — esses não entram na listagem pra não mostrar "Instalar" furado.
 */
function stdioCommandFor(
  registry: string | null | undefined,
  pkg: string,
  version: string,
): { command: string; args: string[] } | null {
  switch (registry) {
    case 'npm':
      return { command: 'npx', args: ['-y', `${pkg}@${version}`] };
    case 'pypi':
      return { command: 'uvx', args: [`${pkg}==${version}`] };
    default:
      return null;
  }
}

async function pulseToCatalogItem(s: PulseServer): Promise<MarketplaceCatalogItem | null> {
  if (!s.name || !s.package_name) return null;
  const registry = s.package_registry;
  if (registry !== 'npm' && registry !== 'pypi') return null; // sem comando instalável → não lista
  // Pin obrigatório: sem versão resolvida, não listamos (jamais rodamos `latest`).
  // Falha transiente (429/timeout) ≠ "pacote não existe": o item é só pulado
  // neste ciclo (cache não é poluído) e volta no próximo load — não blanka tudo.
  const { version } = await resolveLatestVersion(registry, s.package_name);
  if (!version) return null;
  const cmd = stdioCommandFor(registry, s.package_name, version);
  if (!cmd) return null;
  const exactCommand = [cmd.command, ...cmd.args].join(' ');
  const security: MarketplaceMcpSecurity = {
    registry,
    pkg: s.package_name,
    version,
    command: exactCommand,
    warning: COMMUNITY_MCP_RUN_WARNING,
  };
  const repo = s.source_code_url ?? undefined;
  const ownerMatch = repo?.match(/github\.com\/([^/?#]+)/i);
  const iconUrl = ownerMatch ? `https://github.com/${ownerMatch[1]}.png?size=80` : undefined;
  return {
    id: `pulse.${registry}.${s.package_name}`,
    kind: 'mcp',
    name: s.name,
    slug: slugifyPkg(s.package_name),
    description: s.short_description ?? '',
    longDescription: s.EXPERIMENTAL_ai_generated_description ?? s.short_description ?? '',
    category: 'Community',
    author: ownerMatch?.[1] ?? 'Community',
    iconKey: 'Server',
    iconUrl,
    homepageUrl: s.external_url ?? s.url,
    repoUrl: repo,
    sourceUrl: s.url ?? repo ?? 'https://www.pulsemcp.com',
    provider: 'pulsemcp',
    stars: typeof s.github_stars === 'number' ? s.github_stars : undefined,
    transport: 'stdio',
    security,
    install: {
      skillKind: 'mcp',
      contentTemplate: `# ${s.name}\n\n${s.short_description ?? ''}`,
      config: { mcpServer: { command: cmd.command, args: cmd.args, env: {} } },
    },
  };
}

interface PulsePage {
  items: MarketplaceCatalogItem[];
  hasMore: boolean;
}
const pulseCache = new Map<string, PulsePage & { ts: number }>();
const PULSE_TTL_MS = 10 * 60_000;
// O registro é esparso em pacotes instaláveis (~3 npm/pypi a cada 100). Pra cada
// "página" do app varremos vários blocos crus em paralelo e juntamos os
// instaláveis — assim o infinite scroll adiciona um punhado de cards por vez.
const PULSE_RAW_COUNT = 100;
const PULSE_BLOCKS_PER_PAGE = 5;
const PULSE_FILL = PULSE_RAW_COUNT * PULSE_BLOCKS_PER_PAGE;

/** Um bloco cru do PulseMCP (offset/count), já filtrado pros instaláveis. Cacheado. */
async function fetchPulseRaw(
  query: string | undefined,
  offset: number,
  count = PULSE_RAW_COUNT,
): Promise<PulsePage> {
  const q = (query ?? '').trim().toLowerCase();
  const key = `${q}:${offset}:${count}`;
  const cached = pulseCache.get(key);
  // Date.now() é ok aqui (não estamos num workflow determinístico).
  const now = Date.now();
  if (cached && now - cached.ts < PULSE_TTL_MS)
    return { items: cached.items, hasMore: cached.hasMore };
  const fallback: PulsePage = cached
    ? { items: cached.items, hasMore: cached.hasMore }
    : { items: [], hasMore: false };
  try {
    const url = new URL('https://api.pulsemcp.com/v0beta/servers');
    url.searchParams.set('count_per_page', String(count));
    url.searchParams.set('offset', String(offset));
    if (q) url.searchParams.set('query', q);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Orkestral/0.1 (marketplace)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { servers?: PulseServer[]; next?: string | null };
    const raw = data.servers ?? [];
    // pulseToCatalogItem é async (resolve+pina a versão no registro). Resolve
    // com CONCORRÊNCIA LIMITADA (não 1 fetch por linha em paralelo): um cold load
    // varre vários blocos × ~100 linhas e dispararia centenas de fetches npm/pypi
    // de uma vez, que o rate-limit (429) silenciaria — blankando a listagem.
    const items = (
      await mapWithConcurrency(raw, PKG_RESOLVE_CONCURRENCY, pulseToCatalogItem)
    ).filter((x): x is MarketplaceCatalogItem => x !== null);
    // Bloco cheio (na contagem crua, antes de filtrar) ⇒ tem mais.
    const hasMore = !!data.next || raw.length >= count;
    const page: PulsePage = { items, hasMore };
    pulseCache.set(key, { ...page, ts: now });
    return page;
  } catch {
    return fallback;
  }
}

/**
 * Uma "página" do app = vários blocos crus varridos em paralelo a partir de
 * `startOffset`, juntando os instaláveis. Retorna o cursor cru pra continuar.
 */
async function fetchPulseFill(
  query: string | undefined,
  startOffset: number,
): Promise<{ items: MarketplaceCatalogItem[]; nextOffset: number | null }> {
  const offsets = Array.from(
    { length: PULSE_BLOCKS_PER_PAGE },
    (_, i) => startOffset + i * PULSE_RAW_COUNT,
  );
  const blocks = await Promise.all(offsets.map((o) => fetchPulseRaw(query, o)));
  const items: MarketplaceCatalogItem[] = [];
  const seen = new Set<string>();
  let hasMore = false;
  for (const b of blocks) {
    for (const it of b.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(it);
    }
    hasMore = b.hasMore; // o último bloco define se ainda há mais
  }
  items.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  return { items, nextOffset: hasMore ? startOffset + PULSE_FILL : null };
}

// ---- Helpers compartilhados de listagem ---------------------------------

function matchesQuery(item: MarketplaceCatalogItem, q: string): boolean {
  if (!q) return true;
  const haystack = [
    item.name,
    item.slug,
    item.description,
    item.category ?? '',
    item.author ?? '',
    ...(item.tags ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/** Primeiro argumento "real" do comando (= nome do pacote) pra dedupe. */
function mcpPkgOf(item: MarketplaceCatalogItem): string | null {
  const args = ((item.install.config as any)?.mcpServer?.args ?? []) as string[];
  return args.find((a) => a && !a.startsWith('-')) ?? null;
}

/** Catálogo curado/verificado (+ override opcional por id via env). */
async function curatedFor(kind: 'skill' | 'mcp'): Promise<MarketplaceCatalogItem[]> {
  const byId = new Map<string, MarketplaceCatalogItem>();
  for (const item of MARKETPLACE_CATALOG) if (item.kind === kind) byId.set(item.id, item);
  const envRemote = await fetchRemoteMarketplace(kind);
  for (const item of envRemote ?? []) if (item?.id && item.kind === kind) byId.set(item.id, item);
  return Array.from(byId.values());
}

/**
 * Decide um plano (épica + sub-issues) — MESMA lógica do botão "Aprovar e executar".
 * Aprovar libera as sub-issues do backlog e dispara a onda de execução. Exportado
 * pra ser chamado tanto pelo handler IPC quanto pela tool MCP (o agente aprova/
 * executa por conta própria, ex.: pelo WhatsApp).
 */
export function decidePlan(input: {
  epicIssueId: string;
  decision: 'approve' | 'request_changes' | 'reject';
  note?: string;
  attachments?: import('../../../shared/types').IssueAttachment[];
}): { ok: true; executed: number; cancelled: number } {
  const { epicIssueId, decision, note, attachments } = input;
  const epic = issueRepo.get(epicIssueId);
  if (!epic) throw new Error('Épica não encontrada');

  const children = issueRepo.listChildren(epicIssueId);
  const now = new Date().toISOString();
  const prevMeta = (epic.metadata as Record<string, unknown> | null) ?? {};
  const prevPlan: IssuePlanState | undefined = readPlanState(epic) ?? undefined;
  const sessionId = prevPlan?.sessionId;
  const planStatus =
    decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested';
  issueRepo.update(epicIssueId, {
    metadata: {
      ...prevMeta,
      plan: { ...prevPlan, status: planStatus, decidedAt: now, note: note?.trim() || undefined },
    },
  });

  let executed = 0;
  let cancelled = 0;

  if (decision === 'approve') {
    if (children.length === 0) {
      if (epic.status === 'backlog' || epic.status === 'todo') {
        const ready = issueRepo.update(epic.id, { status: 'todo' });
        if (maybeAutoExecuteIssue(ready)) executed = 1;
      }
    } else {
      for (const child of children) {
        if (child.status === 'done' || child.status === 'cancelled') continue;
        if (child.status === 'backlog') issueRepo.update(child.id, { status: 'todo' });
      }
      executed = startRunnablePlanIssueWave(epic.id);
      if (epic.status !== 'done' && epic.status !== 'cancelled') {
        const live = children.filter((c) => c.status !== 'cancelled');
        const allDone = live.length > 0 && live.every((c) => c.status === 'done');
        issueRepo.update(epicIssueId, { status: allDone ? 'done' : 'in_progress' });
      }
    }
    if (sessionId && !approvalRecentlyReported(sessionId)) {
      try {
        postAgentMessageToSession(
          sessionId,
          '✅ **Plano aprovado.** Execução iniciada, o progresso aparece aqui e em cada issue conforme o time trabalha.',
        );
      } catch (err) {
        console.warn('[decide-plan] falha ao reportar no chat:', err);
      }
    }
    activityRepo.log({
      workspaceId: epic.workspaceId,
      kind: 'plan.approved',
      subjectKind: 'issue',
      subjectId: epic.id,
      title: `Plano aprovado: ${epic.title}`,
      payload: { issueKey: epic.issueKey, childCount: children.length, executed },
    });
  } else if (decision === 'reject') {
    for (const child of children) {
      if (child.status === 'done' || child.status === 'cancelled') continue;
      issueRepo.update(child.id, { status: 'cancelled' });
      cancelled++;
    }
    if (epic.status !== 'done' && epic.status !== 'cancelled') {
      issueRepo.update(epic.id, { status: 'cancelled' });
    }
    if (note?.trim() || (attachments && attachments.length > 0)) {
      issueRepo.addComment({
        issueId: epic.id,
        body: `**Plano recusado.**${note?.trim() ? `\n\n${note.trim()}` : ''}`,
        authorKind: 'user',
        attachments,
      });
    }
    activityRepo.log({
      workspaceId: epic.workspaceId,
      kind: 'plan.rejected',
      subjectKind: 'issue',
      subjectId: epic.id,
      title: `Plano recusado: ${epic.title}`,
      payload: { issueKey: epic.issueKey, cancelled },
    });
  } else {
    if (note?.trim() || (attachments && attachments.length > 0)) {
      issueRepo.addComment({
        issueId: epic.id,
        body: `**Ajustes solicitados no plano:**${note?.trim() ? `\n\n${note.trim()}` : ''}`,
        authorKind: 'user',
        attachments,
      });
    }
    activityRepo.log({
      workspaceId: epic.workspaceId,
      kind: 'plan.changes_requested',
      subjectKind: 'issue',
      subjectId: epic.id,
      title: `Ajustes solicitados no plano: ${epic.title}`,
      payload: { issueKey: epic.issueKey, note: note?.trim() ?? null },
    });
  }

  broadcastIssuesChanged(epic.workspaceId, `plan-${decision}`);
  return { ok: true as const, executed, cancelled };
}

/** Épica de plano PENDENTE de aprovação criada por uma sessão de chat (ou null). */
export function findPendingPlanEpicId(workspaceId: string, sessionId: string): string | null {
  for (const i of issueRepo.listByWorkspace(workspaceId)) {
    const p = readPlanState(i);
    if (p?.status === 'pending' && p.sessionId === sessionId) return i.id;
  }
  return null;
}

export function registerSkillsIssuesHandlers(): void {
  // -------- Skills --------
  registerHandler('skill:list', ({ workspaceId }) =>
    skillRepo.listByWorkspace(workspaceId).map(sanitizeSkillForRenderer),
  );
  registerHandler('skill:get', ({ skillId }) => sanitizeSkillForRenderer(skillRepo.get(skillId)));
  registerHandler('skill:create', (input) => sanitizeSkillForRenderer(skillRepo.create(input)));
  registerHandler('skill:update', ({ skillId, patch }) =>
    sanitizeSkillForRenderer(skillRepo.update(skillId, patch)),
  );
  registerHandler('skill:delete', ({ skillId }) => {
    skillRepo.delete(skillId);
    return { ok: true as const };
  });
  registerHandler('skill:list-by-agent', ({ agentId }) =>
    skillRepo.listByAgent(agentId).map(sanitizeSkillForRenderer),
  );
  registerHandler('skill:attach', ({ agentId, skillId }) => {
    skillRepo.attach(agentId, skillId);
    return { ok: true as const };
  });
  registerHandler('skill:detach', ({ agentId, skillId }) => {
    skillRepo.detach(agentId, skillId);
    return { ok: true as const };
  });

  // Lista simples (sem paginação) — usada por consumidores como o gerenciador
  // de instalados. MCPs só consultam o registro vivo quando há query.
  registerHandler('marketplace:list', async ({ kind, query }) => {
    const q = normalizeQuery(query);
    const curated = await curatedFor(kind);
    let community: MarketplaceCatalogItem[] = [];
    if (kind === 'mcp' && q) {
      const curatedPkgs = new Set(curated.map(mcpPkgOf).filter(Boolean) as string[]);
      const curatedIds = new Set(curated.map((i) => i.id));
      const fill = await fetchPulseFill(query, 0);
      community = fill.items.filter(
        (i) => !curatedIds.has(i.id) && !curatedPkgs.has(mcpPkgOf(i) ?? ''),
      );
    } else if (kind === 'skill') {
      const curatedIds = new Set(curated.map((i) => i.id));
      community = (await fetchGithubSkills()).filter((i) => !curatedIds.has(i.id));
    }
    return [
      ...curated.filter((i) => matchesQuery(i, q)),
      ...community.filter((i) => matchesQuery(i, q)),
    ];
  });

  // Versão paginada pra infinite scroll. Página 0 = curados + 1ª página da
  // comunidade; páginas seguintes = só comunidade (registro vivo PulseMCP).
  registerHandler('marketplace:browse', async ({ kind, query, offset = 0 }) => {
    const q = normalizeQuery(query);
    const curated = await curatedFor(kind);

    if (kind !== 'mcp') {
      // Skills: catálogo curado + repos do GitHub (anthropics/skills). Tudo cabe
      // na página 0 (não há registro paginável como o de MCP).
      if (offset !== 0) return { items: [], nextOffset: null };
      const curatedIds = new Set(curated.map((i) => i.id));
      const community = (await fetchGithubSkills()).filter((i) => !curatedIds.has(i.id));
      return {
        items: [...curated, ...community].filter((i) => matchesQuery(i, q)),
        nextOffset: null,
      };
    }

    const curatedPkgs = new Set(curated.map(mcpPkgOf).filter(Boolean) as string[]);
    const curatedIds = new Set(curated.map((i) => i.id));
    const fill = await fetchPulseFill(query, offset);
    const community = fill.items
      .filter((i) => !curatedIds.has(i.id) && !curatedPkgs.has(mcpPkgOf(i) ?? ''))
      .filter((i) => matchesQuery(i, q));

    const items =
      offset === 0 ? [...curated.filter((i) => matchesQuery(i, q)), ...community] : community;
    return { items, nextOffset: fill.nextOffset };
  });

  // Detecta MCPs já configurados nos CLIs (Claude, Codex, Gemini, Cursor).
  registerHandler('marketplace:detect-cli', () => detectCliMcps());

  registerHandler('marketplace:install', ({ workspaceId, item, env, modelScopes }) => {
    const now = nowIso();
    const scopes = resolveScopes(modelScopes);
    const marketplaceMeta = {
      id: item.id,
      kind: item.kind,
      sourceUrl: item.sourceUrl,
      category: item.category,
      iconKey: item.iconKey,
      transport: item.transport,
      // P0-10: MCP de comunidade carrega o comando exato (versão pinada) + aviso
      // de execução. Persistido pra UI confirmar antes da primeira execução.
      ...(item.security ? { security: item.security } : {}),
    };

    const current = skillRepo
      .listByWorkspace(workspaceId)
      .find((s) => (s.config as any)?.marketplace?.id === item.id);

    // Re-install reaproveita o bundle de secrets existente (chaves estáveis);
    // primeira instalação gera um novo. Se `env` não traz a credencial de novo,
    // o secret já guardado permanece válido.
    const existingBundleId = (current?.config as any)?.mcpServer?.secretBundleId as
      | string
      | undefined;
    const installConfig = buildInstallConfig(item, env, existingBundleId);

    if (!current) {
      const created = skillRepo.create({
        workspaceId,
        name: item.name,
        kind: item.install.skillKind,
        description: item.description,
        content: item.install.contentTemplate,
        config: {
          ...installConfig,
          marketplace: {
            ...marketplaceMeta,
            modelInstalls: scopes.map((modelScope) => ({ modelScope, installedAt: now })),
          },
        },
      });
      // Skills de INSTRUÇÃO só têm efeito se atachadas a um agente. A atribuição
      // agora é feita pelo AssignAgentsDialog logo após o install (default: todos
      // os agentes marcados), então NÃO auto-atacha aqui — evita ligar em agente
      // que o usuário desmarcaria. MCPs entram via modelScope, sem attach.
      return sanitizeSkillForRenderer(created);
    }

    // Já instalado: faz merge dos scopes e atualiza credenciais/config.
    const conf = (current.config as any) ?? {};
    const mk = conf.marketplace ?? marketplaceMeta;
    const installs = Array.isArray(mk.modelInstalls) ? mk.modelInstalls : [];
    const merged = [...installs];
    for (const modelScope of scopes) {
      if (!merged.some((x: any) => x?.modelScope === modelScope)) {
        merged.push({ modelScope, installedAt: now });
      }
    }

    return sanitizeSkillForRenderer(
      skillRepo.update(current.id, {
        description: item.description,
        config: {
          ...conf,
          ...installConfig,
          marketplace: { ...marketplaceMeta, ...mk, modelInstalls: merged },
        },
      }),
    );
  });

  registerHandler('marketplace:uninstall', ({ skillId, modelScope }) => {
    const current = skillRepo.get(skillId);
    if (!current) return { ok: true as const };
    // Sem scope (ou scope "todos") → desinstala completamente.
    if (!modelScope || modelScope === ALL_MODELS_SCOPE) {
      skillRepo.delete(skillId);
      return { ok: true as const };
    }

    const conf = (current.config as any) ?? {};
    const mk = conf.marketplace ?? {};
    const installs = Array.isArray(mk.modelInstalls) ? mk.modelInstalls : [];
    const next = installs.filter((x: any) => x?.modelScope !== modelScope);
    if (next.length === 0) {
      skillRepo.delete(skillId);
      return { ok: true as const };
    }

    skillRepo.update(skillId, {
      config: {
        ...conf,
        marketplace: { ...mk, modelInstalls: next },
      },
    });
    return { ok: true as const };
  });

  registerHandler('marketplace:set-model-scopes', ({ skillId, modelScopes }) => {
    const current = skillRepo.get(skillId);
    if (!current) throw new Error('Skill não encontrada');
    const conf = (current.config as any) ?? {};
    const mk = conf.marketplace ?? {};
    const scopes = resolveScopes(modelScopes);
    return sanitizeSkillForRenderer(
      skillRepo.update(skillId, {
        config: {
          ...conf,
          marketplace: {
            ...mk,
            modelInstalls: scopes.map((scope) => ({ modelScope: scope, installedAt: nowIso() })),
          },
        },
      }),
    );
  });

  // Atualiza credenciais (env) e/ou model-scopes de um item já instalado.
  registerHandler('marketplace:configure', ({ skillId, env, modelScopes }) => {
    const current = skillRepo.get(skillId);
    if (!current) throw new Error('Skill não encontrada');
    const conf = (current.config as any) ?? {};
    const mk = conf.marketplace ?? {};

    const patch: { config: Record<string, unknown> } = { config: { ...conf } };

    // Re-aplica env sobre o spec atual do server (sem perder command/args/url).
    if (env && conf.mcpServer) {
      const reqByKey = new Map<string, MarketplaceRequiredEnv>();
      const catalogItem = MARKETPLACE_CATALOG.find((i) => i.id === mk.id);
      for (const r of catalogItem?.requiredEnv ?? []) reqByKey.set(r.key, r);
      const server = { ...(conf.mcpServer as Record<string, unknown>) };
      const nextEnv = { ...((server.env as Record<string, unknown>) ?? {}) };
      const nextHeaders = { ...((server.headers as Record<string, unknown>) ?? {}) };
      // Reaproveita o bundle de secrets já ancorado no skill (ou cria um).
      const bundleId =
        (typeof server.secretBundleId === 'string' && server.secretBundleId) || randomUUID();
      let usedSecretStore = typeof server.secretBundleId === 'string';
      for (const [key, rawValue] of Object.entries(env)) {
        const value = (rawValue ?? '').trim();
        const spec = reqByKey.get(key);
        const secret = isSecretValue(spec);
        const storeKey = mcpSkillSecretKey(bundleId, key);
        // Cifra valores secret (config fica só com a referência). Cripto
        // indisponível → fallback inline (degradado, mas não quebra o save).
        let ref: SecretRef | null = null;
        if (value && secret) {
          try {
            toolSecretRepo.set(storeKey, value);
            ref = { $secretRef: storeKey };
            usedSecretStore = true;
          } catch {
            ref = null;
          }
        }
        if (spec?.asHeader) {
          if (!value) {
            delete nextHeaders[spec.asHeader];
            if (secret) toolSecretRepo.clear(storeKey);
          } else if (ref) {
            const tpl = spec.headerTemplate ?? '{value}';
            nextHeaders[spec.asHeader] =
              tpl === '{value}' ? ref : { $secretRef: storeKey, template: tpl };
          } else {
            nextHeaders[spec.asHeader] = (spec.headerTemplate ?? '{value}').replace(
              '{value}',
              value,
            );
          }
        } else if (value) {
          nextEnv[key] = ref ?? value;
        } else {
          delete nextEnv[key];
          if (secret) toolSecretRepo.clear(storeKey);
        }
      }
      server.env = nextEnv;
      if (Object.keys(nextHeaders).length > 0) server.headers = nextHeaders;
      if (usedSecretStore) server.secretBundleId = bundleId;
      patch.config.mcpServer = server;
    }

    if (modelScopes) {
      const scopes = resolveScopes(modelScopes);
      patch.config.marketplace = {
        ...mk,
        modelInstalls: scopes.map((scope) => ({ modelScope: scope, installedAt: nowIso() })),
      };
    }

    return sanitizeSkillForRenderer(skillRepo.update(skillId, patch));
  });

  // -------- Issues --------
  registerHandler('issue:list', ({ workspaceId, status, assigneeAgentId }) => {
    // Rollup lazy: conclui épicas cujos filhos já terminaram.
    issueRepo.syncAllEpics(workspaceId);
    // Issues efêmeras (mudança pontual run="now") NÃO aparecem no board — o resultado volta
    // no chat. O usuário pediu "nem abre issue".
    return issueRepo
      .listByWorkspace(workspaceId, { status, assigneeAgentId })
      .filter((i) => (i.metadata as { ephemeral?: boolean } | null)?.ephemeral !== true);
  });
  registerHandler('issue:get', ({ issueId }) => issueRepo.get(issueId));
  registerHandler('issue:children', ({ parentIssueId }) => issueRepo.listChildren(parentIssueId));
  // Marca/desmarca um checkbox da checklist de execução (componente Tasks da issue).
  registerHandler('issue:complete-checkbox', ({ issueId, checkboxId, status }) => {
    const issue = issueRepo.get(issueId);
    if (!issue) throw new Error('issue não encontrada');
    const meta = issue.metadata as { kind?: string; checkboxes?: ExecutionCheckbox[] } | null;
    if (!meta || meta.kind !== 'execution-plan' || !Array.isArray(meta.checkboxes)) {
      throw new Error('essa issue não tem checklist de execução');
    }
    const checkboxes = meta.checkboxes.map((c) =>
      c.id === checkboxId
        ? { ...c, status, completedAt: status === 'done' ? nowIso() : c.completedAt }
        : c,
    );
    // done = tudo concluído; blocked = nada pendente mas algo travado; senão in_progress.
    const allDone = checkboxes.every((c) => c.status === 'done');
    const allSettled = checkboxes.every((c) => c.status === 'done' || c.status === 'blocked');
    const updated = issueRepo.update(issueId, {
      status: allDone ? 'done' : allSettled ? 'blocked' : 'in_progress',
      metadata: { kind: 'execution-plan', checkboxes },
    });
    broadcastIssuesChanged(issue.workspaceId, 'checkbox-toggled');
    return updated;
  });
  // Atribui (ou tira) um agente responsável de uma task da checklist.
  registerHandler('issue:update-checkbox-assignee', ({ issueId, checkboxId, agentId }) => {
    const issue = issueRepo.get(issueId);
    if (!issue) throw new Error('issue não encontrada');
    const meta = issue.metadata as { kind?: string; checkboxes?: ExecutionCheckbox[] } | null;
    if (!meta || meta.kind !== 'execution-plan' || !Array.isArray(meta.checkboxes)) {
      throw new Error('essa issue não tem checklist de execução');
    }
    const checkboxes = meta.checkboxes.map((c) =>
      c.id === checkboxId ? { ...c, assigneeAgentId: agentId } : c,
    );
    const updated = issueRepo.update(issueId, { metadata: { kind: 'execution-plan', checkboxes } });
    broadcastIssuesChanged(issue.workspaceId, 'checkbox-assignee');
    return updated;
  });
  registerHandler('issue:create-full', (input) => {
    const issue = issueRepo.create(input);
    activityRepo.log({
      workspaceId: issue.workspaceId,
      kind: 'issue.created',
      subjectKind: 'issue',
      subjectId: issue.id,
      title: `Issue ORK-${issue.issueKey} criada: ${issue.title}`,
      payload: { issueKey: issue.issueKey, status: issue.status, priority: issue.priority },
    });
    maybeAutoExecuteIssue(issue);
    return issue;
  });
  registerHandler('issue:update', ({ issueId, patch }) => {
    const before = issueRepo.get(issueId);
    const issue = issueRepo.update(issueId, patch);
    if (patch.status === 'cancelled') {
      cancelIssueExecution(issueId);
    }
    if (before && before.status !== issue.status) {
      activityRepo.log({
        workspaceId: issue.workspaceId,
        kind: 'issue.status_changed',
        subjectKind: 'issue',
        subjectId: issue.id,
        title: `ORK-${issue.issueKey}: ${before.status} → ${issue.status}`,
        payload: { from: before.status, to: issue.status, issueKey: issue.issueKey },
      });
    }
    // Progresso derivado: recalcula os objetivos afetados quando o status ou o
    // vínculo (goalId) muda. Inclui o objetivo antigo (se trocou) e o atual.
    const statusChanged = before && before.status !== issue.status;
    const goalChanged = before && before.goalId !== issue.goalId;
    // Rollup da épica pai + recalc dos objetivos afetados.
    const affected = new Set<string>();
    if (statusChanged && issue.parentIssueId) {
      issueRepo.syncEpicStatus(issue.parentIssueId);
      const epic = issueRepo.get(issue.parentIssueId);
      if (epic?.goalId) affected.add(epic.goalId);
    }
    if (statusChanged || goalChanged) {
      if (before?.goalId) affected.add(before.goalId);
      if (issue.goalId) affected.add(issue.goalId);
    }
    // Recalc + AUTO-VERIFICAÇÃO: se a issue concluída fechou o objetivo (100%), o
    // CEO valida a entrega contra ele (dedup por verifySessionId). Ver Rule #4.
    for (const gid of affected) maybeAutoVerifyGoal(gid);
    return issue;
  });
  registerHandler('issue:delete', ({ issueId }) => {
    const before = issueRepo.get(issueId);
    issueRepo.delete(issueId);
    // Issue apagada também muda o denominador do progresso do objetivo.
    if (before?.goalId) goalRepo.recalcProgress(before.goalId);
    return { ok: true as const };
  });
  // Ações EM LOTE (multi-seleção na lista). Reusam a MESMA lógica per-issue do
  // delete/update acima (cancelar execução, recalc de objetivo) num loop —
  // mantém os side-effects corretos sem reimplementar. O caller (renderer) já
  // expande épicas pra incluir descendentes na deleção. Recalc de objetivo é
  // dedupado pra não recomputar o mesmo objetivo N vezes.
  registerHandler('issue:bulk-delete', ({ issueIds }) => {
    const affectedGoals = new Set<string>();
    let deleted = 0;
    for (const issueId of issueIds) {
      const before = issueRepo.get(issueId);
      if (!before) continue;
      issueRepo.delete(issueId);
      deleted++;
      if (before.goalId) affectedGoals.add(before.goalId);
    }
    for (const gid of affectedGoals) goalRepo.recalcProgress(gid);
    return { deleted };
  });
  registerHandler('issue:bulk-set-status', ({ issueIds, status }) => {
    const affectedGoals = new Set<string>();
    let updated = 0;
    for (const issueId of issueIds) {
      const before = issueRepo.get(issueId);
      if (!before) continue;
      const issue = issueRepo.update(issueId, { status });
      updated++;
      if (status === 'cancelled') cancelIssueExecution(issueId);
      if (before.status !== issue.status) {
        activityRepo.log({
          workspaceId: issue.workspaceId,
          kind: 'issue.status_changed',
          subjectKind: 'issue',
          subjectId: issue.id,
          title: `ORK-${issue.issueKey}: ${before.status} → ${issue.status}`,
          payload: { from: before.status, to: issue.status, issueKey: issue.issueKey },
        });
        if (issue.parentIssueId) {
          issueRepo.syncEpicStatus(issue.parentIssueId);
          const epic = issueRepo.get(issue.parentIssueId);
          if (epic?.goalId) affectedGoals.add(epic.goalId);
        }
        if (before.goalId) affectedGoals.add(before.goalId);
        if (issue.goalId) affectedGoals.add(issue.goalId);
      }
    }
    for (const gid of affectedGoals) maybeAutoVerifyGoal(gid);
    return { updated };
  });
  registerHandler('issue:list-comments', ({ issueId }) => issueRepo.listComments(issueId));
  registerHandler('issue:add-comment', (input) => {
    const comment = issueRepo.addComment(input);
    // Audit trail: comentários movem o board tanto quanto status changes —
    // sem isso, /activity esconde discussão crítica.
    const issue = issueRepo.get(input.issueId);
    if (issue) {
      const preview = input.body.slice(0, 100).replace(/\n/g, ' ');
      activityRepo.log({
        workspaceId: issue.workspaceId,
        kind: 'issue.commented',
        actorKind: input.authorKind ?? 'user',
        actorId: input.authorAgentId ?? null,
        subjectKind: 'issue',
        subjectId: issue.id,
        title: `ORK-${issue.issueKey}: novo comentário · ${preview}${input.body.length > 100 ? '…' : ''}`,
        payload: { commentId: comment.id, issueKey: issue.issueKey },
      });

      // Comentário humano numa issue bloqueada destrava e re-executa (o comentário
      // vira a instrução; o agente lê os comentários no contexto). Só autor humano
      // pra não criar loop quando o próprio agente comenta um bloqueio.
      const fromHuman = (input.authorKind ?? 'user') === 'user';
      if (fromHuman && issue.status === 'blocked' && issue.assigneeAgentId) {
        const reopened = issueRepo.update(issue.id, { status: 'todo' });
        activityRepo.log({
          workspaceId: issue.workspaceId,
          kind: 'issue.status_changed',
          actorKind: 'user',
          subjectKind: 'issue',
          subjectId: issue.id,
          title: `ORK-${issue.issueKey}: destravada por comentário → reenfileirada`,
          payload: { from: 'blocked', to: 'todo', issueKey: issue.issueKey },
        });
        maybeAutoExecuteIssue(reopened);
      }
    }
    return comment;
  });
  registerHandler('issue:delete-comment', ({ commentId }) => {
    issueRepo.deleteComment(commentId);
    return { ok: true as const };
  });
  // ---- Relações de issue (Paperclip) ----
  registerHandler('issue:get-relations', ({ issueId }) => relationsRepo.getRelations(issueId));
  registerHandler('issue:add-dependency', ({ workspaceId, blockerIssueId, blockedIssueId }) => {
    relationsRepo.addDependency(workspaceId, blockerIssueId, blockedIssueId);
    return { ok: true as const };
  });
  registerHandler('issue:remove-dependency', ({ linkId }) => {
    relationsRepo.removeDependency(linkId);
    return { ok: true as const };
  });
  registerHandler('issue:add-reviewer', ({ issueId, agentId, role }) =>
    relationsRepo.addReviewer(issueId, agentId, role),
  );
  registerHandler('issue:remove-reviewer', ({ id }) => {
    relationsRepo.removeReviewer(id);
    return { ok: true as const };
  });
  registerHandler('issue:set-reviewer-decision', ({ id, decision }) => {
    relationsRepo.setReviewerDecision(id, decision);
    return { ok: true as const };
  });
  registerHandler('issue:set-monitor', ({ issueId, schedule }) => {
    relationsRepo.setMonitor(issueId, schedule);
    return { ok: true as const };
  });

  registerHandler('issue:counts-by-status', ({ workspaceId }) =>
    issueRepo.countsByStatus(workspaceId),
  );

  // Decisão de plano (épica + sub-issues). Encapsula a transação inteira no
  // main: grava o estado na metadata da épica, libera as sub-issues e dispara
  // a execução das elegíveis — tudo num único round-trip pro renderer.
  registerHandler('issue:decide-plan', (input) => decidePlan(input));

  // -------- Activity --------
  registerHandler('activity:list', ({ workspaceId, limit }) =>
    activityRepo.listByWorkspace(workspaceId, limit ?? 100),
  );

  // -------- Routines --------
  registerHandler('routine:list', ({ workspaceId }) => routineRepo.listByWorkspace(workspaceId));
  registerHandler('routine:create', (input) => {
    const r = routineRepo.create(input);
    activityRepo.log({
      workspaceId: r.workspaceId,
      kind: 'routine.created',
      subjectKind: 'routine',
      subjectId: r.id,
      title: `Rotina "${r.name}" criada`,
      payload: { intervalMinutes: r.intervalMinutes, enabled: r.enabled },
    });
    return r;
  });
  registerHandler('routine:update', ({ routineId, patch }) => routineRepo.update(routineId, patch));
  registerHandler('routine:delete', ({ routineId }) => {
    routineRepo.delete(routineId);
    return { ok: true as const };
  });
  registerHandler('routine:run-now', async ({ routineId }) => {
    await runRoutine(routineId, 'manual');
    return { ok: true as const };
  });

  // -------- Goals --------
  registerHandler('goal:list', ({ workspaceId }) => {
    goalRepo.recalcAllForWorkspace(workspaceId); // recalc lazy do progresso
    return goalRepo.listByWorkspace(workspaceId);
  });
  registerHandler('goal:create', (input) => {
    const g = goalRepo.create(input);
    activityRepo.log({
      workspaceId: g.workspaceId,
      kind: 'goal.created',
      subjectKind: 'goal',
      subjectId: g.id,
      title: `Objetivo criado: ${g.title}`,
    });
    return g;
  });
  registerHandler('goal:update', ({ goalId, patch }) => goalRepo.update(goalId, patch));
  registerHandler('goal:delete', ({ goalId }) => {
    goalRepo.delete(goalId);
    return { ok: true as const };
  });

  // Aciona o CEO pra DECOMPOR um objetivo em issues (cada uma vinculada ao
  // objetivo via goal_id). Reusa o motor de chat: cria uma sessão e manda o
  // prompt; o CEO usa a tool create_issue. Retorna o sessionId pra UI abrir.
  registerHandler('goal:plan', ({ goalId }) => {
    const goal = goalRepo.get(goalId);
    if (!goal) throw new Error('Objetivo não encontrado');
    const ceo = agentRepo.getOrchestrator(goal.workspaceId);
    if (!ceo) {
      throw new Error('Nenhum agente orquestrador (CEO) no workspace pra planejar.');
    }
    const ws = workspaceRepo.list().find((w) => w.id === goal.workspaceId);
    const location = ws?.path
      ? `pasta local: ${ws.path}`
      : ws?.gitRemote
        ? `source: ${ws.gitRemote}`
        : 'sem source vinculado';

    const prompt = [
      `@${ceo.name} Você é o CEO/Orquestrador do workspace.`,
      '',
      `## Tarefa: DECOMPOR UM OBJETIVO EM ISSUES`,
      '',
      `Objetivo: "${goal.title}"`,
      goal.description ? `Contexto: ${goal.description}` : null,
      `Workspace aponta pra ${location}.`,
      '',
      'Quebre este objetivo em 3 a 6 issues acionáveis e concretas que, juntas, o alcançam.',
      'Para CADA issue, chame a tool `create_issue` passando OBRIGATORIAMENTE:',
      `- goal_id="${goal.id}"  (liga a issue a este objetivo — sem isso a issue fica órfã)`,
      '- title imperativo curto',
      '- description com contexto, escopo e critérios de aceite',
      '- assignee: o agente certo pra tarefa (chame list_agents antes pra ver o time)',
      '- priority adequada',
      '',
      'Regras:',
      '- Não crie agentes. Não peça confirmação ao usuário. Crie as issues AGORA.',
      '- Se o workspace tiver código, dê uma olhada rápida na stack antes de decidir as tarefas.',
      '- Ao citar uma issue pro usuário, use SEMPRE o `issue_ref` retornado pelo create_issue',
      '  (ex: EZC-6, EZC-6.1) — é a numeração que aparece na lista de Issues. NUNCA invente número.',
      '- Ao terminar, escreva um resumo curto (2-3 linhas) do plano pro usuário, em português.',
    ]
      .filter(Boolean)
      .join('\n');

    // Dedup por id do objetivo (não título): reusa o chat do mesmo objetivo;
    // objetivo novo (mesmo título) = chat novo. Sessão apagada → cria de novo.
    if (goal.planSessionId) {
      const existing = sessionRepo.get(goal.planSessionId);
      if (existing) return { ok: true as const, sessionId: existing.id };
    }

    const session = sessionRepo.create({
      workspaceId: goal.workspaceId,
      agentId: ceo.id,
      title: `Planejar objetivo: ${goal.title}`,
      directory: ws?.path ?? undefined,
    });
    goalRepo.update(goal.id, { planSessionId: session.id });

    activityRepo.log({
      workspaceId: goal.workspaceId,
      kind: 'goal.plan_requested',
      subjectKind: 'goal',
      subjectId: goal.id,
      title: `CEO planejando objetivo: ${goal.title}`,
    });

    sendMessage({ sessionId: session.id, content: prompt }).catch((err) => {
      console.warn('[goal:plan] falhou:', err);
    });

    return { ok: true as const, sessionId: session.id };
  });

  // Verificação goal-backward: ao 100% das issues, aciona o CEO pra confirmar
  // que o objetivo foi DE FATO alcançado (não só que as tasks terminaram).
  registerHandler('goal:verify', ({ goalId }) => {
    const goal = goalRepo.get(goalId);
    if (!goal) throw new Error('Objetivo não encontrado');
    const ceo = agentRepo.getOrchestrator(goal.workspaceId);
    if (!ceo) throw new Error('Nenhum agente orquestrador (CEO) no workspace.');
    // Lógica extraída pra goal-verification-service (reusada pelo auto-disparo ao
    // chegar a 100%). Idempotente por verifySessionId.
    const res = launchGoalVerification(goalId);
    if (!res) throw new Error('Não foi possível iniciar a verificação do objetivo.');
    return { ok: true as const, sessionId: res.sessionId };
  });

  // -------- Code reviews --------
  registerHandler('code-review:list', ({ workspaceId, limit }) =>
    codeReviewRepo.listByWorkspace(workspaceId, limit ?? 50),
  );

  registerHandler('code-review:get', ({ reviewId }) => {
    const review = codeReviewRepo.get(reviewId);
    if (!review) return null;
    const comments = codeReviewRepo.listComments(reviewId);
    return { review, comments };
  });

  registerHandler('code-review:latest-for-pr', ({ workspaceId, repoFullName, prNumber }) =>
    codeReviewRepo.getLatestForPr(workspaceId, repoFullName, prNumber),
  );

  registerHandler(
    'code-review:run',
    async ({ workspaceId, repoFullName, prNumber, reviewerAgentId }) => {
      // runCodeReview retorna o reviewId imediatamente — pipeline continua em background.
      const reviewId = await runCodeReview({
        workspaceId,
        repoFullName,
        prNumber,
        reviewerAgentId: reviewerAgentId ?? null,
      });
      return { reviewId };
    },
  );

  registerHandler('code-review:cancel', ({ reviewId }) => {
    const ok = cancelCodeReview(reviewId);
    return { ok };
  });

  registerHandler('code-review:get-diff', async ({ repoFullName, prNumber }) => {
    return await getDiffByFile(repoFullName, prNumber);
  });

  registerHandler('code-review:apply-suggestion', async ({ commentId }) => {
    return await applyCommentSuggestion(commentId);
  });

  registerHandler('code-review:post-to-github', async ({ reviewId }) => {
    await postReviewToGithub(reviewId);
    return { ok: true as const };
  });

  registerHandler('code-review:update-comment-resolution', ({ commentId, resolution }) => {
    codeReviewRepo.updateCommentResolution(commentId, resolution);
    return { ok: true as const };
  });

  registerHandler('code-review:delete', ({ reviewId }) => {
    codeReviewRepo.delete(reviewId);
    return { ok: true as const };
  });
}
