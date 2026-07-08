/**
 * Repository Analyzer — varre o conteúdo de um source local e gera páginas
 * de knowledge base + entidades + relations.
 *
 * Estratégia:
 *   1. Walk recursivo do source.path com filtros (.gitignore via dependência
 *      mínima — implementamos uma whitelist + blacklist sem libs externas pra
 *      manter o footprint pequeno).
 *   2. Pra cada README*.md / docs/**.md → cria página com `kind='auto-generated'`.
 *   3. Pra cada arquivo de código (ts/tsx/js/py/rb/go/...) extrai:
 *        - imports → entidades 'tech' (libs externas) + relations 'uses'
 *        - exports / class / function top-level → entidades 'concept'
 *        - JSDoc top-of-file → conteúdo da página
 *   4. Cria página épica "Repo: <name>" como root. Subpáginas por área
 *      (src/, docs/, tests/, scripts/, etc.) com listagens.
 *
 * Broadcasta `kb:analyze-event` durante todo o processo. Cancelável por jobId.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { broadcast } from '../platform/host';
import type { KbAnalyzeEvent, KbEntityKind, WorkspaceSource } from '../../shared/types';
import { WorkspaceSourceRepository } from '../db/repositories/workspace-source.repo';
import { KbPageRepository } from '../db/repositories/kb-page.repo';
import { KbEntityRepository } from '../db/repositories/kb-entity.repo';
import { KbLinkRepository } from '../db/repositories/kb-link.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import { kbAnalysisJobRepo } from '../db/repositories/kb-analysis-job.repo';
import { isDatabaseOpen } from '../db/connection';
import { indexPage } from './kb-search';
import { indexSourceCode } from './kb-code-index';
import { rebuildChunksForWorkspace, writeBkfSnapshot } from './kb-binary-storage';
import { enqueueWorkspaceEmbeddings } from './kb-embedding-queue';
import { ensureMcpServerStarted } from './mcp-server';
import { scrubSpawnEnv } from './spawn-policy';
import { ensureDefaultInstructions } from './agent-instructions';
import { syncWorkspaceTeamForSources } from './source-team-sync';
import { execStatsRepo } from '../db/repositories/exec-stats.repo';
import { SettingsRepository } from '../db/repositories/settings.repo';
import { decideModelRoute } from './model-routing-policy';
import { getSmartExecConfig, isForgeBundled } from './smart-exec/config';
import { runLocalPhase } from './smart-exec/llama-runtime';
import { trace } from './log-bus';
import { activeLanguageName } from '../i18n';

const sourceRepo = new WorkspaceSourceRepository();
const pageRepo = new KbPageRepository();
const entityRepo = new KbEntityRepository();
const linkRepo = new KbLinkRepository();
const agentRepo = new AgentRepository();

const activeJobs = new Map<string, { cancel: () => void }>();

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.vscode',
  '.idea',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.DS_Store',
]);

const CODE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.php',
  '.scala',
]);

const DOC_EXTS = new Set(['.md', '.mdx', '.markdown']);

const MAX_FILE_BYTES = 256 * 1024; // 256KB cap pra arquivos individuais
const MAX_FILES = 800; // limite duro pra não travar UI

function emit(event: KbAnalyzeEvent): void {
  broadcast('kb:analyze-event', event);
}

function nowIso(): string {
  return new Date().toISOString();
}

interface WalkedFile {
  path: string;
  relative: string;
  ext: string;
  size: number;
  kind: 'doc' | 'code' | 'config' | 'other';
}

function classify(ext: string, name: string): WalkedFile['kind'] {
  if (DOC_EXTS.has(ext)) return 'doc';
  if (CODE_EXTS.has(ext)) return 'code';
  if (name === 'package.json' || name === 'tsconfig.json' || name === 'Dockerfile') return 'config';
  return 'other';
}

function walkRepo(root: string, abortSignal: { aborted: boolean }): WalkedFile[] {
  const out: WalkedFile[] = [];
  function visit(dir: string): void {
    if (abortSignal.aborted) return;
    if (out.length >= MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (abortSignal.aborted) return;
      if (out.length >= MAX_FILES) return;
      if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(full);
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) continue;
        const ext = extname(name).toLowerCase();
        const k = classify(ext, name);
        if (k === 'other') continue;
        out.push({
          path: full,
          relative: relative(root, full),
          ext,
          size: stat.size,
          kind: k,
        });
      }
    }
  }
  visit(root);
  return out;
}

/**
 * Extrai imports/exports/declarações TOP-level de um arquivo de código.
 * Heurística simples (regex) — robusta o suficiente pra TS/JS/Python/Go.
 */
function extractCodeSymbols(
  content: string,
  ext: string,
): {
  imports: string[];
  exports: string[];
} {
  const imports = new Set<string>();
  const exports = new Set<string>();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const importRe = /import\s+(?:[^'"]+from\s+)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(content)) !== null) imports.add(m[1]);
    const exportRe =
      /export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_][\w$]*)/g;
    while ((m = exportRe.exec(content)) !== null) exports.add(m[1]);
  } else if (ext === '.py') {
    const importRe = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
    let m;
    while ((m = importRe.exec(content)) !== null) imports.add(m[1] ?? m[2]);
    const exportRe = /^(?:class|def)\s+([A-Za-z_][\w]*)/gm;
    while ((m = exportRe.exec(content)) !== null) exports.add(m[1]);
  } else if (ext === '.go') {
    const importRe = /import\s+(?:\(([\s\S]*?)\)|"([^"]+)")/g;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      if (m[1]) {
        for (const line of m[1].split('\n')) {
          const q = line.match(/"([^"]+)"/);
          if (q) imports.add(q[1]);
        }
      } else if (m[2]) {
        imports.add(m[2]);
      }
    }
    const exportRe = /^(?:func|type)\s+([A-Z][\w]*)/gm;
    while ((m = exportRe.exec(content)) !== null) exports.add(m[1]);
  }
  return { imports: [...imports], exports: [...exports] };
}

/** Classifica package import como tech (ex: 'react' → tech). */
function isExternalImport(spec: string): boolean {
  // Relativos não são externos
  if (spec.startsWith('.') || spec.startsWith('/')) return false;
  return true;
}

interface AnalyzeContext {
  workspaceId: string;
  source: WorkspaceSource;
  jobId: string;
  rootPageId: string;
  aborted: { aborted: boolean };
  filesScanned: number;
  pagesCreated: number;
  entitiesCreated: number;
  relationsCreated: number;
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Dispara a análise em background; devolve jobId pra cancelar. */
export function analyzeSource(workspaceId: string, sourceId: string): { jobId: string } {
  const source = sourceRepo.get(sourceId);
  if (!source) throw new Error(`Source ${sourceId} não encontrado`);
  if (!source.path || !existsSync(source.path)) {
    throw new Error(
      `Source ${source.label} sem path local válido (${source.path ?? 'null'}). Faça clone antes.`,
    );
  }

  const jobId = randomUUID();
  const aborted = { aborted: false };

  // Cria a página raiz síncrono — pra UX responder rápido
  const repoName = source.label;
  const { page: rootPage } = pageRepo.findOrCreate({
    workspaceId,
    title: `Repo: ${repoName}`,
    kind: 'auto-generated',
    sourceId: source.id,
    contentMd: `# Repo: ${repoName}\n\nAnálise em andamento…`,
  });
  if (!rootPage.sourceId) {
    pageRepo.update(rootPage.id, { sourceId: source.id });
  }
  kbAnalysisJobRepo.create({
    id: jobId,
    workspaceId,
    sourceId: source.id,
    sourceLabel: source.label,
  });

  activeJobs.set(jobId, { cancel: () => (aborted.aborted = true) });

  // Limpa páginas antigas auto-generated deste source (exceto a root) — uma
  // re-análise apaga o lixo da análise anterior. ON DELETE CASCADE cuida das
  // subpáginas em cadeia.
  const allPages = pageRepo.listByWorkspace(workspaceId, false);
  const rootDescendants = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const page of allPages) {
      if (page.id === rootPage.id || rootDescendants.has(page.id)) continue;
      if (page.parentId === rootPage.id || (page.parentId && rootDescendants.has(page.parentId))) {
        rootDescendants.add(page.id);
        grew = true;
      }
    }
  }
  const stalePages = allPages.filter(
    (p) =>
      p.kind === 'auto-generated' &&
      p.id !== rootPage.id &&
      (p.sourceId === source.id || rootDescendants.has(p.id)),
  );
  for (const p of stalePages) {
    pageRepo.delete(p.id);
  }
  console.log(
    `[kb-analyzer] iniciando análise de ${repoName} (job=${jobId}) — limpou ${stalePages.length} páginas antigas`,
  );

  emit({ type: 'analyze-start', jobId, workspaceId, sourceId, sourceLabel: source.label });

  // Roda assíncrono em background pra não bloquear o IPC
  setImmediate(() => {
    void runAnalysis({
      workspaceId,
      source,
      jobId,
      rootPageId: rootPage.id,
      aborted,
      filesScanned: 0,
      pagesCreated: 1,
      entitiesCreated: 0,
      relationsCreated: 0,
    }).finally(() => activeJobs.delete(jobId));
  });

  return { jobId };
}

export function cancelAnalyze(jobId: string): boolean {
  const job = activeJobs.get(jobId);
  if (job) {
    job.cancel();
    activeJobs.delete(jobId);
  }
  // Atualiza o DB mesmo sem job em memória (ex.: job que ficou `running` após
  // crash e não foi recuperado pelo boot, ou cancelar de outra janela). Só
  // sobrescreve se ainda estiver ativo — não reabre um job já finalizado.
  const existing = kbAnalysisJobRepo.get(jobId);
  if (!existing) return !!job;
  if (existing.status === 'queued' || existing.status === 'running') {
    kbAnalysisJobRepo.update(jobId, {
      status: 'cancelled',
      phase: 'cancelled',
      message: 'Cancelado pelo usuário',
      error: 'Cancelado pelo usuário',
      completedAt: nowIso(),
    });
    return true;
  }
  return !!job;
}

async function runAnalysis(ctx: AnalyzeContext): Promise<void> {
  const { workspaceId, source, jobId, rootPageId, aborted } = ctx;
  try {
    kbAnalysisJobRepo.update(jobId, {
      status: 'running',
      phase: 'walk',
      message: 'Mapeando arquivos do source…',
      startedAt: nowIso(),
      error: null,
    });
    emit({
      type: 'analyze-phase',
      jobId,
      phase: 'walk',
      message: 'Mapeando arquivos do source…',
      workspaceId,
      sourceId: source.id,
      sourceLabel: source.label,
    });

    const files = walkRepo(source.path!, aborted);
    ctx.filesScanned = files.length;
    kbAnalysisJobRepo.update(jobId, {
      filesScanned: ctx.filesScanned,
      pagesCreated: ctx.pagesCreated,
      entitiesCreated: ctx.entitiesCreated,
      relationsCreated: ctx.relationsCreated,
    });
    if (aborted.aborted) {
      kbAnalysisJobRepo.update(jobId, {
        status: 'cancelled',
        phase: 'cancelled',
        message: 'Cancelado pelo usuário',
        error: 'Cancelado pelo usuário',
        completedAt: nowIso(),
      });
      emit({
        type: 'analyze-error',
        jobId,
        error: 'Cancelado pelo usuário',
        workspaceId,
        sourceId: source.id,
        sourceLabel: source.label,
      });
      return;
    }
    emit({
      type: 'analyze-progress',
      jobId,
      current: files.length,
      total: files.length,
      file: 'walk',
      workspaceId,
      sourceId: source.id,
      sourceLabel: source.label,
    });

    // Extrai dependências do package.json (entidades técnicas)
    extractPackageJsonDeps(workspaceId, source.path!, ctx);

    // Pequeno set de entidades a partir de imports — só pra alimentar o grafo
    // antes da análise IA. A IA vai gerar o conteúdo de verdade.
    const codeFiles = files.filter((f) => f.kind === 'code').slice(0, 60);
    for (const file of codeFiles) {
      if (aborted.aborted) break;
      const content = safeRead(file.path);
      if (!content) continue;
      const { imports } = extractCodeSymbols(content, file.ext);
      for (const imp of imports.slice(0, 10)) {
        if (!isExternalImport(imp)) continue;
        const libName = imp.split('/')[0].replace(/^@/, '@');
        const ent = entityRepo.findOrCreate({
          workspaceId,
          kind: 'tech' as KbEntityKind,
          name: libName,
          description: `Usado em \`${source.label}\``,
        });
        if (ent.mentionCount === 1) ctx.entitiesCreated++;
      }
    }

    // Atualiza página raiz com sumário base (será enriquecida pela IA).
    // kb_summary LOCAL: quando o conteúdo já foi mapeado em memória (sem precisar
    // explorar o filesystem via tools), gera o overview no Forge local. Em qualquer
    // falha cai no sumário determinístico — a análise FULL via MCP segue premium.
    const baseSummary =
      (await buildBaseSummaryMaybeLocal(source, files)) ?? buildBaseSummary(source, files);
    // A inferência local acima é longa (~min). Se o app encerrou/reiniciou nesse meio
    // (DB fechado), aborta quieto — escrever agora estouraria "Database não inicializado".
    if (!isDatabaseOpen()) return;
    pageRepo.update(rootPageId, { contentMd: baseSummary });
    indexPage(workspaceId, rootPageId, `Repo: ${source.label}`, baseSummary);
    const coveragePageIds = createDeterministicCoveragePages(ctx, files);
    const coveragePages = coveragePageIds.length;
    kbAnalysisJobRepo.update(jobId, {
      phase: 'coverage-pages',
      message: 'Páginas determinísticas de cobertura criadas',
      filesScanned: ctx.filesScanned,
      pagesCreated: ctx.pagesCreated,
      entitiesCreated: ctx.entitiesCreated,
      relationsCreated: ctx.relationsCreated,
      coveragePages,
    });
    emit({
      type: 'analyze-progress',
      jobId,
      current: coveragePages,
      total: 9,
      file: 'coverage-pages',
      workspaceId,
      sourceId: source.id,
      sourceLabel: source.label,
    });

    // -------- ANÁLISE PROFUNDA COM IA --------
    let aiAnalysisWarning: string | null = null;
    if (!aborted.aborted) {
      kbAnalysisJobRepo.update(jobId, {
        phase: 'ai-analysis',
        message: 'CEO analisando o repositório com IA…',
        pagesCreated: ctx.pagesCreated,
        entitiesCreated: ctx.entitiesCreated,
        relationsCreated: ctx.relationsCreated,
      });
      emit({
        type: 'analyze-phase',
        jobId,
        phase: 'ai-analysis',
        message: 'CEO analisando o repositório com IA…',
        workspaceId,
        sourceId: source.id,
        sourceLabel: source.label,
      });
      try {
        await runAiAnalysis({
          workspaceId,
          source,
          rootPageId,
          files,
          jobId,
          aborted,
          ctx,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        aiAnalysisWarning = msg;
        console.error('[kb-analyzer] análise IA falhou:', err);
        kbAnalysisJobRepo.update(jobId, {
          phase: 'ai-analysis',
          message: 'Análise IA falhou; mantendo cobertura determinística e enfileirando embeddings',
          error: msg,
          filesScanned: ctx.filesScanned,
          pagesCreated: ctx.pagesCreated,
          entitiesCreated: ctx.entitiesCreated,
          relationsCreated: ctx.relationsCreated,
          coveragePages,
        });
        trace({
          level: 'warn',
          source: 'system',
          scope: 'analysis',
          workspaceId,
          message: `análise IA indisponível; fallback determinístico ativo · ${source.label}: ${msg}`,
        });
        emit({
          type: 'analyze-phase',
          jobId,
          phase: 'ai-analysis-fallback',
          message: 'Análise IA falhou; base determinística seguirá para embeddings',
          workspaceId,
          sourceId: source.id,
          sourceLabel: source.label,
        });
      }
    }

    // Consolidação: se a IA teve sucesso E gerou uma árvore rica (>=4 páginas
    // próprias além das determinísticas), arquiva as páginas determinísticas
    // rasas ("Resumo determinístico…") pra a KB mostrar só a análise da IA.
    // ARQUIVAR, não deletar (reversível); gated em sucesso, então o fallback
    // determinístico sempre permanece visível quando a IA falha.
    if (!aiAnalysisWarning && !aborted.aborted && coveragePageIds.length > 0) {
      const coverageSet = new Set(coveragePageIds);
      const aiOwnPages = pageRepo
        .listByWorkspace(workspaceId, false)
        .filter((p) => p.parentId === rootPageId && p.id !== rootPageId && !coverageSet.has(p.id));
      if (aiOwnPages.length >= 4) {
        for (const id of coveragePageIds) {
          pageRepo.update(id, { isArchived: true });
        }
        console.log(
          `[kb-analyzer] ${coveragePageIds.length} página(s) determinística(s) arquivada(s) — IA cobriu com ${aiOwnPages.length} páginas próprias`,
        );
      }
    }

    if (aborted.aborted) {
      kbAnalysisJobRepo.update(jobId, {
        status: 'cancelled',
        phase: 'cancelled',
        message: 'Cancelado pelo usuário',
        error: 'Cancelado pelo usuário',
        filesScanned: ctx.filesScanned,
        pagesCreated: ctx.pagesCreated,
        entitiesCreated: ctx.entitiesCreated,
        relationsCreated: ctx.relationsCreated,
        coveragePages,
        completedAt: nowIso(),
      });
      return;
    }

    void linkRepo; // placeholder

    kbAnalysisJobRepo.update(jobId, {
      phase: 'snapshot',
      message: 'Gerando snapshots binários',
      filesScanned: ctx.filesScanned,
      pagesCreated: ctx.pagesCreated,
      entitiesCreated: ctx.entitiesCreated,
      relationsCreated: ctx.relationsCreated,
      coveragePages,
    });
    emit({
      type: 'analyze-phase',
      jobId,
      phase: 'snapshot',
      message: 'Gerando snapshots binários',
      workspaceId,
      sourceId: source.id,
      sourceLabel: source.label,
    });
    // Indexa o CÓDIGO-FONTE real (incremental, bounded) pro retrieval devolver
    // trechos do código com provenance file:line — não só páginas de KB. Não-fatal:
    // qualquer falha aqui não derruba a análise (a KB já está montada).
    try {
      const codeIndex = indexSourceCode({
        workspaceId,
        sourceId: source.id,
        rootPath: source.path!,
        sourceLabel: source.label,
        aborted,
      });
      console.log(
        `[kb-analyze] código indexado: ${codeIndex.filesIndexed} arquivo(s) novos/alterados · ${codeIndex.chunksIndexed} chunks · ${codeIndex.filesSkipped} inalterados`,
      );
    } catch (err) {
      console.warn('[kb-analyze] indexação de código-fonte falhou (não-fatal):', err);
    }

    rebuildChunksForWorkspace(workspaceId);
    // Persist BKF agregado em disco — agentes podem consumir o arquivo binário
    // ordenado depois pra processar toda a base sem N round-trips.
    const bkf = writeBkfSnapshot(workspaceId);
    const embeddingJob = enqueueWorkspaceEmbeddings({
      workspaceId,
      sourceId: source.id,
      sourceLabel: source.label,
      reason: 'workspace-rebuild',
    });
    console.log(
      `[kb-analyze] BKF snapshot escrito: ${bkf.path} (${bkf.sizeBytes}B · ${bkf.chunkCount} chunks) · embeddings job=${embeddingJob.id}`,
    );
    kbAnalysisJobRepo.update(jobId, {
      status: 'completed',
      phase: aiAnalysisWarning ? 'completed-with-ai-warning' : 'completed',
      message: aiAnalysisWarning
        ? 'Base determinística criada, análise IA falhou e embeddings foram enfileirados'
        : 'Base de conhecimento criada e embeddings enfileirados',
      filesScanned: ctx.filesScanned,
      pagesCreated: ctx.pagesCreated,
      entitiesCreated: ctx.entitiesCreated,
      relationsCreated: ctx.relationsCreated,
      coveragePages,
      embeddingJobId: embeddingJob.id,
      error: aiAnalysisWarning,
      completedAt: nowIso(),
    });
    try {
      syncWorkspaceTeamForSources(workspaceId, 'kb-analysis-completed');
    } catch (err) {
      console.warn('[kb-analyze] sync do time apos analise falhou:', err);
    }

    emit({
      type: 'analyze-done',
      jobId,
      workspaceId,
      sourceId: source.id,
      sourceLabel: source.label,
      pagesCreated: ctx.pagesCreated,
      entitiesCreated: ctx.entitiesCreated,
      relationsCreated: ctx.relationsCreated,
      filesScanned: ctx.filesScanned,
      coveragePages,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // App encerrando/reiniciando (DB fechado) no meio da análise: aborta quieto em vez
    // de virar "unhandled rejection" tentando gravar o erro num DB já fechado.
    if (!isDatabaseOpen()) {
      console.warn('[kb-analyzer] análise interrompida (app encerrando — DB fechado)');
      return;
    }
    console.error('[kb-analyzer] falhou:', err);
    kbAnalysisJobRepo.update(jobId, {
      status: aborted.aborted ? 'cancelled' : 'failed',
      phase: aborted.aborted ? 'cancelled' : 'error',
      message: aborted.aborted ? 'Cancelado pelo usuário' : 'Análise do source falhou',
      error: msg,
      filesScanned: ctx.filesScanned,
      pagesCreated: ctx.pagesCreated,
      entitiesCreated: ctx.entitiesCreated,
      relationsCreated: ctx.relationsCreated,
      completedAt: nowIso(),
    });
    emit({
      type: 'analyze-error',
      jobId,
      error: msg,
      workspaceId,
      sourceId: source.id,
      sourceLabel: source.label,
    });
  }
}

function extractPackageJsonDeps(workspaceId: string, rootPath: string, ctx: AnalyzeContext): void {
  const pkgPath = join(rootPath, 'package.json');
  if (!existsSync(pkgPath)) return;
  const pkg = safeRead(pkgPath);
  if (!pkg) return;
  try {
    const data = JSON.parse(pkg) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const dep of Object.keys(data.dependencies ?? {})) {
      const ent = entityRepo.findOrCreate({
        workspaceId,
        kind: 'tech' as KbEntityKind,
        name: dep,
        description: 'Runtime dependency',
      });
      if (ent.mentionCount === 1) ctx.entitiesCreated++;
    }
    for (const dep of Object.keys(data.devDependencies ?? {})) {
      entityRepo.findOrCreate({
        workspaceId,
        kind: 'tech' as KbEntityKind,
        name: dep,
        description: 'Dev dependency',
      });
    }
  } catch {
    /* ignore */
  }
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k) ?? [];
    arr.push(it);
    m.set(k, arr);
  }
  return m;
}

/**
 * kb_summary LOCAL: gera o overview da página-raiz a partir do inventário JÁ
 * mapeado em memória (linguagens, top dirs, docs) — sumarização PURA, sem
 * tool-calling. Roda no Forge só quando o roteamento permite; retorna null em
 * qualquer falha (modelo ausente, output vazio) → o caller usa o sumário
 * determinístico. NÃO substitui a análise FULL via MCP (essa segue premium).
 */
async function buildBaseSummaryMaybeLocal(
  source: WorkspaceSource,
  files: WalkedFile[],
): Promise<string | null> {
  const decision = decideModelRoute({
    settings: new SettingsRepository().get().aiRouting,
    phase: 'kb_summary',
    risk: 'low',
    localModelReady: isForgeBundled(),
    activeCliProvider: null,
  });
  if (decision.executor !== 'local') return null;

  const byExt = groupBy(files, (f) => f.ext);
  const langs = [...byExt.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([ext, list]) => `${ext || 'no-ext'} (${list.length})`)
    .join(', ');
  const dirs = topDirectories(files).slice(0, 16).join(', ');
  const docs = files
    .filter((f) => f.kind === 'doc')
    .slice(0, 12)
    .map((f) => f.relative)
    .join(', ');

  const result = await runLocalPhase<string>(getSmartExecConfig(), {
    scope: 'kb_summary',
    system: `You write a concise repository overview in Markdown, in ${activeLanguageName()}. 2-4 short paragraphs, no headings beyond the title, no invented facts — only what the inventory supports.`,
    user: [
      `Repository: ${source.label}`,
      source.repoFullName ? `GitHub: ${source.repoFullName}` : '',
      `Files mapped: ${files.length}`,
      `Languages by extension: ${langs}`,
      `Top directories: ${dirs}`,
      docs ? `Docs: ${docs}` : '',
      '',
      'Write the overview.',
    ]
      .filter(Boolean)
      .join('\n'),
    parse: (raw) => (raw.trim().length >= 40 ? raw.trim() : null),
  });

  if (!result) return null;
  execStatsRepo.recordLocalPhase({
    phase: 'kb_summary',
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  });
  trace({
    level: 'success',
    source: 'forge',
    scope: 'kb_summary',
    message: `overview de "${source.label}" gerado local (premium evitado ≈ ${result.tokensIn + result.tokensOut} tokens)`,
  });
  return `# Repo: ${source.label}\n\n${result.value}`;
}

function buildBaseSummary(source: WorkspaceSource, files: WalkedFile[]): string {
  const byExt = groupBy(files, (f) => f.ext);
  const langs = [...byExt.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .map(([ext, list]) => `\`${ext}\` (${list.length})`)
    .join(' · ');
  return [
    `# Repo: ${source.label}`,
    '',
    source.repoFullName ? `**GitHub**: \`${source.repoFullName}\`` : '',
    source.path ? `**Path local**: \`${source.path}\`` : '',
    '',
    `Análise em andamento. ${files.length} arquivos mapeados.`,
    langs ? `**Linguagens detectadas**: ${langs}` : '',
    '',
    'O agente CEO está gerando páginas estruturadas com:',
    '',
    '- Arquitetura e fluxos principais',
    '- Stack técnica e padrões',
    '- Dependências (tree com ligações)',
    '- Pontos ofensores e riscos',
    '- Convenções do projeto',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

function upsertCoveragePage(
  ctx: AnalyzeContext,
  title: string,
  contentMd: string,
  sortOrder: number,
): string {
  const slugTitle = title.toLowerCase().trim();
  const existing = pageRepo
    .listByWorkspace(ctx.workspaceId, true)
    .find(
      (page) =>
        page.parentId === ctx.rootPageId &&
        page.sourceId === ctx.source.id &&
        page.title.toLowerCase().trim() === slugTitle,
    );
  if (existing) {
    pageRepo.update(existing.id, {
      contentMd,
      sourceId: ctx.source.id,
      sortOrder,
      isArchived: false, // re-análise reativa a página caso estivesse arquivada
    });
    indexPage(ctx.workspaceId, existing.id, title, contentMd);
    return existing.id;
  }
  const page = pageRepo.create({
    workspaceId: ctx.workspaceId,
    parentId: ctx.rootPageId,
    title,
    kind: 'auto-generated',
    contentMd,
    sourceId: ctx.source.id,
    sortOrder,
  });
  ctx.pagesCreated++;
  indexPage(ctx.workspaceId, page.id, title, contentMd);
  return page.id;
}

function topList(items: string[], limit = 24): string {
  const unique = [...new Set(items.filter(Boolean))].slice(0, limit);
  return unique.length > 0
    ? unique.map((item) => `- \`${item}\``).join('\n')
    : '- Nenhum item detectado.';
}

function topDirectories(files: WalkedFile[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = file.relative.split(/[\\/]/)[0] || '.';
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([dir, count]) => `${dir} (${count} arquivos)`);
}

function dependencySummary(rootPath: string): string[] {
  const out: string[] = [];
  const pkgPath = join(rootPath, 'package.json');
  if (existsSync(pkgPath)) {
    const raw = safeRead(pkgPath);
    if (raw) {
      try {
        const pkg = JSON.parse(raw) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          scripts?: Record<string, string>;
        };
        for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
          out.push(`${name}@${version}`);
        }
        for (const [name, version] of Object.entries(pkg.devDependencies ?? {}).slice(0, 30)) {
          out.push(`${name}@${version} (dev)`);
        }
        for (const [name, script] of Object.entries(pkg.scripts ?? {}).slice(0, 18)) {
          out.push(`script:${name} -> ${script}`);
        }
      } catch {
        out.push('package.json presente, mas não foi possível parsear.');
      }
    }
  }
  for (const name of [
    'composer.json',
    'go.mod',
    'Cargo.toml',
    'pyproject.toml',
    'requirements.txt',
  ]) {
    if (existsSync(join(rootPath, name))) out.push(`${name} presente`);
  }
  return out;
}

function importantFiles(files: WalkedFile[]): string[] {
  const patterns = [
    /(^|\/)(main|index|server|app|bootstrap|Program)\.(tsx?|jsx?|py|go|java|cs|php)$/i,
    /(^|\/)(routes?|controllers?|handlers?|schema|models?|entities|services?)\//i,
    /(^|\/)(Dockerfile|docker-compose\.ya?ml|\.env\.example|README\.md)$/i,
  ];
  return files
    .filter((file) => patterns.some((pattern) => pattern.test(file.relative)))
    .map((file) => file.relative)
    .slice(0, 40);
}

function testFiles(files: WalkedFile[]): string[] {
  return files
    .filter((file) => /(^|\/)(__tests__|tests?|specs?)\/|(\.|-)(test|spec)\./i.test(file.relative))
    .map((file) => file.relative)
    .slice(0, 40);
}

function contractFiles(files: WalkedFile[]): string[] {
  return files
    .filter((file) =>
      /(^|\/)(api|routes?|controllers?|schemas?|dto|contracts?|openapi|swagger|graphql|proto)\b/i.test(
        file.relative,
      ),
    )
    .map((file) => file.relative)
    .slice(0, 40);
}

function languageSummary(files: WalkedFile[]): string {
  const byKind = groupBy(files, (file) => file.kind);
  const byExt = groupBy(files, (file) => file.ext || '(sem ext)');
  const kinds = [...byKind.entries()].map(([kind, list]) => `- ${kind}: ${list.length}`).join('\n');
  const exts = [...byExt.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 16)
    .map(([ext, list]) => `- \`${ext}\`: ${list.length}`)
    .join('\n');
  return [`## Por tipo`, kinds || '- Nenhum tipo detectado.', '', '## Por extensão', exts].join(
    '\n',
  );
}

function createDeterministicCoveragePages(ctx: AnalyzeContext, files: WalkedFile[]): string[] {
  const root = ctx.source.path!;
  const dirs = topDirectories(files);
  const deps = dependencySummary(root);
  const entrypoints = importantFiles(files);
  const tests = testFiles(files);
  const contracts = contractFiles(files);
  const largeFiles = files
    .sort((a, b) => b.size - a.size)
    .slice(0, 20)
    .map((file) => `${file.relative} (${Math.round(file.size / 1024)} KB)`);

  const pages = [
    {
      title: `Mapa estrutural — ${ctx.source.label}`,
      body: [
        `# Mapa estrutural — ${ctx.source.label}`,
        '',
        `Source analisado: \`${ctx.source.path ?? ctx.source.repoFullName ?? ctx.source.label}\`.`,
        `Arquivos mapeados: **${files.length}**.`,
        '',
        '## Diretórios principais',
        topList(dirs),
        '',
        '## Linguagens e tipos',
        languageSummary(files),
      ].join('\n'),
    },
    {
      title: `Dependências e scripts — ${ctx.source.label}`,
      body: [
        `# Dependências e scripts — ${ctx.source.label}`,
        '',
        'Resumo determinístico extraído de manifests do projeto. A análise IA pode enriquecer esta página depois.',
        '',
        topList(deps, 80),
      ].join('\n'),
    },
    {
      title: `Entrypoints e arquivos importantes — ${ctx.source.label}`,
      body: [
        `# Entrypoints e arquivos importantes — ${ctx.source.label}`,
        '',
        'Arquivos que parecem iniciar runtime, rotas, serviços, schemas ou configuração crítica.',
        '',
        topList(entrypoints, 60),
      ].join('\n'),
    },
    {
      title: `Inventário de código — ${ctx.source.label}`,
      body: [
        `# Inventário de código — ${ctx.source.label}`,
        '',
        'Amostra dos arquivos de código detectados para orientar busca e navegação dos agentes.',
        '',
        topList(
          files.filter((file) => file.kind === 'code').map((file) => file.relative),
          80,
        ),
      ].join('\n'),
    },
    {
      title: `Contratos e integrações — ${ctx.source.label}`,
      body: [
        `# Contratos e integrações — ${ctx.source.label}`,
        '',
        'Arquivos candidatos a APIs, rotas, DTOs, schemas e contratos entre sources.',
        '',
        topList(contracts, 60),
      ].join('\n'),
    },
    {
      title: `Testes e qualidade — ${ctx.source.label}`,
      body: [
        `# Testes e qualidade — ${ctx.source.label}`,
        '',
        tests.length > 0
          ? 'Arquivos de teste detectados:'
          : 'Nenhum arquivo de teste óbvio foi detectado pela varredura determinística.',
        '',
        topList(tests, 60),
      ].join('\n'),
    },
    {
      title: `Riscos de leitura — ${ctx.source.label}`,
      body: [
        `# Riscos de leitura — ${ctx.source.label}`,
        '',
        'Sinais objetivos para o agente considerar antes de executar mudanças neste source.',
        '',
        `- Total mapeado: ${files.length} arquivos.`,
        `- Limite de varredura: ${MAX_FILES} arquivos.`,
        files.length >= MAX_FILES
          ? '- A varredura atingiu o limite máximo; pode haver arquivos não analisados.'
          : '- A varredura não atingiu o limite máximo.',
        '',
        '## Maiores arquivos incluídos',
        topList(largeFiles, 40),
      ].join('\n'),
    },
  ];

  return pages.map((page, index) => upsertCoveragePage(ctx, page.title, page.body, index + 10));
}

// ============================================================================
// AI Analysis — spawnar agente CEO pra fazer análise profunda do repo
// ============================================================================

/**
 * Spawn um agente Claude (orquestrador) que lê o repositório clonado e gera
 * páginas estruturadas na KB via MCP tools. O agente trabalha com cwd no
 * source.path e tem todas as kb_* tools disponíveis pra escrever páginas
 * filhas da rootPageId.
 */
async function runAiAnalysis(opts: {
  workspaceId: string;
  source: WorkspaceSource;
  rootPageId: string;
  files: WalkedFile[];
  jobId: string;
  aborted: { aborted: boolean };
  ctx: AnalyzeContext;
}): Promise<void> {
  const { workspaceId, source, rootPageId, files, jobId, aborted, ctx } = opts;

  // 1. Encontra agente orquestrador com Claude. Sem ele, ERRO claro.
  const agents = agentRepo.listByWorkspace(workspaceId);
  console.log(
    `[kb-analyzer] agentes do workspace: ${agents.map((a) => `${a.name}(${a.adapterType ?? '?'}${a.isOrchestrator ? '/orch' : ''})`).join(', ')}`,
  );
  // Qualquer adapter executável serve (claude/codex); preferimos o orquestrador.
  const runnable = agents.filter(
    (a) => a.adapterType === 'claude_local' || a.adapterType === 'codex_local',
  );
  const orchestrator = runnable.find((a) => a.isOrchestrator) ?? runnable[0];
  if (!orchestrator) {
    const msg =
      'Sem agente executável no workspace — adicione um agente Claude ou Codex pra ativar a análise IA.';
    console.error('[kb-analyzer] ' + msg);
    throw new Error(msg);
  }
  console.log(
    `[kb-analyzer] usando agente "${orchestrator.name}" (model=${orchestrator.model ?? 'default'})`,
  );
  ensureDefaultInstructions(orchestrator);

  // 2. Sobe MCP server e cria mcp-config dedicado pra essa análise
  const { port, token } = await ensureMcpServerStarted();
  const mcpDir = join(tmpdir(), 'orkestral-mcp', `analyze-${jobId}`);
  mkdirSync(mcpDir, { recursive: true });
  const mcpPath = join(mcpDir, 'mcp-config.json');
  writeFileSync(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        orkestral: {
          type: 'http',
          url: `http://127.0.0.1:${port}`,
          headers: {
            'x-orkestral-token': token,
            'x-orkestral-workspace': workspaceId,
            // Identifica o orquestrador → o MCP manda x-orkestral-agent-id, sem o
            // qual a tool MUTANTE `kb_create_page` (a análise grava páginas na KB)
            // é recusada pelo gate cross-workspace.
            'x-orkestral-agent-id': orchestrator.id,
          },
        },
      },
    }),
  );

  // 3. Monta context bundle e prompt detalhado
  const otherSources = sourceRepo.listByWorkspace(workspaceId).filter((s) => s.id !== source.id);
  const context = buildAnalysisContext(source, files, otherSources);
  const prompt = buildAnalysisPrompt({
    source,
    rootPageId,
    otherSources,
    context,
    fileCount: files.length,
  });

  // 4. Spawn do CLI do agente (claude ou codex). MCP do Orkestral via
  // --mcp-config (claude) ou overrides -c mcp_servers.* (codex).
  const isCodex = orchestrator.adapterType === 'codex_local';
  const cliLabel = isCodex ? 'Codex' : 'Claude';
  let command: string;
  let args: string[];
  if (isCodex) {
    args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--yolo',
      '-c',
      `mcp_servers.orkestral.url="http://127.0.0.1:${port}"`,
      '-c',
      `mcp_servers.orkestral.http_headers.x-orkestral-token="${token}"`,
      '-c',
      `mcp_servers.orkestral.http_headers.x-orkestral-workspace="${workspaceId}"`,
      '-c',
      // Identifica o orquestrador (mesmo motivo do path Claude): sem agent-id a
      // tool MUTANTE `kb_create_page` da análise é recusada pelo gate.
      `mcp_servers.orkestral.http_headers.x-orkestral-agent-id="${orchestrator.id}"`,
    ];
    if (orchestrator.model && orchestrator.model !== 'default') {
      args.push('--model', orchestrator.model);
    }
    args.push('-');
    command = 'codex';
  } else {
    args = [
      '--print',
      '-',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--mcp-config',
      mcpPath,
    ];
    if (orchestrator.model && orchestrator.model !== 'default') {
      args.push('--model', orchestrator.model);
    }
    command = 'claude';
  }

  console.log(`[kb-analyzer] spawning ${command} — args=${args.join(' ')} cwd=${source.path}`);
  console.log(`[kb-analyzer] prompt size: ${prompt.length} chars`);
  let child;
  try {
    child = spawn(command, args, {
      env: scrubSpawnEnv(),
      shell: false,
      cwd: source.path!,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[kb-analyzer] spawn failed:', msg);
    throw new Error(
      `Falha ao executar ${cliLabel} CLI: ${msg}. Verifique se "${command}" está no PATH.`,
    );
  }
  if (!child.stdin) {
    throw new Error(`${cliLabel} CLI sem stdin disponível`);
  }
  child.stdin.write(prompt);
  child.stdin.end();

  // Cancela ao abortar
  const abortTimer = setInterval(() => {
    if (aborted.aborted && !child.killed) {
      child.kill('SIGTERM');
    }
  }, 1000);

  // 5. Streamingmonitor — extrai tool_use events pra mostrar progresso
  let toolCallCount = 0;
  let stdoutBuffer = '';
  let codexFailed: string | null = null;
  // Usage do evento `result` (claude stream-json) — persistido no job ao final.
  // Sem isto o custo da análise era INVISÍVEL (nenhuma tabela registrava) e o
  // custo real do produto saía subcontado, inclusive no benchmark/.
  let llmUsage: {
    tokensIn: number | null;
    tokensOut: number | null;
    costUsd: number | null;
  } | null = null;
  child.stdout?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const evt = JSON.parse(line) as Record<string, unknown>;
        if (isCodex) {
          const t = String(evt.type ?? '');
          if (t === 'item.completed') {
            const item = evt.item as Record<string, unknown> | undefined;
            const itype = String(item?.type ?? '');
            if (itype && itype !== 'agent_message' && itype !== 'reasoning') {
              toolCallCount++;
              const toolName =
                (item?.tool_name as string | undefined) ??
                (item?.server as string | undefined) ??
                itype;
              emit({
                type: 'analyze-progress',
                jobId,
                current: toolCallCount,
                total: 0,
                file: toolName,
                workspaceId,
                sourceId: source.id,
                sourceLabel: source.label,
              });
              if (toolName === 'kb_create_page') ctx.pagesCreated++;
            }
          } else if (t === 'error' || t === 'turn.failed') {
            codexFailed =
              typeof evt.message === 'string'
                ? evt.message
                : (((evt.error as Record<string, unknown> | undefined)?.message as
                    | string
                    | undefined) ?? 'turn failed');
          }
          continue;
        }
        if (evt.type === 'result') {
          // Mesma convenção do chat/executor: input/output do `usage` (excluem
          // cache); total_cost_usd já inclui tudo.
          const usage = evt.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          llmUsage = {
            tokensIn: usage ? Number(usage.input_tokens ?? 0) || null : null,
            tokensOut: usage ? Number(usage.output_tokens ?? 0) || null : null,
            costUsd: typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : null,
          };
          continue;
        }
        if (evt.type === 'stream_event') {
          const event = evt.event as Record<string, unknown> | undefined;
          if (
            event?.type === 'content_block_start' &&
            (event.content_block as { type?: string } | undefined)?.type === 'tool_use'
          ) {
            toolCallCount++;
            const toolName = (event.content_block as { name?: string } | undefined)?.name ?? 'tool';
            emit({
              type: 'analyze-progress',
              jobId,
              current: toolCallCount,
              total: 0,
              file: toolName,
              workspaceId,
              sourceId: source.id,
              sourceLabel: source.label,
            });
            if (toolName === 'kb_create_page') {
              ctx.pagesCreated++;
            }
          }
        }
      } catch {
        /* linha inválida — ignora */
      }
    }
  });

  let stderrBuf = '';
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => {
    stderrBuf += chunk;
  });

  // 6. Aguarda fim
  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(-1));
  });
  clearInterval(abortTimer);

  // Persiste o custo ANTES do gate de erro: se o run emitiu `result` e depois
  // falhou, o gasto aconteceu do mesmo jeito e precisa aparecer na conta.
  if (llmUsage) {
    kbAnalysisJobRepo.update(jobId, llmUsage);
  }

  if ((exitCode !== 0 || codexFailed) && !aborted.aborted) {
    const cleanErr = (codexFailed ?? stderrBuf)
      .replace(/Warning: no stdin data received[^\n]*\n?/g, '')
      .trim();
    throw new Error(cleanErr.slice(0, 200) || `${cliLabel} saiu com código ${exitCode}`);
  }
}

/**
 * Monta um "context bundle" curto pra IA: README, package.json, file tree
 * truncada, samples de arquivos importantes.
 */
function buildAnalysisContext(
  source: WorkspaceSource,
  files: WalkedFile[],
  otherSources: WorkspaceSource[],
): string {
  const root = source.path!;
  const parts: string[] = [];

  // README
  const readmeFile = files.find((f) => /^README(\.[a-z]+)?$/i.test(basename(f.path)));
  if (readmeFile) {
    const md = safeRead(readmeFile.path);
    if (md) {
      parts.push('## README\n\n```markdown\n' + md.slice(0, 4000) + '\n```');
    }
  }

  // package.json (resumido)
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    const raw = safeRead(pkgPath);
    if (raw) {
      try {
        const pkg = JSON.parse(raw) as {
          name?: string;
          description?: string;
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const summary = {
          name: pkg.name,
          description: pkg.description,
          scripts: pkg.scripts,
          dependencies: Object.keys(pkg.dependencies ?? {}),
          devDependencies: Object.keys(pkg.devDependencies ?? {}).slice(0, 30),
        };
        parts.push('## package.json\n\n```json\n' + JSON.stringify(summary, null, 2) + '\n```');
      } catch {
        /* ignore */
      }
    }
  }

  // composer.json (PHP)
  const composerPath = join(root, 'composer.json');
  if (existsSync(composerPath)) {
    const raw = safeRead(composerPath);
    if (raw) parts.push('## composer.json\n\n```json\n' + raw.slice(0, 2000) + '\n```');
  }

  // requirements.txt / pyproject.toml (Python)
  for (const f of ['requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
    const p = join(root, f);
    if (existsSync(p)) {
      const c = safeRead(p);
      if (c) parts.push(`## ${f}\n\n\`\`\`\n${c.slice(0, 1500)}\n\`\`\``);
    }
  }

  // File tree (até 200 paths, agrupado)
  const treePaths = files
    .map((f) => f.relative)
    .filter((p) => !p.includes('node_modules') && !p.startsWith('.'))
    .slice(0, 200);
  parts.push('## File structure (up to 200)\n\n```\n' + treePaths.join('\n') + '\n```');

  // Sources linkados (cross-repo)
  if (otherSources.length > 0) {
    const others = otherSources.map((s) => {
      const role = s.role ? ` _(${s.role})_` : '';
      const repo = s.repoFullName ? ` · github:${s.repoFullName}` : '';
      return `- **${s.label}**${role}${repo}`;
    });
    parts.push(
      '## Other workspace sources (cross-repo)\n\n' +
        'These are sibling repositories in the same workspace. When something in this source ' +
        'talks to them (e.g. frontend calls the backend API), CREATE links via ' +
        '[[Sibling page title]] OR `kb_link_pages`, mentioning it explicitly.\n\n' +
        others.join('\n'),
    );
  }

  return parts.join('\n\n---\n\n');
}

function buildAnalysisPrompt(opts: {
  source: WorkspaceSource;
  rootPageId: string;
  otherSources: WorkspaceSource[];
  context: string;
  fileCount: number;
}): string {
  const { source, rootPageId, otherSources, context, fileCount } = opts;
  const repoName = source.label;
  const repoRef = source.repoFullName ? `\`${source.repoFullName}\`` : `\`${source.path}\``;

  return [
    `# 🧠 You are a senior Architecture Analyst at Orkestral`,
    '',
    `**Mission**: build a DEEP knowledge base about the \`${repoName}\` repository (${repoRef}, ${fileCount} files). The user will rely on this KB to do their work — so every page must be USEFUL, not generic.`,
    '',
    `**LANGUAGE (hard rule)**: write ALL pages (titles and content) in ${activeLanguageName()}. Established technical terms may stay in English, but full sentences must be in the indicated language.`,
    '',
    '## HARD RULES',
    '',
    `1. **Every page you create must have \`parent_page_id="${rootPageId}"\`** (or be a sub-page of one you created). NEVER create an orphan page without a parent.`,
    `2. **Every page you create for this repository must include \`source_id="${source.id}"\`**. This prevents backend/frontend/mobile repositories from merging pages with the same title.`,
    '3. Use \`kb_create_page\` (MCP tool) to create pages. **Do not respond with text alone** — you fail if you do not materialize the knowledge as pages.',
    '4. Each page must have a **short, imperative title** + a **rich markdown description** (not empty, not a placeholder). Include relevant code snippets when it makes sense (use markdown blocks).',
    '5. Use **wikilinks** \`[[Title of another page]]\` in the content to build the knowledge tree. Orkestral resolves them automatically.',
    '6. If this repo relates to OTHER sources in the workspace, mention them in the text and create wikilinks to future sibling pages.',
    '',
    '## MANDATORY PAGES TO CREATE',
    '',
    'Create at least these, in this order:',
    '',
    `1. **Overview** — the project purpose, the problem it solves, its audience, status (production/poc/etc). 1-2 dense paragraphs.`,
    `2. **Architecture** — core technologies, architectural pattern (MVC/clean/hexagonal/etc), entrypoints, main flows (request lifecycle, build, deploy). Include a **text/ascii diagram** if useful.`,
    `3. **Tech Stack** — the main framework, critical libs (cite versions from package.json), runtime, database, infra. Name each lib and WHY it was chosen (infer from usage).`,
    `4. **Dependencies** — a grouped tree (Core, UI, Build, Test, etc) with 1 line explaining the role of each. Use nested \`-\` bullets. Connect related deps through the text.`,
    `5. **Directory Structure** — explain EVERY top-level folder (src/, app/, etc) — what lives there, the naming pattern, examples.`,
    `6. **Main Flows** — for each critical flow in the project (e.g. authentication, chat, upload), create a sub-page explaining step by step who does what.`,
    `7. **Pain Points and Risks** — where the AI/devs must be careful: code smells, obvious technical debt, areas that look fragile, huge files, missing tests in a critical part, etc. BE HONEST, DO NOT SOFTEN IT.`,
    `8. **Conventions and Patterns** — naming, file layouts, import style, formatters, lint, tacit rules. What a new dev needs to know to fit in.`,
    `9. **Setup and Development** — commands to run locally, environment variables, required accounts/keys, known gotchas.`,
    '',
    '## CROSS-REPO',
    '',
    otherSources.length > 0
      ? `This workspace has ${otherSources.length} other source(s): ${otherSources.map((s) => `**${s.label}**${s.role ? ` (${s.role})` : ''}`).join(', ')}. When you find points where this repo connects to one of them (API calls, shared schemas, contracts), CITE them explicitly and use \`[[title]]\` pointing to pages you expect to exist (or that will exist) in the sibling source.`
      : 'The workspace has only this source — focus on it.',
    '',
    '## HOW TO USE THE TOOLS',
    '',
    '- \`list_sources()\` — confirm the sources before citing them.',
    `- \`kb_create_page({ title, content_md, parent_page_id, source_id: "${source.id}", kind: "auto-generated" })\` — your primary weapon. Use it MANY times.`,
    "- You have access to the repo files via Claude's native Read/Glob tools — read the important files before writing (especially entrypoints, configs, schema, main services).",
    '- Go deep: read README, package.json/composer.json/etc, configs (vite/webpack/next), routing files, models, main services, migrations. Do not make things up — derive them from the code.',
    '',
    '## INITIAL CONTEXT',
    '',
    context,
    '',
    '---',
    '',
    `Now BEGIN. Create one page at a time, starting with **Overview** with \`parent_page_id="${rootPageId}"\`. Do not stop until you have reasonable coverage of the 9 points. At the end, write a short paragraph summarizing what was created.`,
  ].join('\n');
}
