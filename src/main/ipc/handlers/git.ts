/**
 * IPC handlers das operações git (Code Changes page).
 *
 * Resolução: cada call recebe `sourceId` → busca path local via repo →
 * delega pro `git-service`. Concentra a validação aqui pra os services
 * ficarem agnósticos.
 */

import { shell } from '../../platform/electron';
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { registerHandler } from '../register';
import { broadcast } from '../../platform/host';
import { openPathSafe } from '../../utils/safe-shell';
import { atomicWriteFileSync } from '../../utils/atomic-write';
import { WorkspaceSourceRepository } from '../../db/repositories/workspace-source.repo';
import { IssueRepository } from '../../db/repositories/issue.repo';
import {
  gitStatus,
  gitInit,
  gitDiff,
  gitBranches,
  gitCheckoutBranch,
  gitCreateBranch,
  gitStage,
  gitUnstage,
  gitCommit,
  gitPush,
  gitFetch,
  gitLog,
  gitApplyReversePatch,
  gitDiscard,
  gitShowCommit,
  gitCommitFileDiff,
  gitPull,
  gitCurrentBranch,
  gitRangeDiff,
} from '../../services/git-service';
import {
  createPullRequest,
  fetchRepoDefaultBranch,
  getDecryptedToken,
} from '../../services/github';
import { getSmartExecConfig, isForgeBundled } from '../../services/smart-exec/config';
import { llamaChat } from '../../services/smart-exec/llama-runtime';
import { invalidateExecutionLearningByIssue } from '../../services/kb-learning';
import { readIssueChangeSnapshot } from '../../services/issue-change-snapshot';

const sourceRepo = new WorkspaceSourceRepository();
const issueRepo = new IssueRepository();

/** Cap do diff combinado enviado ao modelo — segura o contexto local. */
const SUGGEST_DIFF_CAP = 6000;

function broadcastIssuesChanged(workspaceId: string, reason: string): void {
  // broadcast (host): janelas quando existem + pushBus (gateway/CLI headless).
  broadcast('issues:changed-by-mcp', { workspaceId, reason });
}

function markIssueUndone(issueId: string, reason: string, snapshotId?: string): void {
  const issue = issueRepo.get(issueId);
  if (!issue) return;
  const metadata = (issue.metadata as Record<string, unknown> | null) ?? {};
  issueRepo.update(issue.id, {
    status: 'cancelled',
    metadata: {
      ...metadata,
      lastCodeChangeBlock: undefined,
      verification: 'unverified',
      undoneAt: new Date().toISOString(),
      undoneReason: reason,
      ...(snapshotId ? { undoneSnapshotId: snapshotId } : {}),
    },
  });
  if (issue.parentIssueId) issueRepo.syncEpicStatus(issue.parentIssueId);
  broadcastIssuesChanged(issue.workspaceId, 'issue-undone');
}

function wasIssueSnapshotAlreadyUndone(issueId: string | undefined, snapshotId: string): boolean {
  if (!issueId) return false;
  const issue = issueRepo.get(issueId);
  const metadata = (issue?.metadata as Record<string, unknown> | null) ?? {};
  return issue?.status === 'cancelled' && metadata.undoneSnapshotId === snapshotId;
}

/** Extrai o primeiro bloco JSON `{...}` de um texto livre do modelo. */
function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  // Varre balanceando chaves pra achar o fim do primeiro objeto.
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Fallback determinístico a partir dos nomes de arquivo — nunca falha. */
function heuristicCommitMessage(files: string[]): { summary: string; description: string } {
  const clean = files.filter(Boolean);
  if (clean.length === 0) {
    return { summary: 'Atualiza arquivos', description: '' };
  }
  const summary =
    clean.length === 1
      ? `Atualiza ${clean[0].split('/').pop() ?? clean[0]}`
      : `Atualiza ${clean.length} arquivos`;
  const description =
    clean.length === 1
      ? ''
      : clean
          .slice(0, 8)
          .map((f) => `- ${f}`)
          .join('\n');
  return { summary, description };
}

/**
 * Gera uma mensagem de commit a partir do diff atual. Tenta o modelo local
 * (Orkestral Forge) e, em QUALQUER falha (modelo ausente, timeout, parse,
 * diff vazio), cai no fallback heurístico. Nunca propaga erro pra UI.
 */
async function suggestCommitMessage(
  repoPath: string,
  requestedFiles?: string[],
): Promise<{ summary: string; description: string }> {
  let files: string[] = [];
  try {
    if (requestedFiles && requestedFiles.length > 0) {
      files = requestedFiles;
    } else {
      const status = await gitStatus(repoPath);
      files = status.files.map((f) => f.path);
    }
  } catch {
    files = requestedFiles ?? [];
  }

  const fallback = () => heuristicCommitMessage(files);
  if (files.length === 0) return fallback();

  // Monta o diff combinado (por arquivo), com cap pra não estourar o contexto.
  let combined = '';
  let truncated = false;
  for (const file of files) {
    if (combined.length >= SUGGEST_DIFF_CAP) {
      truncated = true;
      break;
    }
    let diff = '';
    try {
      diff = await gitDiff(repoPath, file, false);
    } catch {
      continue; // arquivo problemático — ignora, segue com os demais
    }
    if (!diff.trim()) continue;
    const header = `\n=== ${file} ===\n`;
    const remaining = SUGGEST_DIFF_CAP - combined.length;
    const chunk = header + diff;
    if (chunk.length > remaining) {
      combined += chunk.slice(0, remaining) + '\n… (diff truncado)\n';
      truncated = true;
      break;
    }
    combined += chunk;
  }
  if (truncated) combined += '\n… (diff truncado pra caber no contexto)\n';

  // Sem modelo empacotado → fallback direto (sem tentar carregar).
  if (!isForgeBundled() || !combined.trim()) return fallback();

  try {
    const fileList = files.slice(0, 30).join('\n');
    // System: regras. User: SÓ o diff. Antes era um prompt único via completion +
    // um exemplo "Corrige validação do login" — o modelo pequeno COPIAVA o exemplo
    // e inventava uma história de login sem relação com o diff. Agora: chat mode
    // (instruct se comporta muito melhor), SEM exemplo copiável, e proibição
    // explícita de inventar funcionalidades que não estão no diff.
    const system = [
      'Você gera mensagens de commit (conventional commit) em português do Brasil,',
      'descrevendo APENAS o que o DIFF do usuário muda.',
      'Responda SOMENTE com um objeto JSON estrito, sem markdown nem texto extra:',
      '{"summary": "...", "description": "..."}',
      '- "summary": assunto imperativo, ≤72 caracteres, sobre a MUDANÇA REAL do diff.',
      '- "description": corpo curto opcional (poucas linhas/bullets) ou string vazia "".',
      'REGRA CRÍTICA: baseie-se EXCLUSIVAMENTE nos arquivos e no diff fornecidos.',
      'NUNCA invente funcionalidades, telas ou termos (ex.: login, autenticação,',
      'pagamento) que NÃO aparecem no diff. Se o diff mexe em X, fale de X.',
    ].join('\n');
    const user = [`ARQUIVOS ALTERADOS:\n${fileList}`, '', `DIFF:\n${combined}`].join('\n');

    const raw = await llamaChat(getSmartExecConfig(), system, user);
    const parsed = extractFirstJsonObject(raw);
    const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
    if (!summary) return fallback();
    const description = typeof parsed?.description === 'string' ? parsed.description.trim() : '';
    return {
      // Garante o teto de 72 chars no assunto, mesmo se o modelo extrapolar.
      summary: summary.replace(/\s+/g, ' ').slice(0, 72),
      description,
    };
  } catch {
    return fallback();
  }
}

/** Base do PR: a pedida, senão a branch default do repo (GitHub), senão "main". */
async function resolveBaseBranch(repoFullName: string | null, requested?: string): Promise<string> {
  if (requested?.trim()) return requested.trim();
  if (repoFullName) {
    try {
      return await fetchRepoDefaultBranch(repoFullName);
    } catch {
      /* sem rede/token — cai no default */
    }
  }
  return 'main';
}

/** Diff da branch vs base, tentando o ref remoto e depois o local. */
async function prRangeDiff(repoPath: string, base: string): Promise<string> {
  for (const ref of [`origin/${base}`, base]) {
    const d = await gitRangeDiff(repoPath, ref);
    if (d.trim()) return d;
  }
  return '';
}

/** Título "humano" derivado do nome da branch (fallback sem IA). */
function branchToTitle(branch: string): string {
  return (
    branch
      .replace(/^[a-z]+\//i, '')
      .replace(/[-_/]+/g, ' ')
      .trim() || branch
  );
}

/**
 * Sugere título/corpo do PR a partir do DIFF da branch atual vs a base. Usa o
 * Forge local; em qualquer falha (sem modelo, diff vazio, parse), cai num título
 * derivado do nome da branch. Mesma proteção anti-alucinação do commit.
 */
async function suggestPrMessage(
  repoPath: string,
  repoFullName: string | null,
  requestedBase?: string,
): Promise<{ title: string; body: string; base: string }> {
  const base = await resolveBaseBranch(repoFullName, requestedBase);
  const branch = await gitCurrentBranch(repoPath);
  const fallback = { title: branchToTitle(branch), body: '', base };

  let diff = await prRangeDiff(repoPath, base);
  if (!isForgeBundled() || !diff.trim()) return fallback;
  if (diff.length > SUGGEST_DIFF_CAP) {
    diff = diff.slice(0, SUGGEST_DIFF_CAP) + '\n… (diff truncado pra caber no contexto)\n';
  }

  try {
    const system = [
      'Você gera o TÍTULO e o CORPO de um Pull Request em português do Brasil,',
      'descrevendo APENAS o que o DIFF (branch vs base) muda.',
      'Responda SOMENTE com JSON estrito, sem markdown nem texto extra:',
      '{"title": "...", "body": "..."}',
      '- "title": imperativo, conciso, ≤72 caracteres, sobre a MUDANÇA REAL.',
      '- "body": markdown curto — um "## Resumo" + bullets do que mudou. Sem checklist.',
      'REGRA CRÍTICA: baseie-se EXCLUSIVAMENTE no diff. NUNCA invente funcionalidades,',
      'telas ou termos (ex.: login, autenticação, pagamento) que NÃO estão no diff.',
    ].join('\n');
    const user = `BRANCH: ${branch}\nBASE: ${base}\n\nDIFF:\n${diff}`;
    const raw = await llamaChat(getSmartExecConfig(), system, user);
    const parsed = extractFirstJsonObject(raw);
    const title =
      typeof parsed?.title === 'string'
        ? parsed.title.replace(/\s+/g, ' ').trim().slice(0, 72)
        : '';
    const body = typeof parsed?.body === 'string' ? parsed.body.trim() : '';
    return { title: title || fallback.title, body, base };
  } catch {
    return fallback;
  }
}

function resolveSourcePath(sourceId: string): string {
  const source = sourceRepo.get(sourceId);
  if (!source) throw new Error(`Source ${sourceId} não existe`);
  if (!source.path) {
    throw new Error(
      `Source "${source.label}" não tem path local. Clone o repo antes de operar git.`,
    );
  }
  return source.path;
}

/**
 * Header de auth efêmero (Basic com o token GitHub) pro push/pull/fetch de repo
 * privado. O `.git/config` do clone tem URL limpa (sem token, por segurança), então
 * a credencial é resolvida na hora e passada só no comando. `undefined` quando o
 * source não é GitHub ou não há conta conectada (repo público / SSH / Azure) — aí o
 * git cai no credential helper do SO. Usa a conta GitHub conectada padrão (o source
 * ainda não persiste a conta por repo).
 */
function resolveSourceAuthHeader(sourceId: string): string | undefined {
  const source = sourceRepo.get(sourceId);
  if (!source || source.kind !== 'github_repo') return undefined;
  try {
    const token = getDecryptedToken();
    if (!token) return undefined;
    return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  } catch {
    return undefined; // sem conta conectada — git tenta o credential helper do SO
  }
}

export function registerGitHandlers(): void {
  registerHandler('git:is-repo', ({ sourceId }) => {
    const source = sourceRepo.get(sourceId);
    if (!source?.path) return { isRepo: false };
    return { isRepo: existsSync(path.join(source.path, '.git')) };
  });

  registerHandler('git:init', async ({ sourceId }) => {
    await gitInit(resolveSourcePath(sourceId));
    return { ok: true as const };
  });

  registerHandler('git:status', async ({ sourceId }) => {
    return gitStatus(resolveSourcePath(sourceId));
  });

  registerHandler('git:diff', async ({ sourceId, filePath, staged }) => {
    const diff = await gitDiff(resolveSourcePath(sourceId), filePath, !!staged);
    return { diff };
  });

  registerHandler('git:branches', async ({ sourceId }) => {
    return gitBranches(resolveSourcePath(sourceId));
  });

  registerHandler('git:checkout', async ({ sourceId, branch }) => {
    await gitCheckoutBranch(resolveSourcePath(sourceId), branch);
    return { ok: true as const };
  });

  registerHandler('git:create-branch', async ({ sourceId, name, fromBranch }) => {
    await gitCreateBranch(resolveSourcePath(sourceId), name, fromBranch);
    return { ok: true as const };
  });

  registerHandler('git:stage', async ({ sourceId, files }) => {
    await gitStage(resolveSourcePath(sourceId), files);
    return { ok: true as const };
  });

  registerHandler('git:unstage', async ({ sourceId, files }) => {
    await gitUnstage(resolveSourcePath(sourceId), files);
    return { ok: true as const };
  });

  registerHandler('git:commit', async ({ sourceId, message, files }) => {
    return gitCommit(resolveSourcePath(sourceId), message, files);
  });

  registerHandler('git:push', async ({ sourceId, branch }) => {
    await gitPush(resolveSourcePath(sourceId), branch, true, resolveSourceAuthHeader(sourceId));
    return { ok: true as const };
  });

  registerHandler('git:fetch', async ({ sourceId }) => {
    await gitFetch(resolveSourcePath(sourceId), resolveSourceAuthHeader(sourceId));
    return { ok: true as const };
  });

  registerHandler('git:open-pr', async ({ sourceId, title, body, base, head, draft }) => {
    const source = sourceRepo.get(sourceId);
    if (!source) throw new Error(`Source ${sourceId} não existe`);
    if (!source.repoFullName) {
      throw new Error(
        `Source "${source.label}" não tem repoFullName GitHub. Só sources GitHub podem abrir PR.`,
      );
    }
    return createPullRequest({
      ownerRepo: source.repoFullName,
      title,
      body,
      base,
      head,
      draft,
    });
  });

  registerHandler('git:suggest-pr', async ({ sourceId, base }) => {
    const source = sourceRepo.get(sourceId);
    if (!source?.path) throw new Error('Source sem path local pra inspecionar o diff.');
    return suggestPrMessage(source.path, source.repoFullName, base);
  });

  registerHandler('git:create-pr', async ({ sourceId, title, body, base, draft }) => {
    const source = sourceRepo.get(sourceId);
    if (!source) throw new Error(`Source ${sourceId} não existe`);
    if (!source.path) throw new Error('Source sem path local.');
    if (!source.repoFullName) {
      throw new Error(`Source "${source.label}" não é GitHub — só sources GitHub abrem PR.`);
    }
    const branch = await gitCurrentBranch(source.path);
    // Publica/atualiza a branch no remoto ANTES de abrir o PR (o GitHub precisa
    // da head no remoto). gitPush usa -u, então cobre o caso "SEM REMOTO".
    await gitPush(source.path, branch, true, resolveSourceAuthHeader(sourceId));
    const resolvedBase = await resolveBaseBranch(source.repoFullName, base);
    return createPullRequest({
      ownerRepo: source.repoFullName,
      title: title.trim(),
      body: body?.trim() || undefined,
      head: branch,
      base: resolvedBase,
      draft,
    });
  });

  registerHandler('git:log', async ({ sourceId, limit, branch }) => {
    return gitLog(resolveSourcePath(sourceId), { limit, branch });
  });

  registerHandler('git:discard', async ({ sourceId, files, issueId, snapshotId }) => {
    const source = sourceRepo.get(sourceId);
    const repoPath = resolveSourcePath(sourceId);
    if (snapshotId && source?.workspaceId) {
      if (wasIssueSnapshotAlreadyUndone(issueId, snapshotId)) return { ok: true as const };
      const { record, patch } = readIssueChangeSnapshot(source.workspaceId, snapshotId);
      if (record.sourceId !== sourceId || (issueId && record.issueId !== issueId)) {
        throw new Error('Snapshot de mudanças não pertence a esta execução.');
      }
      await gitApplyReversePatch(repoPath, patch);
    } else {
      await gitDiscard(repoPath, files);
    }
    if (source?.workspaceId && issueId) {
      invalidateExecutionLearningByIssue({
        workspaceId: source.workspaceId,
        issueId,
        reason: `Undo executado no source ${source.label}; mudanças descartadas pelo usuário.`,
      });
      markIssueUndone(
        issueId,
        `Undo executado no source ${source.label}; mudanças descartadas pelo usuário.`,
        snapshotId,
      );
    }
    return { ok: true as const };
  });

  registerHandler('git:show-commit', async ({ sourceId, sha }) => {
    return gitShowCommit(resolveSourcePath(sourceId), sha);
  });

  registerHandler('git:commit-file-diff', async ({ sourceId, sha, filePath }) => {
    const diff = await gitCommitFileDiff(resolveSourcePath(sourceId), sha, filePath);
    return { diff };
  });

  registerHandler('git:pull', async ({ sourceId, rebase, branch }) => {
    return gitPull(resolveSourcePath(sourceId), {
      rebase,
      branch,
      authHeader: resolveSourceAuthHeader(sourceId),
    });
  });

  registerHandler('git:suggest-commit', async ({ sourceId, files }) => {
    // suggestCommitMessage nunca lança — sempre devolve algo utilizável.
    return suggestCommitMessage(resolveSourcePath(sourceId), files);
  });

  registerHandler('shell:reveal', async ({ sourceId, relPath }) => {
    const root = resolveSourcePath(sourceId);
    const abs = path.resolve(path.join(root, relPath));
    // Guarda anti-traversal: confina o reveal à árvore do source.
    if (abs !== root && !abs.startsWith(root + path.sep)) return { ok: true as const };
    if (!shell)
      throw new Error('Revelar no gerenciador de arquivos disponível apenas no app desktop.');
    shell.showItemInFolder(abs);
    return { ok: true as const };
  });

  registerHandler('shell:open-path', async ({ sourceId, relPath }) => {
    const root = resolveSourcePath(sourceId);
    const ok = await openPathSafe(path.join(root, relPath), { withinRoot: root });
    return { ok };
  });

  registerHandler('git:ignore', async ({ sourceId, patterns }) => {
    const gitignorePath = path.join(resolveSourcePath(sourceId), '.gitignore');
    let current = '';
    try {
      current = await fs.readFile(gitignorePath, 'utf8');
    } catch {
      // .gitignore não existe ainda — começa vazio.
    }
    const existing = new Set(
      current
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const toAdd = patterns.filter((p) => p.trim() && !existing.has(p.trim()));
    if (toAdd.length === 0) return { ok: true as const };
    let next = current;
    if (next.length > 0 && !next.endsWith('\n')) next += '\n';
    next += toAdd.join('\n') + '\n';
    atomicWriteFileSync(gitignorePath, next, 'utf-8');
    return { ok: true as const };
  });
}
