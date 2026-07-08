/**
 * Cria uma issue "Analisar source" pro agente orquestrador e dispara a
 * execução em background. Substituiu o spawn direto da IA — agora toda análise
 * é orquestrada via issue, com histórico/comentários/recovery.
 */

import { IssueRepository } from '../db/repositories/issue.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import { WorkspaceSourceRepository } from '../db/repositories/workspace-source.repo';
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import { KbPageRepository } from '../db/repositories/kb-page.repo';
import { executeIssue } from './issue-execution-service';

const issueRepo = new IssueRepository();
const agentRepo = new AgentRepository();
const sourceRepo = new WorkspaceSourceRepository();
const workspaceRepo = new WorkspaceRepository();
const pageRepo = new KbPageRepository();

export function requestSourceAnalysis(
  workspaceId: string,
  sourceId: string,
): { issueId: string; issueKey: number; prefix: string } {
  const source = sourceRepo.get(sourceId);
  if (!source) throw new Error('Source não encontrado');
  if (!source.path) {
    throw new Error(
      `Source "${source.label}" sem path local. Faça clone antes (github_repo) ou pick folder (local).`,
    );
  }

  const workspace = workspaceRepo.listAll().find((w) => w.id === workspaceId);
  if (!workspace) throw new Error('Workspace não encontrado');

  // Acha um agente pra rodar a análise. Qualquer adapter serve (claude/codex/
  // etc.) — preferimos o orquestrador; senão o primeiro agente do workspace.
  const agents = agentRepo.listByWorkspace(workspaceId);
  const orchestrator = agents.find((a) => a.isOrchestrator) ?? agents[0];
  if (!orchestrator) {
    throw new Error(
      'Nenhum agente no workspace. Crie um agente (Claude ou Codex) pra ativar análises.',
    );
  }

  // Limpa qualquer página anterior ligada a este source — evita órfãs do tipo
  // "Repo: X · Análise em andamento" que ficavam quando a análise era
  // re-disparada. O agente cria a estrutura inteira do zero.
  // ARQUIVA (não apaga) as páginas anteriores deste source: se o run fire-and-forget abaixo
  // falhar, a KB antiga sobrevive (recuperável via includeArchived) em vez de sumir pra sempre.
  // O agente recria a estrutura do zero (arquivadas saem da listagem default); a purga
  // definitiva fica pro caminho de sucesso/manutenção.
  const previous = pageRepo
    .listByWorkspace(workspaceId, true)
    .filter((p) => p.sourceId === sourceId && !p.isArchived);
  for (const p of previous) pageRepo.update(p.id, { isArchived: true });
  const removed = previous.length;
  if (removed > 0) {
    console.log(
      `[kb-request-analysis] limpou ${removed} página(s) anteriores do source ${source.label}`,
    );
  }

  // Contexto cross-repo: lista outros sources do workspace
  const otherSources = sourceRepo.listByWorkspace(workspaceId).filter((s) => s.id !== sourceId);

  const description = buildAnalysisDescription({
    source,
    otherSources,
    orchestratorName: orchestrator.name,
  });

  const issue = issueRepo.create({
    workspaceId,
    title: `Analisar source @${source.label}`,
    description,
    status: 'todo',
    // Análise de source é descoberta de background, não caminho crítico → medium
    // (priority não pode ser sempre 'high' — P0-09).
    priority: 'medium',
    labels: ['analysis', 'kb', 'auto-exec'],
    assigneeAgentId: orchestrator.id,
    metadata: { kind: 'kb-analysis', sourceId: source.id, autoExec: true },
  });

  // Prefix do workspace pra UI (ex: EZC-12)
  const letters = workspace.name.match(/[A-Z]/g);
  const prefix =
    letters && letters.length >= 2
      ? letters.slice(0, 3).join('')
      : workspace.name.slice(0, 3).toUpperCase();

  // Dispara execução em background — UI já pode navegar pra issue e ver progresso
  setImmediate(() => {
    try {
      executeIssue(issue.id);
    } catch (err) {
      console.error('[kb-request-analysis] auto-exec falhou:', err);
    }
  });

  return { issueId: issue.id, issueKey: issue.issueKey, prefix };
}

function buildAnalysisDescription(opts: {
  source: import('../../shared/types').WorkspaceSource;
  otherSources: import('../../shared/types').WorkspaceSource[];
  orchestratorName: string;
}): string {
  const { source, otherSources, orchestratorName } = opts;
  const repoRef = source.repoFullName ? `\`${source.repoFullName}\`` : `\`${source.path}\``;
  const rootTitle = `Repo: ${source.label}`;

  const lines = [
    `Deep analysis of source **${source.label}** (${repoRef}) requested for @${orchestratorName}.`,
    '',
    `## Objective`,
    '',
    'Generate the structured knowledge base for this repository — markdown pages organized in a tree, linked to each other via wikilinks, covering architecture, stack, flows, and risks. The content must be **lean and useful**, not encyclopedic.',
    '',
    "**Language (hard rule):** write ALL pages (titles and content) in the SAME language as the user's last message (user wrote Portuguese → write in Portuguese; English → English). Well-known technical terms may stay in English, but whole sentences follow the user's language. Never switch languages on your own.",
    '',
    `## How to deliver`,
    '',
    `1. **Use the MCP tools** (\`kb_create_page\`, \`kb_link_pages\`, \`kb_create_entity\`, \`kb_link_entities\`, \`comment_on_issue\`). Do not respond with text alone — materialize everything as pages and entities in the KB.`,
    '',
    `2. **MANDATORY FIRST STEP**: create the root page with EXACTLY this title — do not invent a name, do not abbreviate, do not use a nickname:`,
    '',
    `   \`\`\``,
    `   kb_create_page({`,
    `     title: "${rootTitle}",`,
    `     kind: "auto-generated",`,
    `     content_md: "# ${rootTitle}\\n\\nRoot page of the analysis — sub-pages structure the base."`,
    `   })`,
    `   \`\`\``,
    '',
    `   Save the returned \`id\` and **use it as the \`parent_page_id\` of ALL other pages you create**. Without it, the pages end up orphaned in the graph.`,
    '',
    `3. Use the native \`Read\`/\`Glob\` to inspect the repo's files — your \`cwd\` is on the source. Read entrypoints, configs, models, main services, package manifests. DO NOT MAKE THINGS UP — derive from the code.`,
    `4. Create AT LEAST these pages (each one short, 2-4 paragraphs + bullets), all children of the root "${rootTitle}":`,
    `   - **Overview** — purpose, audience, status`,
    `   - **Architecture** — pattern, entrypoints, main flows (ASCII diagram if useful)`,
    `   - **Stack** — main frameworks/libs with 1 line about the role of each`,
    `   - **Dependencies** — grouped by category (UI, build, test, runtime…)`,
    `   - **Directory structure** — each top-level folder with 1 line`,
    `   - **Critical flows** — one sub-page per flow (auth, [main domain], etc.)`,
    `   - **Pain points** — technical debt, code smells, oversized files, fragile areas. BE HONEST.`,
    `   - **Conventions** — naming, formatters, implicit patterns`,
    `   - **Setup** — commands to run, env vars, gotchas`,
    `5. To avoid conflicts with analyses of sibling sources, **include the source suffix in the sub-page titles** (e.g., "Architecture — ${source.label}", "Stack — ${source.label}"). This lets the user have "Architecture — ezchat-frontend" AND "Architecture — ezchat-backend" as distinct pages.`,
    `6. Use wikilinks \`[[Título]]\` in the content to build the web between pages.`,
    `7. **Extract the key ENTITIES** — the technologies, services, tools, external integrations and core concepts the repo revolves around (e.g. React, SQLite, Stripe, BM25, the auth flow). For each, call \`kb_create_entity({ kind, name, description })\`. Then **connect related ones** with \`kb_link_entities({ source_entity, target_entity, relation })\` (e.g. "depends on", "uses", "integrates with"). An entity with NO relation stays hidden in the graph, so link every entity to at least one other. Aim for ~5-15 entities — the most important ones, not every dependency.`,
    `8. When done, call \`update_issue_status({ issue_key: <N>, status: "done" })\` and \`comment_on_issue\` with a short summary (how many pages and entities you created, the most critical point found).`,
    `9. If you get blocked, set \`status="blocked"\` + a comment explaining what's missing.`,
    '',
    `## ❌ What NOT to do`,
    '',
    `- ❌ Do NOT create a page named just "Repo: ezchat" or something similarly generic. The source label is **${source.label}** — use EXACTLY that.`,
    `- ❌ Do NOT create a placeholder with "Work in progress" — go straight to the real content after Read/Glob of the code.`,
    `- ❌ Do NOT create sub-pages with a null \`parent_page_id\` — they end up loose in the graph.`,
    '',
  ];

  if (otherSources.length > 0) {
    lines.push('## Cross-repo');
    lines.push('');
    lines.push(
      `This workspace has ${otherSources.length} other source(s): ${otherSources
        .map((s) => `**${s.label}**${s.role ? ` (${s.role})` : ''}`)
        .join(', ')}.`,
    );
    lines.push('');
    lines.push(
      'When this source connects to a sibling source (e.g., frontend calls the backend API; backend consumes contracts from shared types; etc.), CITE it explicitly and use `[[título]]` pointing to pages that exist (or will exist) in the sibling source. The knowledge must form ONE single web.',
    );
    lines.push('');
  } else {
    lines.push('## Cross-repo');
    lines.push('');
    lines.push('Only source in the workspace — focus here.');
    lines.push('');
  }

  lines.push('## Technical context');
  lines.push('');
  lines.push(`- Source ID: \`${source.id}\``);
  lines.push(`- Source label (USE EXACTLY): \`${source.label}\``);
  lines.push(`- Local path: \`${source.path}\``);
  if (source.repoFullName) lines.push(`- GitHub: \`${source.repoFullName}\``);
  if (source.role) lines.push(`- Role: ${source.role}`);
  lines.push(`- Mandatory root page title: \`${rootTitle}\``);

  return lines.join('\n');
}
