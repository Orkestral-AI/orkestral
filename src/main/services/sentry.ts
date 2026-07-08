import { broadcast, secrets } from '../platform/host';
import { sentryAccountRepo } from '../db/repositories/sentry.repo';
import { sentryAutomationRepo } from '../db/repositories/sentry-automation.repo';
import {
  sentryRuleRepo,
  sentryRuleRunRepo,
  type SentryRuleRecord,
  type SentryRuleMode,
} from '../db/repositories/sentry-rules.repo';
import { ActivityRepository } from '../db/repositories/activity.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import { ChatSessionRepository } from '../db/repositories/session.repo';
import { sendMessage } from './chat-service';

const SENTRY_BASE = 'https://sentry.io/api/0';
const MAX_SENTRY_RETRIES = 2;
// Modo 'auto' dispara uma sessão de orquestração premium por issue. Um burst de
// erros não pode abrir dezenas de sessões num tick — processa as N mais graves
// (por contagem) e deixa o resto pro próximo tick (não marca como visto).
const MAX_AUTO_ANALYSES_PER_TICK = 3;

const activityRepo = new ActivityRepository();
const agentRepo = new AgentRepository();
const sessionRepo = new ChatSessionRepository();

// Cifra via host.secrets: safeStorage quando disponível, senão fallback crypto
// (VPS sem keychain). decryptCompat cobre blobs safeStorage legados.
function encryptToken(plain: string): Buffer {
  return secrets.encrypt(plain);
}

function decryptToken(buf: Buffer): string {
  return secrets.decryptCompat(buf);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSentryJson<T>(
  url: string,
  token: string,
  options: { allowRetry?: boolean } = {},
): Promise<{ data: T; response: Response }> {
  const allowRetry = options.allowRetry ?? true;
  for (let attempt = 0; attempt <= MAX_SENTRY_RETRIES; attempt += 1) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 429 && allowRetry && attempt < MAX_SENTRY_RETRIES) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 0);
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 750);
      continue;
    }
    const data = (await response.json().catch(() => null)) as T;
    return { data, response };
  }
  throw new Error('Falha inesperada ao consultar o Sentry.');
}

export function nextCursorFromLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const next = linkHeader
    .split(',')
    .map((part) => part.trim())
    .find((part) => /rel="next"/.test(part) && /results="true"/.test(part));
  if (!next) return null;
  const match = next.match(/[?&]cursor=([^&>]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function shouldRunSentryWatcherWorkspace(input: {
  nowMs: number;
  lastRunMs: number | null;
  refreshIntervalMin: number;
}): boolean {
  if (input.refreshIntervalMin <= 0) return false;
  if (!input.lastRunMs) return true;
  return input.nowMs - input.lastRunMs >= input.refreshIntervalMin * 60_000;
}

export interface SentryConnection {
  orgSlug: string;
  projectSlug: string | null;
  displayName: string | null;
  connectedAt: string;
}

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  count: number;
  userCount: number;
  lastSeen: string;
  permalink: string;
  project: string;
}

export function getConnection(workspaceId?: string | null): SentryConnection | null {
  const acc = sentryAccountRepo.get(workspaceId);
  if (!acc) return null;
  return {
    orgSlug: acc.orgSlug,
    projectSlug: acc.projectSlug,
    displayName: acc.displayName,
    connectedAt: acc.createdAt,
  };
}

/** Valida o token batendo na org e persiste cifrado. */
export async function connect(input: {
  workspaceId: string;
  orgSlug: string;
  projectSlug?: string | null;
  authToken: string;
}): Promise<SentryConnection> {
  const orgSlug = input.orgSlug.trim();
  const token = input.authToken.trim();
  const projectSlug = input.projectSlug?.trim() || null;
  if (!orgSlug || !token) throw new Error('Informe a organização e o auth token do Sentry.');

  // `/projects/` lista os projetos que o TOKEN acessa — funciona com project:read
  // (sem precisar de org:read). É assim que pegamos "todos os projetos" sem slug.
  const projects = await fetchAccessibleProjects(token, orgSlug);
  if (projects.length === 0) {
    throw new Error(
      `Esse token não tem acesso a nenhum projeto da organização "${orgSlug}". ` +
        'Confira o slug da org e se o token (project:read) cobre os projetos dela.',
    );
  }
  if (projectSlug && !projects.some((p) => p.slug === projectSlug)) {
    throw new Error(
      `Projeto "${projectSlug}" não está acessível por esse token na org "${orgSlug}".`,
    );
  }
  const displayName = projects[0]?.orgName ?? orgSlug;

  sentryAccountRepo.upsert({
    workspaceId: input.workspaceId,
    orgSlug,
    projectSlug,
    displayName,
    tokenEncrypted: encryptToken(token),
  });
  return getConnection(input.workspaceId)!;
}

interface AccessibleProject {
  slug: string;
  orgName: string | null;
}

/** Projetos que o token acessa na org informada (via /api/0/projects/). */
async function fetchAccessibleProjects(
  token: string,
  orgSlug: string,
): Promise<AccessibleProject[]> {
  const out: AccessibleProject[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const url = `${SENTRY_BASE}/projects/?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { data, response } = await fetchSentryJson<
      Array<{ slug?: string; organization?: { slug?: string; name?: string } }>
    >(url, token);
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? 'Token do Sentry inválido.'
          : response.status === 403
            ? 'Token sem permissão. Precisa do scope project:read (e event:read pra ver os erros).'
            : `Não consegui validar com o Sentry (HTTP ${response.status}).`,
      );
    }
    for (const p of Array.isArray(data) ? data : []) {
      if (p.slug && p.organization?.slug === orgSlug) {
        out.push({ slug: p.slug, orgName: p.organization?.name ?? null });
      }
    }
    cursor = nextCursorFromLink(response.headers.get('link'));
    if (!cursor) break;
  }
  return out;
}

export function disconnect(workspaceId?: string | null): void {
  sentryAccountRepo.delete(workspaceId);
}

function mapIssue(i: Record<string, unknown>, fallbackProject: string): SentryIssue {
  return {
    id: String(i.id ?? ''),
    shortId: String(i.shortId ?? ''),
    title:
      (i.title as string | undefined) ||
      (i.metadata as { type?: string } | undefined)?.type ||
      'Erro',
    culprit: String(i.culprit ?? ''),
    level: String(i.level ?? 'error'),
    count: Number(i.count ?? 0),
    userCount: Number(i.userCount ?? 0),
    lastSeen: String(i.lastSeen ?? ''),
    permalink: String(i.permalink ?? ''),
    project: String((i.project as { slug?: string } | undefined)?.slug ?? fallbackProject),
  };
}

/**
 * Issues não resolvidas (resumidas). Sem projeto fixo, varre TODOS os projetos
 * que o token acessa na org e mescla — tudo via endpoint de projeto, que funciona
 * com project:read (os endpoints de org exigiriam org:read).
 */
export async function listIssues(workspaceId: string, limit = 30): Promise<SentryIssue[]> {
  const acc = sentryAccountRepo.get(workspaceId);
  if (!acc) throw new Error('Sentry não conectado.');
  const token = decryptToken(acc.tokenEncrypted);

  const projectSlugs = acc.projectSlug
    ? [acc.projectSlug]
    : (await fetchAccessibleProjects(token, acc.orgSlug)).map((p) => p.slug).slice(0, 50);

  if (projectSlugs.length === 0) return [];

  const perProject = Math.max(5, Math.min(100, Math.ceil(limit / projectSlugs.length)));
  const all: SentryIssue[] = [];
  for (const slug of projectSlugs) {
    let cursor: string | null = null;
    for (let page = 0; page < 3 && all.length < limit * 3; page += 1) {
      const url =
        `${SENTRY_BASE}/projects/${encodeURIComponent(acc.orgSlug)}/${encodeURIComponent(slug)}/issues/` +
        `?query=${encodeURIComponent('is:unresolved')}&statsPeriod=14d&limit=${perProject}` +
        `${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { data, response } = await fetchSentryJson<Array<Record<string, unknown>>>(url, token);
      if (!response.ok) break; // pula projeto que falhar, não derruba a lista toda
      for (const i of Array.isArray(data) ? data : []) all.push(mapIssue(i, slug));
      cursor = nextCursorFromLink(response.headers.get('link'));
      if (!cursor) break;
    }
  }
  // Mais ocorrências primeiro; corta no limite pedido.
  all.sort((a, b) => b.count - a.count);
  return all.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Detalhe de uma issue (evento mais recente: stack, breadcrumbs, request, tags)
// ---------------------------------------------------------------------------

export interface SentryStackFrame {
  filename: string;
  function: string;
  lineNo: number | null;
  inApp: boolean;
}

export interface SentryIssueDetail {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  count: number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  project: string;
  platform: string | null;
  message: string | null;
  tags: Array<{ key: string; value: string }>;
  breadcrumbs: Array<{ category: string; level: string; message: string; timestamp: string }>;
  exception: { type: string; value: string; frames: SentryStackFrame[] } | null;
  request: { method: string; url: string } | null;
}

interface SentryEntry {
  type?: string;
  data?: unknown;
}

function parseException(entries: SentryEntry[]): SentryIssueDetail['exception'] {
  const entry = entries.find((e) => e.type === 'exception');
  const values = (entry?.data as { values?: unknown[] } | undefined)?.values;
  const last = Array.isArray(values)
    ? (values[values.length - 1] as Record<string, unknown>)
    : null;
  if (!last) return null;
  const rawFrames = (last.stacktrace as { frames?: unknown[] } | undefined)?.frames ?? [];
  const frames: SentryStackFrame[] = (Array.isArray(rawFrames) ? rawFrames : [])
    .map((f) => {
      const fr = f as Record<string, unknown>;
      return {
        filename: String(fr.filename ?? fr.module ?? ''),
        function: String(fr.function ?? ''),
        lineNo: fr.lineNo == null ? null : Number(fr.lineNo),
        inApp: Boolean(fr.inApp),
      };
    })
    // Frames mais relevantes (perto do throw) ficam no fim; pega os últimos 15.
    .slice(-15);
  return {
    type: String(last.type ?? 'Error'),
    value: String(last.value ?? ''),
    frames,
  };
}

function parseBreadcrumbs(entries: SentryEntry[]): SentryIssueDetail['breadcrumbs'] {
  const entry = entries.find((e) => e.type === 'breadcrumbs');
  const values = (entry?.data as { values?: unknown[] } | undefined)?.values ?? [];
  return (Array.isArray(values) ? values : [])
    .map((v) => {
      const b = v as Record<string, unknown>;
      const msg = b.message ?? (b.data as { message?: string } | undefined)?.message ?? '';
      return {
        category: String(b.category ?? b.type ?? ''),
        level: String(b.level ?? 'info'),
        message: String(msg ?? ''),
        timestamp: String(b.timestamp ?? ''),
      };
    })
    .slice(-20);
}

function parseRequest(entries: SentryEntry[]): SentryIssueDetail['request'] {
  const entry = entries.find((e) => e.type === 'request');
  const d = entry?.data as { method?: string; url?: string } | undefined;
  if (!d?.url) return null;
  return { method: String(d.method ?? 'GET'), url: String(d.url) };
}

function buildDetail(
  issue: Record<string, unknown>,
  event: Record<string, unknown> | null,
): SentryIssueDetail {
  const base = mapIssue(issue, '');
  const entries = (event?.entries as SentryEntry[] | undefined) ?? [];
  const rawTags = (event?.tags as Array<{ key?: string; value?: string }> | undefined) ?? [];
  const messageEntry = entries.find((e) => e.type === 'message');
  const message =
    (messageEntry?.data as { formatted?: string } | undefined)?.formatted ??
    (issue.metadata as { value?: string } | undefined)?.value ??
    null;
  return {
    ...base,
    firstSeen: String(issue.firstSeen ?? ''),
    project: String((issue.project as { slug?: string } | undefined)?.slug ?? base.project),
    platform:
      (event?.platform as string | undefined) ?? (issue.platform as string | undefined) ?? null,
    message: message ? String(message) : null,
    tags: rawTags
      .filter((tg) => tg.key && tg.value)
      .map((tg) => ({ key: String(tg.key), value: String(tg.value) }))
      .slice(0, 20),
    breadcrumbs: parseBreadcrumbs(entries),
    exception: parseException(entries),
    request: parseRequest(entries),
  };
}

/**
 * Detalhe de uma issue: dados da issue + evento mais recente (stacktrace,
 * breadcrumbs, request, tags). Endpoints legados `/issues/{id}/` funcionam com
 * token de projeto (project:read + event:read), sem precisar de org:read.
 */
export async function getIssueDetail(
  workspaceId: string,
  issueId: string,
): Promise<SentryIssueDetail> {
  const acc = sentryAccountRepo.get(workspaceId);
  if (!acc) throw new Error('Sentry não conectado.');
  const token = decryptToken(acc.tokenEncrypted);

  const { data: issue, response: issueRes } = await fetchSentryJson<Record<string, unknown>>(
    `${SENTRY_BASE}/issues/${encodeURIComponent(issueId)}/`,
    token,
  );
  if (!issueRes.ok) {
    throw new Error(
      issueRes.status === 404
        ? 'Erro não encontrado no Sentry (pode ter sido resolvido).'
        : `Falha ao buscar o erro no Sentry (HTTP ${issueRes.status}).`,
    );
  }

  let event: Record<string, unknown> | null = null;
  try {
    const { data, response } = await fetchSentryJson<Record<string, unknown>>(
      `${SENTRY_BASE}/issues/${encodeURIComponent(issueId)}/events/latest/`,
      token,
    );
    if (response.ok) event = data;
  } catch {
    event = null;
  }
  return buildDetail(issue, event);
}

// ---------------------------------------------------------------------------
// Análise pelo agente (CEO ou o escolhido na automação)
// ---------------------------------------------------------------------------

/**
 * Cria uma sessão de chat com o agente (CEO por padrão) carregando o contexto
 * do erro e dispara a mensagem. Usado tanto pelo botão "Analisar e corrigir"
 * quanto pela automação no modo 'auto'. Retorna o sessionId.
 */
export async function analyzeIssue(input: {
  workspaceId: string;
  issueId: string;
  agentId?: string | null;
  /**
   * Quando true (watcher no modo 'auto'), aguarda o sendMessage e propaga falha —
   * assim o histórico da automação loga status:'error' em vez de 'ok' enganoso.
   * O caminho interativo (botão "Analisar e corrigir") deixa default (false) pra
   * abrir a sessão na hora sem travar na resposta do agente.
   */
  awaitDelivery?: boolean;
}): Promise<{ sessionId: string }> {
  const agent = input.agentId
    ? agentRepo.get(input.agentId)
    : agentRepo.getOrchestrator(input.workspaceId);
  if (!agent) throw new Error('Nenhum agente disponível pra analisar o erro.');

  const issue = await getIssueDetail(input.workspaceId, input.issueId);

  const session = sessionRepo.create({
    workspaceId: input.workspaceId,
    agentId: agent.id,
    title: `Sentry ${issue.shortId} — ${issue.title}`.slice(0, 90),
  });

  // Stack resumida: arquivo:linha (função), do mais externo ao mais interno.
  const stack = issue.exception?.frames
    .map(
      (f) =>
        `  ${f.filename}${f.lineNo ? `:${f.lineNo}` : ''}${f.function ? ` (${f.function})` : ''}${f.inApp ? '' : '  [lib]'}`,
    )
    .join('\n');
  const crumbs = issue.breadcrumbs
    .slice(-8)
    .map((b) => `  [${b.level}] ${b.category}: ${b.message}`.trim())
    .filter((l) => l !== `[info] :`)
    .join('\n');

  const prompt = [
    `@${agent.name} um erro reportado no Sentry precisa de análise e correção.`,
    '',
    `**${issue.shortId}** · nível \`${issue.level}\` · ${issue.count} ocorrências · ${issue.userCount} usuário(s) afetado(s)`,
    `Título: ${issue.title}`,
    issue.culprit ? `Local provável: \`${issue.culprit}\`` : '',
    issue.project ? `Projeto: ${issue.project}` : '',
    issue.exception
      ? `\n**Exceção**: \`${issue.exception.type}\`${issue.exception.value ? ` — ${issue.exception.value}` : ''}`
      : '',
    stack ? `\n**Stacktrace** (mais relevante por último):\n\`\`\`\n${stack}\n\`\`\`` : '',
    issue.request ? `\n**Request**: ${issue.request.method} ${issue.request.url}` : '',
    crumbs ? `\n**Breadcrumbs** (últimos):\n${crumbs}` : '',
    issue.permalink ? `\nLink: ${issue.permalink}` : '',
    '',
    'Investigue a causa raiz lendo o código relevante do workspace (use suas ferramentas e a stacktrace acima), explique o problema em linguagem simples e proponha/aplique a correção. Se for melhor, distribua pro especialista certo do time.',
  ]
    .filter(Boolean)
    .join('\n');

  const delivery = sendMessage({ sessionId: session.id, content: prompt });

  broadcast('chat:session-ready', {
    workspaceId: input.workspaceId,
    sessionId: session.id,
    reason: 'sentry-analyze',
  });

  if (input.awaitDelivery) {
    await delivery; // propaga falha pro watcher logar status:'error'
  } else {
    void delivery.catch((err) => {
      console.warn('[sentry] analyze sendMessage falhou:', err);
    });
  }
  return { sessionId: session.id };
}

// ---------------------------------------------------------------------------
// Automação: vigia issues novas e propõe fix no Inbox (ou analisa direto)
// ---------------------------------------------------------------------------

/** Ranking de severidade pra comparar com a severidade mínima da regra. */
const LEVEL_RANK: Record<string, number> = {
  fatal: 4,
  error: 3,
  warning: 2,
  info: 1,
  debug: 0,
};

function levelRank(level: string): number {
  return LEVEL_RANK[level] ?? LEVEL_RANK.error;
}

// ----- Ajuste do workspace: intervalo de auto-refresh (observabilidade) -----

export interface SentryAutomationSettingsDto {
  refreshIntervalMin: number;
}

export function getAutomation(workspaceId: string): SentryAutomationSettingsDto {
  return { refreshIntervalMin: sentryAutomationRepo.get(workspaceId)?.refreshIntervalMin ?? 5 };
}

/** Salva só o intervalo de auto-refresh do workspace (as regras vivem à parte). */
export function setAutomation(input: {
  workspaceId: string;
  refreshIntervalMin: number;
}): SentryAutomationSettingsDto {
  const ex = sentryAutomationRepo.get(input.workspaceId);
  sentryAutomationRepo.upsert({
    workspaceId: input.workspaceId,
    enabled: ex?.enabled ?? false,
    minLevel: ex?.minLevel ?? 'error',
    projectSlug: ex?.projectSlug ?? null,
    agentId: ex?.agentId ?? null,
    mode: ex?.mode ?? 'propose',
    refreshIntervalMin: input.refreshIntervalMin,
  });
  return getAutomation(input.workspaceId);
}

// ----- Regras de automação (VÁRIAS por workspace) -----

export interface SentryRuleDto {
  id: string;
  name: string;
  enabled: boolean;
  minLevel: string;
  projectSlug: string | null;
  agentId: string | null;
  mode: SentryRuleMode;
}

function ruleToDto(r: SentryRuleRecord): SentryRuleDto {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    minLevel: r.minLevel,
    projectSlug: r.projectSlug,
    agentId: r.agentId,
    mode: r.mode,
  };
}

export function listRules(workspaceId: string): SentryRuleDto[] {
  return sentryRuleRepo.listByWorkspace(workspaceId).map(ruleToDto);
}

/** Ids das issues atuais — pra semear "já vistas" ao ligar uma regra. */
async function currentIssueIds(workspaceId: string): Promise<string[]> {
  if (!sentryAccountRepo.get(workspaceId)) return [];
  try {
    return (await listIssues(workspaceId, 100)).map((i) => i.id);
  } catch {
    return [];
  }
}

/**
 * Cria ou atualiza uma regra. Ao LIGAR (nova ligada, ou desligado→ligado),
 * semeia os ids das issues atuais como "já vistas" — só age em issues NOVAS.
 */
export async function saveRule(input: {
  id?: string | null;
  workspaceId: string;
  name: string;
  enabled: boolean;
  minLevel: string;
  projectSlug: string | null;
  agentId: string | null;
  mode: SentryRuleMode;
}): Promise<SentryRuleDto> {
  if (input.id) {
    const ex = sentryRuleRepo.get(input.id);
    const seedNow = input.enabled && !(ex?.enabled ?? false);
    const seen = seedNow ? await currentIssueIds(input.workspaceId) : undefined;
    const updated = sentryRuleRepo.update(input.id, {
      name: input.name,
      enabled: input.enabled,
      minLevel: input.minLevel,
      projectSlug: input.projectSlug,
      agentId: input.agentId,
      mode: input.mode,
      ...(seen ? { seenIssueIds: seen } : {}),
    });
    return ruleToDto(updated ?? sentryRuleRepo.get(input.id)!);
  }
  const seen = input.enabled ? await currentIssueIds(input.workspaceId) : [];
  const created = sentryRuleRepo.create({
    workspaceId: input.workspaceId,
    name: input.name,
    enabled: input.enabled,
    minLevel: input.minLevel,
    projectSlug: input.projectSlug,
    agentId: input.agentId,
    mode: input.mode,
    seenIssueIds: seen,
  });
  return ruleToDto(created);
}

export function deleteRule(id: string): void {
  sentryRuleRepo.delete(id);
}

export interface SentryRuleRunDto {
  id: string;
  ruleId: string;
  issueId: string;
  shortId: string | null;
  title: string | null;
  level: string | null;
  project: string | null;
  action: 'proposed' | 'analyzed';
  status: 'ok' | 'error';
  detail: string | null;
  createdAt: string;
}

export function listRuns(workspaceId: string, limit = 50): SentryRuleRunDto[] {
  return sentryRuleRunRepo.listByWorkspace(workspaceId, limit).map((r) => ({
    id: r.id,
    ruleId: r.ruleId,
    issueId: r.issueId,
    shortId: r.shortId,
    title: r.title,
    level: r.level,
    project: r.project,
    action: r.action,
    status: r.status,
    detail: r.detail,
    createdAt: r.createdAt,
  }));
}

function matchesRule(issue: SentryIssue, rule: SentryRuleRecord): boolean {
  if (levelRank(issue.level) < levelRank(rule.minLevel)) return false;
  if (rule.projectSlug && issue.project !== rule.projectSlug) return false;
  return true;
}

/** Cria a proposta no Inbox pra uma issue (modo 'propose'). */
function proposeIssue(workspaceId: string, issue: SentryIssue, agentId: string | null): void {
  const title = `Sentry ${issue.shortId} — ${issue.title}`.slice(0, 110);
  activityRepo.log({
    workspaceId,
    kind: 'proposal.pending',
    actorKind: 'system',
    subjectKind: 'sentry-issue',
    subjectId: issue.id,
    title,
    payload: {
      type: 'sentry-issue',
      issueId: issue.id,
      shortId: issue.shortId,
      title: issue.title,
      level: issue.level,
      project: issue.project,
      culprit: issue.culprit,
      count: issue.count,
      userCount: issue.userCount,
      permalink: issue.permalink,
      agentId,
    },
  });
  broadcast('inbox:proposal-created', { workspaceId, issueId: issue.id, title });
}

let watcherTimer: ReturnType<typeof setInterval> | null = null;
const lastWatcherTickByWorkspace = new Map<string, number>();

/** Passada do watcher: para cada REGRA ligada, age nas issues novas e loga a execução. */
async function runWatchTick(): Promise<void> {
  if (!sentryAccountRepo.get()) return;
  const rules = sentryRuleRepo.listEnabled();
  if (rules.length === 0) return;

  const rulesByWorkspace = new Map<string, SentryRuleRecord[]>();
  for (const rule of rules) {
    const bucket = rulesByWorkspace.get(rule.workspaceId) ?? [];
    bucket.push(rule);
    rulesByWorkspace.set(rule.workspaceId, bucket);
  }

  for (const [workspaceId, workspaceRules] of rulesByWorkspace) {
    if (!sentryAccountRepo.get(workspaceId)) continue;
    const refreshMin = sentryAutomationRepo.get(workspaceId)?.refreshIntervalMin ?? 5;
    const last = lastWatcherTickByWorkspace.get(workspaceId) ?? 0;
    const now = Date.now();
    if (
      !shouldRunSentryWatcherWorkspace({
        nowMs: now,
        lastRunMs: last,
        refreshIntervalMin: refreshMin,
      })
    ) {
      continue;
    }
    lastWatcherTickByWorkspace.set(workspaceId, now);

    let issues: SentryIssue[];
    try {
      issues = await listIssues(workspaceId, 100);
    } catch (err) {
      console.warn('[sentry] watcher listIssues falhou:', err);
      continue;
    }

    for (const rule of workspaceRules) {
      const seen = new Set(rule.seenIssueIds);
      const fresh = issues.filter((i) => !seen.has(i.id) && matchesRule(i, rule));
      if (fresh.length === 0) continue;
      // No modo 'auto' limita quantas issues viram sessão premium neste tick (as
      // mais graves primeiro); as não processadas ficam pro próximo tick.
      const batch =
        rule.mode === 'auto'
          ? [...fresh].sort((a, b) => b.count - a.count).slice(0, MAX_AUTO_ANALYSES_PER_TICK)
          : fresh;
      for (const issue of batch) {
        const base = {
          ruleId: rule.id,
          workspaceId: rule.workspaceId,
          issueId: issue.id,
          shortId: issue.shortId,
          title: issue.title,
          level: issue.level,
          project: issue.project,
        };
        try {
          if (rule.mode === 'auto') {
            const { sessionId } = await analyzeIssue({
              workspaceId: rule.workspaceId,
              issueId: issue.id,
              agentId: rule.agentId,
              awaitDelivery: true,
            });
            sentryRuleRunRepo.log({
              ...base,
              action: 'analyzed',
              status: 'ok',
              detail: sessionId,
            });
          } else {
            proposeIssue(rule.workspaceId, issue, rule.agentId);
            sentryRuleRunRepo.log({ ...base, action: 'proposed', status: 'ok' });
          }
        } catch (err) {
          sentryRuleRunRepo.log({
            ...base,
            action: rule.mode === 'auto' ? 'analyzed' : 'proposed',
            status: 'error',
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
      sentryRuleRepo.setSeen(rule.id, [...rule.seenIssueIds, ...batch.map((i) => i.id)]);
    }
  }
}

/** Liga o watcher do Sentry (primeira passada após 30s, depois checa intervalos por workspace). */
export function startSentryWatcher(): void {
  if (watcherTimer) return;
  setTimeout(() => void runWatchTick().catch(() => {}), 30_000);
  watcherTimer = setInterval(() => void runWatchTick().catch(() => {}), 60_000);
}
