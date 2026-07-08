import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { broadcast } from '../platform/host';
import { AgentRepository } from '../db/repositories/agent.repo';
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import { CodeReviewRepository } from '../db/repositories/code-review.repo';
import { ActivityRepository } from '../db/repositories/activity.repo';
import { fetchPullRequest, fetchPullRequestDiff, postReview } from './github';
import { ensureDefaultInstructions, readRuntimeInstructionContext } from './agent-instructions';
import { ensureMcpServerStarted } from './mcp-server';
import { scrubSpawnEnv } from './spawn-policy';
import { activeLanguageName } from '../i18n';
import type {
  AdapterType,
  CodeReviewChangeKind,
  CodeReviewCommentKind,
  CodeReviewEffort,
  CodeReviewEvent,
  CodeReviewFileChange,
  CodeReviewRecommendation,
  CodeReviewSeverity,
  CodeReviewWalkthroughItem,
} from '../../shared/types';

const agentRepo = new AgentRepository();
const workspaceRepo = new WorkspaceRepository();
const reviewRepo = new CodeReviewRepository();
const activityRepo = new ActivityRepository();

/** Processos em execução por reviewId — pra suportar cancelamento. */
const activeReviewProcesses = new Map<string, ChildProcess>();

function emitReviewEvent(event: CodeReviewEvent): void {
  broadcast('code-review:event', event);
}

/**
 * Prompt usado pra dirigir a análise. Pede JSON estrito pra parsing
 * confiável. Em runtime concatena com instructions do agente + diff.
 */
const CODE_REVIEW_PROMPT = `You are a **senior staff/principal code reviewer** reviewing a Pull Request.
Your mission is to find REAL engineering problems — not to do beginner-level codestyle review.

## LANGUAGE — HARD RULE

ALL text fields in the response MUST be in **{{LANG}}**:
- \`summary\`, \`testsAssessment\`, \`highlights\`, \`concerns\`
- \`walkthrough[].summary\`
- \`comments[].title\` and \`comments[].message\`

Established technical terms stay in English (\`useEffect\`, \`race condition\`, \`type safety\`, \`null\`, \`undefined\`, function/variable names from the code, git commands, etc.), but the **full sentences** are in the language indicated above.

## BEFORE COMMENTING ON ANYTHING: READ THE PROJECT

You are running inside the repository directory. BEFORE generating the analysis:
1. Inspect \`package.json\` (scripts, deps, lint setup, tests, husky/lefthook, ci).
2. Inspect quality configs: \`.eslintrc*\`, \`eslint.config.*\`, \`.prettierrc*\`, \`tsconfig.json\`, \`biome.json\`, \`oxlint.json\`, \`commitlint*\`, \`.husky/*\`.
3. If there is a linter + formatter + type-checker configured, **ASSUME THEY ALL PASSED** (the team does not merge a red PR).
4. If there are tests in the folder, look at the structure (vitest, jest, playwright) — understand what is covered.
5. For code patterns (hooks, util helpers, design system), briefly explore the files related to the modified ones — understand the REPO's conventions.

## WHAT NOT TO DO (CRITICAL — NEVER generate comments about these items)

- **Formatting**: spaces, indent, quotes, trailing comma, line length → prettier/eslint handle it
- **Trivial naming**: "this name could be better", "use camelCase" → not your job
- **Obvious explicit type annotations**: "add a type here" when TS already inferred it → noise
- **Unordered / unused imports**: the linter catches it
- **Duplicated className / template literal vs cn()**: if the project doesn't use cn() EVERYWHERE yet, do NOT insist — it's an emerging pattern, not a bug
- **"Consider extracting into a function"** with no concrete benefit → speculation
- **"Add a comment"** → code comments are not your job
- **String capitalization, hardcoded locale** → only comment if the project uses next-intl/react-intl AND the file is NOT in an opt-out category
- **"Use const instead of let"** → trivial
- **Hypothetical suggestions** ("if you ever need...", "it would be nice if...") → don't comment

## WHAT TO DO (review focus)

### Real bugs (kind: "bug", severity: "critical" or "warning")
- Race conditions, incorrect ordering of async operations
- Off-by-one, null/undefined not handled in a path that may receive it
- Stale state in useEffect/useCallback (missing OR extra deps)
- Accidental mutation (mutating a prop, mutating state, mutating a shared object)
- Wrong logic (inverted condition, fallback that masks an error, fall-through in switch)
- Missing cleanup (event listeners, intervals, abort controllers)
- Unhandled promise, error swallowed with \`catch {}\`
- Wrong comparison (\`==\` instead of \`===\` when it matters, NaN, reference vs value)

### Security (kind: "security")
- XSS (dangerouslySetInnerHTML without sanitize, innerHTML, eval, Function())
- Injection (SQL string concat, command exec without escape)
- Hardcoded credentials, tokens in logs, secrets in the frontend
- Misconfigured CORS/CSRF
- Missing input validation on server-side entry
- Confidence: prototype pollution, path traversal, open redirect

### Performance (kind: "performance")
- N+1 query, loop with an expensive synchronous side-effect
- useEffect running on every render due to a badly declared dep
- Unnecessary render (inline object in a memoized component's prop)
- Bundle: importing a huge lib just to use one small function
- Memory leak (subscriber not removed, ref growing)

### Architecture/Contract (kind: "bug" or "suggestion", severity: "warning")
- API contract break (response shape changed and the consumer doesn't update)
- Duplicated state, ambiguous source of truth
- Severe coupling between modules that should be independent
- Side effect in the wrong place (mutation in a selector, fetch in render)
- In multi-PR: contracts between backend and frontend not matching

### Tests (kind: "suggestion", severity: "warning")
- Critical path (auth, billing, sensitive data) without a test
- Obvious edge case not covered (empty list, network error, race)
- Do NOT comment "add more tests" generically — point to the specific scenario

## HARD OUTPUT RULES

1. Your response MUST be ONLY a single JSON block, with nothing before or after. No markdown, no prefix, no explanation.
2. Use the EXACT format below. Do not invent fields.
3. Cite REAL lines from the diff (use the numbering from the \`@@ -X,Y +A,B @@\` header).
4. For each comment: \`title\` ≤80 chars describing the finding, \`message\` explaining the why and the impact (not just "it's wrong"), \`suggestion\` with corrected code when applicable, \`codeContext\` with 3-5 lines of the code.
5. If the PR is OK: return \`comments: []\` AND recommendation: "approve". It is fine not to invent a problem. Fill in summary/highlights/walkthrough anyway.
6. \`walkthrough\` covers all relevant files in the diff (1 item per file, 1-2 sentences).
7. \`rating\` 0-10:
   - 9-10: flawless, improves the project
   - 7-8: good PR, with small suggestions
   - 5-6: has 1-2 medium issues
   - 3-4: bugs or architecture problems
   - ≤2: block, serious security problem or breakage
8. \`recommendation\`:
   - "approve" when rating ≥ 7 and no critical
   - "request_changes" when there is a critical OR rating ≤ 5
   - "comment" for ambiguous (suggestions but not blocking)
9. **Limit**: at most 12 inline comments. If you generate 30, you're nitpicking. Pick what MATTERS.

## ABOUT MULTI-PR (linked backend + frontend)

If there is more than one PR in this prompt, the main focus is CROSS-STACK bugs:
- Backend payload type that the frontend consumes
- Field renamed on one side and not the other
- Status code/error code not handled in the frontend
- Race between the backend and frontend deploys
- In \`filePath\`, use the \`[repo-name]\` prefix to distinguish: e.g. \`[ezchat-backend]src/auth.ts\`, \`[ezchat-frontend]src/api.ts\`.

## FORMAT (ALL fields are required; arrays may be empty)

{
  "summary": "1-3 sentences describing the PR and the overall verdict.",
  "risk": "low" | "medium" | "high",
  "rating": 7.5,
  "effort": "small" | "medium" | "large",
  "recommendation": "approve" | "request_changes" | "comment",
  "testsAssessment": "Coverage analysis: what exists, what is missing, in which CRITICAL scenarios.",
  "highlights": ["Real and specific positive point — not generic", "..."],
  "concerns": ["Real risk (technical, not aesthetics)", "..."],
  "walkthrough": [
    {
      "filePath": "src/auth.ts",
      "summary": "1-2 sentences about what changed in this file.",
      "changeKind": "feature" | "fix" | "refactor" | "docs" | "test" | "chore" | "style"
    }
  ],
  "comments": [
    {
      "filePath": "src/auth.ts",
      "line": 42,
      "kind": "bug" | "suggestion" | "security" | "style" | "performance" | "question",
      "severity": "critical" | "warning" | "info",
      "title": "Short and direct title",
      "message": "Explanation of the problem, WHY it is a problem and what the real impact is.",
      "suggestion": "corrected code (use if applicable)",
      "codeContext": "3-5 lines of the code in context (optional)"
    }
  ]
}
`;

interface ParsedReview {
  summary: string;
  risk: string;
  rating?: number;
  effort?: CodeReviewEffort;
  recommendation?: CodeReviewRecommendation;
  testsAssessment?: string;
  highlights?: string[];
  concerns?: string[];
  walkthrough?: Array<{
    filePath: string;
    summary: string;
    changeKind: CodeReviewChangeKind;
  }>;
  comments: Array<{
    filePath: string;
    line?: number;
    lineStart?: number;
    lineEnd?: number;
    kind: CodeReviewCommentKind;
    severity: CodeReviewSeverity;
    title?: string;
    message: string;
    suggestion?: string | null;
    codeContext?: string | null;
  }>;
}

const VALID_CHANGE_KINDS: CodeReviewChangeKind[] = [
  'feature',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'style',
];
const VALID_EFFORTS: CodeReviewEffort[] = ['small', 'medium', 'large'];
const VALID_RECOMMENDATIONS: CodeReviewRecommendation[] = ['approve', 'request_changes', 'comment'];

function buildAdapterCommand(
  adapter: AdapterType,
  opts: { model?: string | null; mcpConfigPath?: string | null },
): {
  command: string;
  args: string[];
  usesStdin: boolean;
  /** Output vem como JSONL — parser precisa reconstruir o texto. */
  streaming: boolean;
} {
  switch (adapter) {
    case 'claude_local': {
      // stream-json: cada chunk de output chega em evento JSONL separado.
      // Vantagem em PRs grandes: nada de bufferizar 100KB+ até EOF.
      // Bonus: o evento `result` carrega usage agregado (tokens, cost).
      const args = [
        '--print',
        '-',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--dangerously-skip-permissions',
      ];
      if (opts.model && opts.model !== 'default') args.push('--model', opts.model);
      // MCP config injetada → reviewer pode chamar `create_issue` ao achar bug,
      // ou `kb_search` pra verificar convenções/precedentes antes de comentar.
      if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath);
      return { command: 'claude', args, usesStdin: true, streaming: true };
    }
    case 'codex_local':
      return {
        command: 'codex',
        args: [
          'exec',
          '--skip-git-repo-check',
          '--yolo',
          ...(opts.model && opts.model !== 'default' ? ['--model', opts.model] : []),
          '-',
        ],
        usesStdin: true,
        streaming: false,
      };
    case 'gemini_local':
      return { command: 'gemini', args: ['--prompt'], usesStdin: false, streaming: false };
    default:
      throw new Error(`Adapter ${adapter} não suportado pra code review`);
  }
}

/**
 * Parser do `--output-format stream-json` do Claude. Cada linha é um JSON com
 * formato variado; pegamos `content_block_delta` pra remontar o texto final +
 * `result` pra usage. Robusto a linhas inválidas (ignora silenciosamente).
 *
 * Retorna `text` (resposta reconstituída do agente) e `usage` (se disponível).
 */
function parseStreamJsonChunk(
  chunk: string,
  state: { buffer: string; text: string; usage: ReviewUsage | null },
): void {
  state.buffer += chunk;
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() ?? '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt.type === 'stream_event') {
        const event = evt.event as Record<string, unknown> | undefined;
        if (event?.type === 'content_block_delta') {
          const delta = event.delta as { type?: string; text?: string } | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            state.text += delta.text;
          }
        }
      } else if (evt.type === 'assistant') {
        // Fallback pra responses não-streaming dentro do stream-json: alguns CLIs
        // emitem mensagem completa em vez de deltas
        const msg = evt.message as Record<string, unknown> | undefined;
        const content = (msg?.content as Array<{ type?: string; text?: string }>) ?? [];
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            state.text += block.text;
          }
        }
      } else if (evt.type === 'result') {
        const usage = evt.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        state.usage = {
          tokensIn: usage?.input_tokens ?? null,
          tokensOut: usage?.output_tokens ?? null,
          costUsd: typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : null,
        };
      }
    } catch {
      /* linha inválida — ignora */
    }
  }
}

interface ReviewUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

/**
 * Materializa um mcp-config.json temporário pra esse review. Permite que o
 * reviewer chame tools MCP do Orkestral (create_issue, kb_search, etc.). Path
 * é único por reviewId — limpeza fica a cargo do OS no tmpdir.
 */
async function buildReviewMcpConfig(
  reviewId: string,
  workspaceId: string,
  reviewerAgentId?: string | null,
): Promise<string> {
  const { port, token } = await ensureMcpServerStarted();
  const dir = join(tmpdir(), 'orkestral-mcp', `review-${reviewId}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'mcp-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        orkestral: {
          type: 'http',
          url: `http://127.0.0.1:${port}`,
          headers: {
            'x-orkestral-token': token,
            'x-orkestral-workspace': workspaceId,
            // Identifica o reviewer → o MCP manda x-orkestral-agent-id, sem o qual
            // a tool MUTANTE `create_issue` (reviewer abre issue ao achar bug) é
            // recusada pelo gate cross-workspace.
            ...(reviewerAgentId ? { 'x-orkestral-agent-id': reviewerAgentId } : {}),
          },
        },
      },
    }),
  );
  return configPath;
}

/**
 * Limita o diff pra evitar prompts gigantes (custos / context window).
 * Pega as primeiras 1500 linhas — o suficiente pra PRs médios.
 */
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Parseia o diff unificado pra extrair lista de arquivos com adds/dels/status.
 * Trabalha em cima do output `git diff --unified` ou da API do GitHub.
 */
function extractFilesChanged(diff: string): CodeReviewFileChange[] {
  const result: CodeReviewFileChange[] = [];
  const blocks = diff.split(/^diff --git /m).slice(1);
  for (const block of blocks) {
    const header = block.split('\n')[0] ?? '';
    const match = header.match(/a\/(.+?)\s+b\/(.+)$/);
    const filePath = match ? match[2] : null;
    if (!filePath) continue;

    let additions = 0;
    let deletions = 0;
    let status: CodeReviewFileChange['status'] = 'modified';
    if (block.includes('new file mode')) status = 'added';
    else if (block.includes('deleted file mode')) status = 'deleted';
    else if (block.includes('rename from')) status = 'renamed';

    for (const line of block.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
    result.push({ filePath, additions, deletions, status });
  }
  return result;
}

function truncateDiff(diff: string, maxLines = 1500): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  return (
    lines.slice(0, maxLines).join('\n') +
    `\n\n[...diff truncado em ${maxLines} linhas — total: ${lines.length} linhas]`
  );
}

/**
 * Varre `text` a partir do primeiro `{` e devolve o primeiro objeto JSON
 * balanceado (considerando strings e escapes), ignorando prosa antes/depois.
 * Mais robusto que `indexOf('{')` + `lastIndexOf('}')`, que quebra quando há
 * texto extra (com chaves) depois do JSON.
 */
export function extractFirstJsonObject(raw: string): string | null {
  if (!raw) return null;
  const start = raw.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1).trim();
    }
  }
  return null;
}

/**
 * Extrai o primeiro bloco JSON da resposta do LLM. Tolera respostas que
 * envolveram o JSON em markdown ou texto adicional.
 */
function extractJson(text: string): ParsedReview | null {
  const attempts: string[] = [];
  const t = text.trim();
  attempts.push(t);

  // Remove code fences ```json ... ``` ou ``` ... ``` em qualquer lugar
  const fenceMatch = /```(?:json|JSON)?\s*\n?([\s\S]+?)\n?```/.exec(t);
  if (fenceMatch) {
    const fenced = fenceMatch[1].trim();
    attempts.push(fenced);
    // Dentro da cerca ainda pode haver prosa em volta do objeto.
    const fromFence = extractFirstJsonObject(fenced);
    if (fromFence) attempts.push(fromFence);
  }

  // Primeiro objeto `{ ... }` balanceado (string/escape aware) — robusto a
  // texto adicional (incl. chaves) depois do JSON.
  const balanced = extractFirstJsonObject(t);
  if (balanced) attempts.push(balanced);

  // Fallback legado: primeiro { até último } balanceado.
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    attempts.push(t.slice(start, end + 1));
  }

  for (const raw of attempts) {
    const candidates = [raw, repairJson(raw)];
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as ParsedReview;
      } catch {
        // tenta o próximo
      }
    }
  }
  return null;
}

/**
 * Conserta erros comuns de LLMs em JSON:
 *  - trailing commas em arrays/objects
 *  - smart quotes → ASCII
 *  - comentários // e /* * /
 */
function repairJson(input: string): string {
  let s = input;
  // Smart quotes → ASCII (cuidadoso: só substitui curly quotes)
  s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  // Remove comentários de linha // ... (fora de strings — abordagem simples)
  s = s.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  // Remove comentários de bloco /* ... */
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  // Trailing commas: ,} ou ,]
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return s.trim();
}

interface RunCodeReviewInput {
  workspaceId: string;
  repoFullName: string;
  prNumber: number;
  reviewerAgentId?: string | null;
  /** PRs adicionais que entram juntos no prompt (ex: back+front). */
  linkedPrs?: import('../../shared/types').CodeReviewLinkedPr[];
}

/**
 * Roda uma code review completa.
 *   1. Fetch PR + diff via GitHub API
 *   2. Spawn agent CLI com prompt + diff
 *   3. Parse JSON da resposta
 *   4. Persist review + comments
 *   5. Activity log
 */
/**
 * Inicia uma code review. Retorna o reviewId IMEDIATAMENTE pra UI poder
 * subscrever aos eventos. O trabalho pesado continua async em background.
 */
export function runCodeReview(input: RunCodeReviewInput): Promise<string> {
  // Resolve reviewer
  const workspaceAgents = agentRepo.listByWorkspace(input.workspaceId);
  const defaultReviewer =
    workspaceAgents.find((agent) =>
      /code[-\s_]?review|reviewer/.test(
        `${agent.role} ${agent.name} ${agent.title ?? ''}`.toLowerCase(),
      ),
    ) ?? agentRepo.getOrchestrator(input.workspaceId);
  const reviewerId = input.reviewerAgentId ?? defaultReviewer?.id ?? null;
  const reviewer = reviewerId ? agentRepo.get(reviewerId) : null;

  // Cria o registro com placeholders — depois ajusta com dados reais do PR
  const review = reviewRepo.start({
    workspaceId: input.workspaceId,
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
    prTitle: `PR #${input.prNumber}`,
    prAuthor: null,
    headRef: null,
    baseRef: null,
    headSha: null,
    htmlUrl: `https://github.com/${input.repoFullName}/pull/${input.prNumber}`,
    reviewerAgentId: reviewer?.id ?? null,
    linkedPrs: input.linkedPrs,
  });

  emitReviewEvent({
    type: 'review-started',
    reviewId: review.id,
    workspaceId: input.workspaceId,
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
  });

  // Fire-and-forget: continua a pipeline em background
  setImmediate(() => {
    void processReview(review.id, input, reviewer).catch((err) => {
      console.error('[code-review] erro inesperado na pipeline:', err);
      failReview(
        review.id,
        `Erro inesperado: ${err instanceof Error ? err.message : String(err)}`,
        input.workspaceId,
        reviewer?.id,
        input.prNumber,
      );
    });
  });

  return Promise.resolve(review.id);
}

/**
 * Pipeline async: fetch PR, spawn CLI, parse, persist. Não throws — todos
 * os erros viram `failReview()`.
 */
async function processReview(
  reviewId: string,
  input: RunCodeReviewInput,
  reviewer: ReturnType<AgentRepository['get']>,
): Promise<void> {
  // 3) Valida reviewer
  if (!reviewer || !reviewer.adapterType) {
    const msg = reviewer
      ? `O agente "${reviewer.name}" não tem adapter configurado. Vá em Configurações do agente → Adapter e escolha um (Claude / Codex / Gemini).`
      : 'Nenhum agente disponível pra rodar a review. Crie um agente CEO/orchestrator, ou escolha explicitamente um agente reviewer.';
    failReview(reviewId, msg, input.workspaceId, reviewer?.id, input.prNumber);
    return;
  }

  emitReviewEvent({
    type: 'review-phase',
    reviewId: reviewId,
    phase: 'fetch',
    message: 'Buscando PR e diff no GitHub…',
  });

  // 4) Fetch PR + diff — falhas viram fail() no DB
  let pr: Awaited<ReturnType<typeof fetchPullRequest>>;
  let diff: string;
  try {
    [pr, diff] = await Promise.all([
      fetchPullRequest(input.repoFullName, input.prNumber),
      fetchPullRequestDiff(input.repoFullName, input.prNumber),
    ]);
  } catch (err) {
    const msg = `Não foi possível buscar o PR no GitHub: ${err instanceof Error ? err.message : String(err)}`;
    failReview(reviewId, msg, input.workspaceId, reviewer.id, input.prNumber);
    return;
  }

  // Atualiza com os dados reais (head_sha pra postar review depois)
  reviewRepo.updateMetadata(reviewId, {
    prTitle: pr.title,
    prAuthor: pr.author,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    headSha: pr.headSha,
    htmlUrl: pr.htmlUrl,
  });

  emitReviewEvent({
    type: 'review-phase',
    reviewId: reviewId,
    phase: 'prompt',
    message: `Montando prompt + diff (${diff.split('\n').length} linhas)`,
  });

  // 4.5) Linked PRs — busca cada um, anexa diff resumido no prompt
  type LinkedDiff = {
    repoFullName: string;
    prNumber: number;
    prTitle: string;
    role?: string | null;
    diff: string;
  };
  const linkedDiffs: LinkedDiff[] = [];
  if (input.linkedPrs && input.linkedPrs.length > 0) {
    emitReviewEvent({
      type: 'review-phase',
      reviewId,
      phase: 'fetch',
      message: `Buscando ${input.linkedPrs.length} PR(s) linkado(s)…`,
    });
    for (const lp of input.linkedPrs) {
      try {
        const [linkedPr, linkedDiff] = await Promise.all([
          fetchPullRequest(lp.repoFullName, lp.prNumber),
          fetchPullRequestDiff(lp.repoFullName, lp.prNumber),
        ]);
        linkedDiffs.push({
          repoFullName: lp.repoFullName,
          prNumber: lp.prNumber,
          prTitle: linkedPr.title,
          role: lp.role ?? null,
          diff: linkedDiff,
        });
      } catch (err) {
        // Se um falhar, continua os outros — só loga
        console.warn(
          `[code-review] linked PR ${lp.repoFullName}#${lp.prNumber} falhou:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // 5) Monta prompt completo
  ensureDefaultInstructions(reviewer);
  const agentInstructions = readRuntimeInstructionContext(reviewer);
  // Truncamos diffs proporcionalmente quando há vários
  const totalPrs = 1 + linkedDiffs.length;
  const linesPerPr = totalPrs === 1 ? 1500 : Math.max(400, Math.floor(2400 / totalPrs));
  const truncatedDiff = truncateDiff(diff, linesPerPr);
  const parts: string[] = [];
  if (agentInstructions.trim()) parts.push(agentInstructions.trim());
  parts.push(CODE_REVIEW_PROMPT.replace('{{LANG}}', activeLanguageName()));

  if (linkedDiffs.length > 0) {
    parts.push(
      `# ATENÇÃO: Análise multi-PR\n\n` +
        `Esta análise cobre ${totalPrs} pull requests relacionados ` +
        `(ex: backend + frontend). Avalie o conjunto — bugs cross-stack, ` +
        `inconsistências de contrato, payloads que não casam, race conditions ` +
        `entre os PRs. No \`walkthrough\` e nos \`comments\`, use o filePath ` +
        `prefixado com o repo entre colchetes: ex \`[ezsoft/api]src/auth.ts\`.`,
    );
  }

  // PR principal
  parts.push(
    `# Pull Request principal\n\n` +
      `**Título**: ${pr.title}\n` +
      `**Repo**: ${input.repoFullName} (#${pr.number})\n` +
      `**Base → Head**: ${pr.baseRef} ← ${pr.headRef}\n` +
      `**Autor**: ${pr.author ?? 'desconhecido'}\n\n` +
      `## Diff\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\``,
  );

  // Diffs linkados
  for (const lp of linkedDiffs) {
    const linkedTruncated = truncateDiff(lp.diff, linesPerPr);
    parts.push(
      `# PR linkado${lp.role ? ` (${lp.role})` : ''}\n\n` +
        `**Título**: ${lp.prTitle}\n` +
        `**Repo**: ${lp.repoFullName} (#${lp.prNumber})\n\n` +
        `## Diff\n\n\`\`\`diff\n${linkedTruncated}\n\`\`\``,
    );
  }

  const finalPrompt = parts.join('\n\n---\n\n');

  // 6) Build MCP config + CLI command
  let mcpConfigPath: string | null = null;
  try {
    mcpConfigPath = await buildReviewMcpConfig(reviewId, input.workspaceId, reviewer.id);
  } catch (err) {
    console.warn(
      '[code-review] MCP config falhou — reviewer roda sem tools:',
      err instanceof Error ? err.message : err,
    );
    // não-fatal: o review ainda roda, só sem `create_issue`/`kb_search`
  }
  let cmd;
  try {
    cmd = buildAdapterCommand(reviewer.adapterType, {
      model: reviewer.model,
      mcpConfigPath,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failReview(reviewId, msg, input.workspaceId, reviewer.id, pr.number);
    return;
  }

  emitReviewEvent({
    type: 'review-phase',
    reviewId: reviewId,
    phase: 'spawn',
    message: `Iniciando ${cmd.command}${reviewer.model ? ` (${reviewer.model})` : ''}…`,
  });

  const ws = workspaceRepo.listAll().find((w) => w.id === input.workspaceId);
  const cwd = ws?.path && existsSync(ws.path) ? ws.path : undefined;
  const args = cmd.usesStdin ? cmd.args : [...cmd.args, finalPrompt];

  let child: ChildProcess;
  try {
    child = spawn(cmd.command, args, {
      env: scrubSpawnEnv(),
      shell: false,
      cwd,
    });
  } catch (err) {
    const msg = `Não foi possível iniciar o CLI "${cmd.command}". Confirme que ele está instalado e no PATH. Detalhe: ${err instanceof Error ? err.message : String(err)}`;
    failReview(reviewId, msg, input.workspaceId, reviewer.id, pr.number);
    return;
  }
  activeReviewProcesses.set(reviewId, child);

  // Acumuladores. Quando streaming=true, `stdout` é populado pelo parser
  // (extraindo apenas text deltas); senão, é o output raw do CLI.
  let stdout = '';
  let stderr = '';
  const streamState = { buffer: '', text: '', usage: null as ReviewUsage | null };
  child.stdout?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => {
    if (cmd.streaming) {
      parseStreamJsonChunk(chunk, streamState);
      stdout = streamState.text;
      // Pra UX da modal, ainda emitimos o text reconstruído (não os JSON internos)
      emitReviewEvent({ type: 'review-stdout', reviewId, chunk: '' });
    } else {
      stdout += chunk;
      emitReviewEvent({ type: 'review-stdout', reviewId, chunk });
    }
  });
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
    emitReviewEvent({ type: 'review-stderr', reviewId: reviewId, chunk });
  });

  if (cmd.usesStdin && child.stdin) {
    child.stdin.write(finalPrompt);
    child.stdin.end();
  } else if (child.stdin) {
    child.stdin.end();
  }

  emitReviewEvent({
    type: 'review-phase',
    reviewId: reviewId,
    phase: 'analyzing',
    message: 'Agente analisando o PR…',
  });

  // Aguarda fim do processo
  const exitCode: number = await new Promise((resolve) => {
    child.on('error', (err) => {
      stderr += `\nspawn error: ${err.message}`;
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? 0));
  });
  activeReviewProcesses.delete(reviewId);

  if (exitCode !== 0 && stdout.length === 0) {
    const cliErr = stderr.trim() || `CLI terminou com código ${exitCode}`;
    const msg =
      `O CLI "${cmd.command}" falhou (exit ${exitCode}).\n\n` +
      `Stderr:\n${cliErr.slice(0, 1800)}\n\n` +
      `Verifique: (1) o binário está instalado e no PATH, (2) as credenciais/API key estão certas, ` +
      `(3) o adapter "${reviewer.adapterType}" está acessível.`;
    failReview(reviewId, msg, input.workspaceId, reviewer.id, pr.number);
    return;
  }

  emitReviewEvent({
    type: 'review-phase',
    reviewId: reviewId,
    phase: 'parse',
    message: 'Interpretando resposta do agente…',
  });

  const parsed = extractJson(stdout);
  if (!parsed || !Array.isArray(parsed.comments)) {
    const preview = stdout.slice(0, 1500);
    const msg =
      `Não foi possível interpretar a resposta do agente como JSON.\n\n` +
      `O agente precisa retornar APENAS um bloco JSON — sem markdown, sem prefixo. ` +
      `Verifique o AGENTS.md do agente.\n\n` +
      `### Output recebido (primeiros 1500 chars):\n${preview || '(vazio)'}`;
    failReview(reviewId, msg, input.workspaceId, reviewer.id, pr.number);
    return;
  }

  const comments = parsed.comments
    .map((c) => ({
      filePath: String(c.filePath ?? '').trim(),
      lineStart: typeof c.line === 'number' ? c.line : (c.lineStart ?? null),
      lineEnd: typeof c.lineEnd === 'number' ? c.lineEnd : null,
      kind: (c.kind ?? 'suggestion') as CodeReviewCommentKind,
      severity: (c.severity ?? 'info') as CodeReviewSeverity,
      title: c.title ? String(c.title).slice(0, 120) : null,
      message: String(c.message ?? '').trim(),
      suggestion: c.suggestion ? String(c.suggestion) : null,
      codeContext: c.codeContext ? String(c.codeContext) : null,
    }))
    .filter((c) => c.filePath && c.message);

  const walkthrough: CodeReviewWalkthroughItem[] = Array.isArray(parsed.walkthrough)
    ? parsed.walkthrough
        .map((w) => ({
          filePath: String(w.filePath ?? '').trim(),
          summary: String(w.summary ?? '').trim(),
          changeKind: (VALID_CHANGE_KINDS.includes(w.changeKind as CodeReviewChangeKind)
            ? w.changeKind
            : 'chore') as CodeReviewChangeKind,
        }))
        .filter((w) => w.filePath && w.summary)
    : [];

  const highlights = Array.isArray(parsed.highlights)
    ? parsed.highlights.map((h) => String(h).trim()).filter(Boolean)
    : [];
  const concerns = Array.isArray(parsed.concerns)
    ? parsed.concerns.map((h) => String(h).trim()).filter(Boolean)
    : [];

  const rating = typeof parsed.rating === 'number' ? clamp(parsed.rating, 0, 10) : null;
  const effort = VALID_EFFORTS.includes(parsed.effort as CodeReviewEffort)
    ? (parsed.effort as CodeReviewEffort)
    : null;
  const recommendation = VALID_RECOMMENDATIONS.includes(
    parsed.recommendation as CodeReviewRecommendation,
  )
    ? (parsed.recommendation as CodeReviewRecommendation)
    : null;

  reviewRepo.finishSuccess(
    reviewId,
    {
      summary: String(parsed.summary ?? '').trim(),
      riskLevel: String(parsed.risk ?? 'low').toLowerCase(),
      rating,
      effort,
      recommendation,
      testsAssessment: parsed.testsAssessment ? String(parsed.testsAssessment).trim() : null,
      walkthrough,
      filesChanged: extractFilesChanged(diff),
      highlights,
      concerns,
    },
    comments,
  );

  activityRepo.log({
    workspaceId: input.workspaceId,
    kind: 'code_review.completed',
    actorKind: 'agent',
    actorId: reviewer.id,
    subjectKind: 'code_review',
    subjectId: reviewId,
    title: `Code review do PR #${pr.number}: ${comments.length} comments`,
    payload: { risk: parsed.risk, totalComments: comments.length },
  });

  emitReviewEvent({ type: 'review-finished', reviewId: reviewId, status: 'completed' });

  return;
}

/**
 * Helper: salva o erro na review row, emite evento, registra activity.
 */
function failReview(
  reviewId: string,
  message: string,
  workspaceId: string,
  reviewerId: string | undefined,
  prNumber: number,
): void {
  reviewRepo.fail(reviewId, message.slice(0, 4000));
  activityRepo.log({
    workspaceId,
    kind: 'code_review.failed',
    actorKind: reviewerId ? 'agent' : 'system',
    actorId: reviewerId ?? null,
    subjectKind: 'code_review',
    subjectId: reviewId,
    title: `Code review do PR #${prNumber} falhou`,
    payload: { error: message.slice(0, 500) },
  });
  emitReviewEvent({ type: 'review-finished', reviewId, status: 'failed' });
}

/**
 * Pega o diff do PR + parseia em hunks por arquivo. Útil pra UI mostrar
 * o conteúdo do diff dentro do app sem ter que abrir o GitHub.
 */
export async function getDiffByFile(
  repoFullName: string,
  prNumber: number,
): Promise<{ diff: string; files: Array<{ filePath: string; hunk: string }> }> {
  const diff = await fetchPullRequestDiff(repoFullName, prNumber);
  const blocks = diff.split(/^diff --git /m).slice(1);
  const files: Array<{ filePath: string; hunk: string }> = [];
  for (const block of blocks) {
    const header = block.split('\n')[0] ?? '';
    const match = header.match(/a\/(.+?)\s+b\/(.+)$/);
    const filePath = match ? match[2] : null;
    if (!filePath) continue;
    files.push({ filePath, hunk: 'diff --git ' + block });
  }
  return { diff, files };
}

/**
 * `lineStart`/`lineEnd` vêm da numeração do diff (`@@ -X,Y +A,B @@`), que NÃO
 * corresponde de forma confiável aos índices do arquivo local atual — o arquivo
 * pode ter mudado desde a análise. Escrever direto nesses índices corrompe o
 * arquivo. Esta função ancora pelo CONTEÚDO (`codeContext`) pra achar a posição
 * real das linhas-alvo e retorna o range `[startIdx, endIdx]` (0-based,
 * inclusivo) a substituir.
 *
 * SEGURANÇA EM PRIMEIRO LUGAR: isto escreve no arquivo-fonte real do usuário.
 * Em QUALQUER dúvida, retorna `null` pro chamador abortar e pedir aplicação
 * manual — nunca arrisca corromper.
 *
 * Regras:
 *  1. O `codeContext` é localizado como um bloco CONTÍGUO no arquivo, comparando
 *     COM a indentação original (sem trim) e incluindo linhas em branco.
 *  2. O match precisa ser ÚNICO e exato: 0 ou >1 ocorrências → aborta. A âncora
 *     precisa ter ≥ 2 linhas não-triviais (não-vazias) — âncora de 1 linha comum
 *     casa em qualquer lugar → aborta.
 *  3. Substitui APENAS a sub-faixa alvo (`lineStart..lineEnd`) DENTRO do bloco
 *     localizado. Quando o alvo cobre o bloco inteiro (offset inequívoco), troca
 *     o bloco todo. Quando o alvo é MENOR que o bloco, o offset exato do alvo não
 *     é recuperável com segurança (a linha de origem do bloco não é persistida e
 *     os números do diff podem ter driftado) → aborta, pra não deletar contexto.
 *
 * Exportada só pra teste unitário (lógica pura, sem I/O).
 */
export function anchorSuggestionRange(
  lines: string[],
  codeContext: string | null,
  lineStart: number,
  lineEnd: number,
): { startIdx: number; endIdx: number } | null {
  // Linhas de âncora a partir do codeContext, PRESERVANDO indentação e brancos.
  // (Apenas remove um único \r de CRLF e um possível \n/linha em branco final do
  // bloco, que costumam ser artefato de serialização, não conteúdo real.)
  let ctxLines = (codeContext ?? '').replace(/\r\n/g, '\n').split('\n');
  while (ctxLines.length > 0 && ctxLines[ctxLines.length - 1] === '') {
    ctxLines = ctxLines.slice(0, -1);
  }

  // Bloco vazio: sem contexto pra ancorar com segurança. Aborta.
  if (ctxLines.length === 0) return null;

  // Exige ≥ 2 linhas não-triviais. Uma âncora de 1 linha (ou só brancos/chaves)
  // casa indiscriminadamente e levaria a escrever no lugar errado. Aborta.
  const nonTrivial = ctxLines.filter((l) => l.trim().length > 0);
  if (nonTrivial.length < 2) return null;

  // Acha TODAS as ocorrências do bloco como sequência contígua e EXATA (com
  // indentação e linhas em branco) no arquivo atual.
  const matchesAt = (idx: number): boolean => {
    if (idx + ctxLines.length > lines.length) return false;
    for (let i = 0; i < ctxLines.length; i++) {
      if (lines[idx + i] !== ctxLines[i]) return false;
    }
    return true;
  };
  const starts: number[] = [];
  for (let idx = 0; idx + ctxLines.length <= lines.length; idx++) {
    if (matchesAt(idx)) starts.push(idx);
  }

  // Precisa ser ÚNICO: 0 ocorrências (contexto sumiu/mudou) ou >1 (ambíguo) →
  // aborta em vez de chutar a posição.
  if (starts.length !== 1) return null;

  const blockStart = starts[0];
  const blockLen = ctxLines.length;

  // Faixa alvo (lineStart..lineEnd) na numeração do diff. lineEnd pode vir nulo
  // (mapeado pra lineStart pelo chamador), então o span mínimo é 1.
  const targetSpan = Math.max(1, lineEnd - lineStart + 1);

  // O alvo não pode ser maior que o bloco de contexto — se for, o codeContext
  // não envolve o alvo e não dá pra preservar contexto com confiança. Aborta.
  if (targetSpan > blockLen) return null;

  // A origem do bloco na numeração do diff NÃO é persistida. Quando o alvo cobre
  // o bloco inteiro (caso comum: a suggestion reescreve exatamente o trecho
  // mostrado), o offset é inequívoco (0) e substituímos o bloco todo.
  if (targetSpan === blockLen) {
    return { startIdx: blockStart, endIdx: blockStart + blockLen - 1 };
  }

  // Alvo MENOR que o bloco: o codeContext tem linhas de contexto extras antes
  // e/ou depois do alvo, mas o offset exato do alvo dentro do bloco não é
  // recuperável de forma confiável (números de linha do diff podem ter driftado,
  // e a linha de origem do bloco não é guardada). Chutar o offset arriscaria
  // sobrescrever a linha errada e DELETAR contexto. SEGURANÇA EM PRIMEIRO LUGAR:
  // aborta e deixa o chamador pedir aplicação manual.
  return null;
}

/**
 * Resolve o `filePath` de um comentário dentro do `workspaceRoot`, garantindo
 * que o alvo fique CONTIDO no workspace (anti path traversal). O `filePath`
 * vem cru do JSON do LLM e em fluxos multi-PR pode ter o prefixo `[repo-name]`
 * (ex.: `[ezsoft/api]src/auth.ts`) — esse prefixo é removido ANTES da checagem
 * pra que a verificação enxergue o path relativo real.
 *
 * Retorna o path absoluto validado, ou `null` se o filePath for absoluto ou
 * escapar do workspace (`../`, etc.) — nesse caso o chamador deve recusar.
 */
export function resolveSuggestionTarget(workspaceRoot: string, filePath: string): string | null {
  // Remove o prefixo `[repo-name]` do fluxo multi-PR (só no começo da string),
  // deixando o path relativo real pra checagem de contenção.
  const cleanedFilePath = filePath.replace(/^\[[^\]]*\]/, '');

  const root = resolve(workspaceRoot);
  const resolved = resolve(workspaceRoot, cleanedFilePath);

  // Recusa paths absolutos no input cru e qualquer alvo que escape do root.
  if (isAbsolute(filePath) || (resolved !== root && !resolved.startsWith(root + sep))) {
    return null;
  }
  return resolved;
}

/**
 * Aplica a `suggestion` de um comentário no arquivo local. Substitui as
 * linhas-alvo pelo conteúdo da suggestion, ancorando a posição pelo CONTEÚDO
 * (`codeContext`) em vez de confiar nos números de linha do diff. Marca o
 * comentário como resolvido. Retorna o path absoluto modificado.
 */
export async function applyCommentSuggestion(commentId: string): Promise<{
  ok: boolean;
  appliedTo: string;
}> {
  const fs = await import('node:fs');
  const { getDatabase } = await import('../db/connection');
  const { codeReviewComments } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const db = getDatabase();
  const row = db
    .select()
    .from(codeReviewComments)
    .where(eq(codeReviewComments.id, commentId))
    .get();
  if (!row) throw new Error('Comentário não encontrado');
  if (!row.suggestion) throw new Error('Esse comentário não tem suggestion pra aplicar');
  if (row.lineStart == null)
    throw new Error('Comentário sem linha alvo — não dá pra aplicar automaticamente');

  const review = reviewRepo.get(row.reviewId);
  if (!review) throw new Error('Review do comentário não encontrada');
  const workspace = workspaceRepo.listAll().find((w) => w.id === review.workspaceId);
  if (!workspace?.path) throw new Error('Workspace sem path local — não dá pra aplicar suggestion');

  // SEGURANÇA: o filePath vem cru do JSON do LLM (persistido sem sanitização) e
  // pode ser absoluto ou conter `../` pra escapar do workspace. Resolve com
  // checagem de contenção (e remove o prefixo `[repo-name]` do fluxo multi-PR)
  // ANTES de qualquer escrita. Recusa se o alvo cair fora do workspace.
  const target = resolveSuggestionTarget(workspace.path, row.filePath);
  if (!target) {
    throw new Error(
      `Caminho "${row.filePath}" aponta pra fora do workspace — aplicação recusada por segurança`,
    );
  }
  if (!fs.existsSync(target)) {
    throw new Error(`Arquivo "${row.filePath}" não existe no workspace local`);
  }
  const content = fs.readFileSync(target, 'utf-8');
  const lines = content.split('\n');

  // Ancora pelo conteúdo: os números de linha vêm da numeração do diff e podem
  // não corresponder ao arquivo local atual. Se as linhas "driftaram" e não dá
  // pra localizar o trecho com segurança, aborta em vez de corromper o arquivo.
  const range = anchorSuggestionRange(
    lines,
    row.codeContext,
    row.lineStart,
    row.lineEnd ?? row.lineStart,
  );
  if (!range) {
    throw new Error(
      'As linhas do arquivo mudaram desde a análise — não dá pra localizar o trecho com segurança. Aplique a suggestion manualmente.',
    );
  }

  const newLines = [
    ...lines.slice(0, range.startIdx),
    ...row.suggestion.split('\n'),
    ...lines.slice(range.endIdx + 1),
  ];
  fs.writeFileSync(target, newLines.join('\n'), 'utf-8');

  reviewRepo.updateCommentResolution(commentId, 'resolved');

  return { ok: true, appliedTo: target };
}

/**
 * Cancela uma review em andamento (mata o processo CLI).
 */
export function cancelCodeReview(reviewId: string): boolean {
  const child = activeReviewProcesses.get(reviewId);
  if (!child) return false;
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 2000);
  } catch {
    // ignore
  }
  activeReviewProcesses.delete(reviewId);
  failReview(reviewId, 'Análise cancelada pelo usuário.', '', undefined, 0);
  return true;
}

/**
 * Posta os comentários da review no GitHub como um único review com
 * inline comments. Summary vai no body do review.
 */
export async function postReviewToGithub(reviewId: string): Promise<void> {
  const review = reviewRepo.get(reviewId);
  if (!review) throw new Error('Review não encontrada');
  if (review.status !== 'completed') {
    throw new Error('Review precisa estar completed pra ser postada');
  }
  if (!review.headSha) {
    throw new Error('Review sem head_sha — refaça a análise');
  }
  const comments = reviewRepo.listComments(reviewId);
  type Cmt = (typeof comments)[number];
  const bodyFor = (c: Cmt): string =>
    c.suggestion
      ? `**${labelForKind(c.kind)} · ${c.severity}**\n\n${c.message}\n\n\`\`\`suggestion\n${c.suggestion}\n\`\`\``
      : `**${labelForKind(c.kind)} · ${c.severity}**\n\n${c.message}`;

  // O GitHub recusa (HTTP 422) o review INTEIRO se QUALQUER comentário inline aponta
  // pra um path/linha fora do diff do PR. Validamos cada um contra as linhas
  // comentáveis do diff (lado RIGHT): os que resolvem viram inline, os que NÃO (linha
  // removida, arquivo fora do PR, linha defasada) vão pro CORPO da review, sem perder.
  let commentable: Map<string, Set<number>> | null = null;
  try {
    commentable = parseDiffNewLines(
      await fetchPullRequestDiff(review.repoFullName, review.prNumber),
    );
  } catch {
    commentable = null; // sem diff: posta tudo no corpo (não arrisca o 422).
  }

  const inlineComments: { path: string; line: number; body: string }[] = [];
  const orphans: Cmt[] = [];
  for (const c of comments) {
    if (c.lineStart != null && commentable?.get(c.filePath)?.has(c.lineStart)) {
      inlineComments.push({ path: c.filePath, line: c.lineStart, body: bodyFor(c) });
    } else {
      orphans.push(c);
    }
  }

  const orphanSection = (list: Cmt[]): string =>
    list.length === 0
      ? ''
      : '\n\n---\n#### Comentários fora do diff\n' +
        list
          .map((c) => {
            const loc =
              c.lineStart != null ? `\`${c.filePath}:${c.lineStart}\`` : `\`${c.filePath}\``;
            return `- ${labelForKind(c.kind)} · ${c.severity} · ${loc}\n  ${c.message.replace(/\n/g, '\n  ')}`;
          })
          .join('\n');

  const base = formatSummaryBody(review, comments.length);
  const post = (
    inline: { path: string; line: number; body: string }[],
    body: string,
  ): Promise<{ id: string }> =>
    postReview({
      ownerRepo: review.repoFullName,
      prNumber: review.prNumber,
      commitSha: review.headSha as string,
      body,
      event: 'COMMENT',
      comments: inline,
    });

  let posted: { id: string };
  try {
    posted = await post(inlineComments, base + orphanSection(orphans));
  } catch (err) {
    // Cinto e suspensório: se mesmo validado o GitHub recusar os inline (diff defasou
    // entre a análise e o post), reposta TUDO no corpo, sem inline. A review sempre sai.
    const msg = err instanceof Error ? err.message : String(err);
    if (inlineComments.length > 0 && /HTTP 422/.test(msg)) {
      posted = await post([], base + orphanSection(comments));
    } else {
      throw err;
    }
  }

  reviewRepo.markPostedToGithub(reviewId, posted.id);
  activityRepo.log({
    workspaceId: review.workspaceId,
    kind: 'code_review.posted_to_github',
    subjectKind: 'code_review',
    subjectId: review.id,
    title: `Review do PR #${review.prNumber} postada no GitHub`,
    payload: { githubReviewId: posted.id },
  });
}

/**
 * Linhas COMENTÁVEIS por arquivo no lado NEW/RIGHT do diff unified (contexto +
 * adicionadas). O GitHub só aceita comentário inline numa linha que está no diff;
 * usamos isto pra filtrar antes de postar e evitar o 422 que derruba a review inteira.
 */
export function parseDiffNewLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let path: string | null = null;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim().replace(/^b\//, '');
      path = p === '/dev/null' ? null : p;
      if (path && !map.has(path)) map.set(path, new Set());
      inHunk = false;
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !path) continue;
    if (raw.startsWith('-')) continue; // linha removida: não avança o lado NEW
    if (raw.startsWith('+') || raw.startsWith(' ')) {
      map.get(path)?.add(newLine);
      newLine++;
    }
  }
  return map;
}

function labelForKind(kind: CodeReviewCommentKind): string {
  return {
    bug: '🐛 Bug',
    suggestion: '💡 Sugestão',
    security: '🔒 Segurança',
    style: '🎨 Estilo',
    performance: '⚡ Performance',
    question: '❓ Dúvida',
  }[kind];
}

function formatSummaryBody(
  review: ReturnType<CodeReviewRepository['get']>,
  totalComments: number,
): string {
  if (!review) return '';
  const lines: string[] = [];
  lines.push(`### 🤖 Code review by Orkestral\n`);
  if (review.summary) {
    lines.push(review.summary);
    lines.push('');
  }
  lines.push(`**Risk level:** ${review.riskLevel ?? 'low'}`);
  lines.push(`**Total comments:** ${totalComments}`);
  const breakdown: string[] = [];
  if (review.bugCount) breakdown.push(`🐛 ${review.bugCount} bug${review.bugCount > 1 ? 's' : ''}`);
  if (review.securityCount) breakdown.push(`🔒 ${review.securityCount} security`);
  if (review.suggestionCount) breakdown.push(`💡 ${review.suggestionCount} sugestões`);
  if (review.performanceCount) breakdown.push(`⚡ ${review.performanceCount} performance`);
  if (review.styleCount) breakdown.push(`🎨 ${review.styleCount} style`);
  if (review.questionCount) breakdown.push(`❓ ${review.questionCount} dúvidas`);
  if (breakdown.length > 0) {
    lines.push('');
    lines.push(breakdown.join(' · '));
  }
  return lines.join('\n');
}
