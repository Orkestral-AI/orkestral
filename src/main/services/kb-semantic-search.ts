import { eq, sql } from 'drizzle-orm';
import { getDatabase } from '../db/connection';
import { kbPages } from '../db/schema';
import { bufferToVector, kbEmbeddingRepo, sha256Short } from '../db/repositories/kb-embedding.repo';
import { knowledgeUsageRepo } from '../db/repositories/knowledge-usage.repo';
import { aiLearningRepo } from '../db/repositories/ai-learning.repo';
import {
  embedTextLocal,
  isLocalEmbeddingConfigured,
  LocalEmbeddingUnavailableError,
} from './local-embedding-runtime';
import { tokenize } from './kb-search';
import type { KbPageKind, KbSearchFilters, KbSearchHit } from '../../shared/types';

interface SemanticHit {
  pageId: string;
  itemId: string;
  itemKind: 'page' | 'chunk';
  title: string;
  preview: string | null;
  score: number;
}

interface SemanticPageHit {
  pageId: string;
  score: number;
  bestItemId: string;
  bestItemKind: 'page' | 'chunk';
  bestTitle: string;
  bestPreview: string | null;
}

interface TextChunk {
  title: string;
  text: string;
}

// Limite de segmentos embeddados por página (custo de embedding cresce linear
// com o nº de chunks). Páginas além disso têm a cauda cortada — ver aviso em
// splitPageIntoTextChunks.
const MAX_CHUNKS_PER_PAGE = 80;

function pageText(page: typeof kbPages.$inferSelect): string {
  const md = page.contentMd ?? '';
  return `# ${page.title}\n\n${md}`.trim();
}

function cosine(a: readonly number[], b: Float32Array, bNorm: number): number {
  // Rejeita dimensões divergentes em vez de pontuar só o prefixo comum: drift de
  // modelo/dimensão geraria similaridade plausível-mas-errada sem nenhum sinal.
  // (bufferToVector trunca pra `dimension`, então o mismatch chegaria silencioso.)
  if (a.length !== b.length) return 0;
  let dot = 0;
  let aNormSq = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    dot += av * b[i];
    aNormSq += av * av;
  }
  const denom = Math.sqrt(aNormSq) * bNorm;
  if (denom <= 0) return 0;
  return dot / denom;
}

function excerpt(body: string, maxLen = 220): string {
  const clean = body.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function buildCitation(
  page: typeof kbPages.$inferSelect,
  semantic: SemanticPageHit | undefined,
  lexical: KbSearchHit | undefined,
): NonNullable<KbSearchHit['citation']> {
  const snippet = semantic?.bestPreview || lexical?.excerpt || excerpt(page.contentMd ?? '', 320);
  return {
    pageId: page.id,
    title: page.title,
    slug: page.slug,
    chunkTitle: semantic?.bestItemKind === 'chunk' ? semantic.bestTitle : undefined,
    snippet,
  };
}

function localRerankScore(input: { query: string; title: string; body: string; excerpt: string }): {
  score: number;
  queryCoverage: number;
  titleMatch: number;
  phraseMatch: number;
} {
  const queryTokens = [...new Set(tokenize(input.query))].slice(0, 24);
  if (queryTokens.length === 0) {
    return { score: 0, queryCoverage: 0, titleMatch: 0, phraseMatch: 0 };
  }
  const titleTokens = new Set(tokenize(input.title));
  const evidenceTokens = new Set(
    tokenize(`${input.title}\n${input.excerpt}\n${input.body.slice(0, 4000)}`),
  );
  let covered = 0;
  let titleCovered = 0;
  for (const token of queryTokens) {
    if (evidenceTokens.has(token)) covered++;
    if (titleTokens.has(token)) titleCovered++;
  }
  const queryCoverage = covered / queryTokens.length;
  const titleMatch = titleCovered / queryTokens.length;
  const q = input.query.trim().toLowerCase();
  const phraseMatch =
    q.length >= 8 && `${input.title}\n${input.excerpt}\n${input.body}`.toLowerCase().includes(q)
      ? 1
      : 0;
  const score = queryCoverage * 0.09 + titleMatch * 0.05 + phraseMatch * 0.06;
  return { score, queryCoverage, titleMatch, phraseMatch };
}

function splitPageIntoTextChunks(title: string, body: string): TextChunk[] {
  const clean = body.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const sections: TextChunk[] = [];
  const lines = clean.split('\n');
  let currentTitle = title;
  let current: string[] = [];
  const flush = (): void => {
    const text = current.join('\n').trim();
    if (text) sections.push({ title: currentTitle, text: `# ${currentTitle}\n\n${text}` });
    current = [];
  };

  for (const line of lines) {
    const heading = /^(#{2,4})\s+(.+)$/.exec(line.trim());
    if (heading && current.join('\n').length > 240) {
      flush();
      currentTitle = `${title} / ${heading[2].trim()}`;
      continue;
    }
    current.push(line);
    if (current.join('\n').length >= 1800) flush();
  }
  flush();

  const out: TextChunk[] = [];
  for (const section of sections) {
    if (section.text.length <= 2200) {
      out.push(section);
      continue;
    }
    const paragraphs = section.text.split(/\n{2,}/);
    let buf = '';
    let part = 1;
    for (const p of paragraphs) {
      const next = `${buf}\n\n${p}`.trim();
      if (next.length > 1800 && buf) {
        out.push({ title: `${section.title} (${part})`, text: buf });
        part++;
        buf = p;
      } else {
        buf = next;
      }
    }
    if (buf.trim()) out.push({ title: `${section.title} (${part})`, text: buf.trim() });
  }
  // Cap de chunks por página: páginas muito grandes têm a cauda cortada e nunca
  // são embeddadas/recuperáveis. Mantém o cap (custo de embedding por página),
  // mas loga quando trunca pra não ser silencioso (antes a cauda sumia sem sinal).
  if (out.length > MAX_CHUNKS_PER_PAGE) {
    console.warn(
      `[kb-semantic] página "${title}" gerou ${out.length} chunks; truncando para ${MAX_CHUNKS_PER_PAGE} (a cauda não será indexada)`,
    );
    return out.slice(0, MAX_CHUNKS_PER_PAGE);
  }
  return out;
}

function normalizeScores(entries: Array<[string, number]>): Map<string, number> {
  if (entries.length === 0) return new Map();
  const values = entries.map(([, score]) => score);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(0.000001, max - min);
  return new Map(entries.map(([id, score]) => [id, (score - min) / span]));
}

async function ensureItemEmbedding(input: {
  workspaceId: string;
  itemId: string;
  sourceHash: string;
  text: string;
  changed: boolean;
}): Promise<void> {
  const activeModel = kbEmbeddingRepo.activeModel();
  if (activeModel) {
    if (
      !input.changed &&
      kbEmbeddingRepo.hasEmbedding(input.itemId, activeModel.id, input.sourceHash)
    ) {
      return;
    }
    const reused = kbEmbeddingRepo.copyEmbeddingFromSourceHash({
      workspaceId: input.workspaceId,
      itemId: input.itemId,
      modelId: activeModel.id,
      sourceHash: input.sourceHash,
    });
    if (reused) return;
  }

  const embedding = await embedTextLocal(input.text);
  if (
    !input.changed &&
    kbEmbeddingRepo.hasEmbedding(input.itemId, embedding.modelId, input.sourceHash)
  ) {
    return;
  }
  const reused = kbEmbeddingRepo.copyEmbeddingFromSourceHash({
    workspaceId: input.workspaceId,
    itemId: input.itemId,
    modelId: embedding.modelId,
    sourceHash: input.sourceHash,
  });
  if (reused) return;

  kbEmbeddingRepo.upsertEmbedding({
    workspaceId: input.workspaceId,
    itemId: input.itemId,
    modelId: embedding.modelId,
    vector: embedding.vector,
  });
}

export async function indexPageEmbedding(
  workspaceId: string,
  pageId: string,
  title: string,
  body: string,
): Promise<void> {
  const text = `# ${title}\n\n${body}`.trim();
  if (!text) return;
  const itemResult = kbEmbeddingRepo.upsertPageItem({ workspaceId, pageId, title, text });
  await ensureItemEmbedding({
    workspaceId,
    itemId: itemResult.item.id,
    sourceHash: itemResult.item.sourceHash,
    text,
    changed: itemResult.changed,
  });

  const chunks = splitPageIntoTextChunks(title, body);
  const chunkTextByHash = new Map(chunks.map((chunk) => [sha256Short(chunk.text), chunk.text]));
  const chunkItems = kbEmbeddingRepo.replacePageChunkItems({
    workspaceId,
    pageId,
    chunks,
  });
  for (const chunkResult of chunkItems) {
    const chunkText =
      chunkTextByHash.get(chunkResult.item.sourceHash) ??
      `${chunkResult.item.title}\n\n${chunkResult.item.textPreview ?? ''}`;
    await ensureItemEmbedding({
      workspaceId,
      itemId: chunkResult.item.id,
      sourceHash: chunkResult.item.sourceHash,
      text: chunkText,
      changed: chunkResult.changed,
    });
  }

  // Churn incremental de chunks (replacePageChunkItems deleta os stale) deixava
  // vetores órfãos acumularem entre full-reindexes e contarem pro cap de 5000.
  // O cascade de FK limpa a maioria, mas varremos aqui pra cobrir os residuais.
  kbEmbeddingRepo.deleteOrphanVectors(workspaceId);
}

export async function reindexWorkspaceEmbeddings(workspaceId: string): Promise<number> {
  const db = getDatabase();
  const pages = db.select().from(kbPages).where(eq(kbPages.workspaceId, workspaceId)).all();
  let indexed = 0;
  for (const p of pages) {
    if (p.isArchived === 1) continue;
    await indexPageEmbedding(workspaceId, p.id, p.title, p.contentMd ?? '');
    indexed++;
  }
  kbEmbeddingRepo.deleteOrphanVectors(workspaceId);
  return indexed;
}

export async function semanticSearch(
  workspaceId: string,
  query: string,
  limit = 20,
): Promise<SemanticPageHit[]> {
  // Pré-check SÍNCRONO: se o embedder ainda não está em disco (ex.: baixando), nem chama
  // embedTextLocal — que esperaria até ~3min pelo lock de download e penduraria a busca.
  // Lança direto → o caller cai no fallback BM25 (instantâneo).
  if (!isLocalEmbeddingConfigured()) {
    throw new LocalEmbeddingUnavailableError(
      'Embedder local ainda indisponível (sem modelo em disco).',
    );
  }
  const queryEmbedding = await embedTextLocal(query);
  const vectors = kbEmbeddingRepo.listVectors(workspaceId, queryEmbedding.modelId, 5000);
  if (vectors.length === 0) return [];
  const scoredItems = vectors
    .map(({ item, embedding }) => {
      const vector = bufferToVector(embedding.vector as Buffer, embedding.dimension);
      return {
        pageId: item.pageId,
        itemId: item.id,
        itemKind: item.itemKind as 'page' | 'chunk',
        title: item.title,
        preview: item.textPreview,
        score: cosine(queryEmbedding.vector, vector, embedding.norm),
      };
    })
    .filter((h): h is SemanticHit => !!h.pageId && Number.isFinite(h.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit * 4, 40));

  const byPage = new Map<string, SemanticPageHit>();
  for (const item of scoredItems) {
    const current = byPage.get(item.pageId);
    if (!current || item.score > current.score) {
      byPage.set(item.pageId, {
        pageId: item.pageId,
        score: item.score,
        bestItemId: item.itemId,
        bestItemKind: item.itemKind,
        bestTitle: item.title,
        bestPreview: item.preview,
      });
    }
  }
  return [...byPage.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (Date.now() - ts) / (24 * 60 * 60 * 1000));
}

function recencyBoost(updatedAt: string | null | undefined): number {
  const days = daysSince(updatedAt);
  if (days === null) return 0;
  if (days <= 14) return 0.06;
  if (days <= 60) return 0.03;
  if (days >= 365) return -0.04;
  return 0;
}

function usageBoost(lastUsedAt: string | null | undefined, useCount: number): number {
  const days = daysSince(lastUsedAt);
  if (days === null) return 0;
  const freshness = days <= 30 ? 0.04 : days <= 90 ? 0.02 : 0;
  return Math.min(0.06, freshness + Math.log1p(useCount) * 0.006);
}

// Recebe o exemplo de feedback já carregado (em lote) em vez de consultar por
// candidato — ver findRagFeedbackExamplesByPageId. `undefined` = sem feedback.
function feedbackBoost(feedback: { label: string } | undefined): number {
  if (!feedback) return 0;
  if (feedback.label === 'positive') return 0.09;
  if (feedback.label === 'negative') return -0.12;
  if (feedback.label === 'correction') return 0.04;
  return 0;
}

/**
 * Fallback puramente lexical (BM25): aplica filtros + ranqueia só pelos
 * `lexicalHits`. Usado quando a busca semântica (embedding) falha — a busca
 * NUNCA deve morrer por falta de embedding local. Mantém o contrato de
 * `KbSearchHit` com `retrievalMode='lexical'`.
 */
function lexicalFallbackHits(
  workspaceId: string,
  query: string,
  lexicalHits: KbSearchHit[],
  limit: number,
  filters: KbSearchFilters,
): KbSearchHit[] {
  if (lexicalHits.length === 0) return [];
  const lexicalNorm = normalizeScores(lexicalHits.map((h) => [h.pageId, h.score]));
  const ids = [...new Set(lexicalHits.map((h) => h.pageId))];

  const db = getDatabase();
  const pages = db
    .select()
    .from(kbPages)
    .where(
      sql`workspace_id = ${workspaceId} AND id IN (${sql.raw(
        ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',') || "''",
      )})`,
    )
    .all();
  const lexicalById = new Map(lexicalHits.map((h) => [h.pageId, h]));
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const usageById = knowledgeUsageRepo.statsForPages(workspaceId, ids);
  const feedbackById = aiLearningRepo.findRagFeedbackExamplesByPageId({
    workspaceId,
    query,
    pageIds: ids,
  });

  const combined: KbSearchHit[] = [];
  for (const pageId of ids) {
    const page = pageById.get(pageId);
    if (!page) continue;
    if (!filters.includeArchived && page.isArchived === 1) continue;
    if (filters.kinds?.length && !filters.kinds.includes(page.kind as KbPageKind)) continue;
    if (
      filters.sourceId !== undefined &&
      filters.sourceId !== null &&
      page.sourceId !== filters.sourceId
    ) {
      continue;
    }
    if (filters.updatedAfter && page.updatedAt < filters.updatedAfter) continue;
    const lexicalScore = lexicalNorm.get(pageId) ?? 0;
    const usage = usageById.get(pageId);
    const lexical = lexicalById.get(pageId);
    const selectedExcerpt = lexical?.excerpt || excerpt(page.contentMd ?? '');
    const localRerank = localRerankScore({
      query,
      title: page.title,
      body: page.contentMd ?? '',
      excerpt: selectedExcerpt,
    });
    const rerankSignals = {
      recency: recencyBoost(page.updatedAt),
      usage: usageBoost(usage?.lastUsedAt, usage?.useCount ?? 0),
      feedback: feedbackBoost(feedbackById.get(pageId)),
      localRerank: localRerank.score,
      queryCoverage: localRerank.queryCoverage,
      titleMatch: localRerank.titleMatch,
      phraseMatch: localRerank.phraseMatch,
    };
    const score =
      lexicalScore * 0.84 +
      rerankSignals.recency +
      rerankSignals.usage +
      rerankSignals.feedback +
      rerankSignals.localRerank;
    if (filters.requireUsage && !usage) continue;
    if (filters.minScore !== undefined && score < filters.minScore) continue;
    combined.push({
      pageId,
      title: page.title,
      slug: page.slug,
      excerpt: selectedExcerpt,
      score,
      lexicalScore,
      semanticScore: 0,
      retrievalMode: 'lexical',
      explanation: [
        lexicalScore > 0 ? `BM25=${lexicalScore.toFixed(2)}` : null,
        'embedding indisponível (fallback lexical)',
        rerankSignals.usage > 0 ? `uso=+${rerankSignals.usage.toFixed(2)}` : null,
        rerankSignals.localRerank > 0
          ? `rerank-local=+${rerankSignals.localRerank.toFixed(2)}`
          : null,
      ].filter(Boolean) as string[],
      rerankSignals,
      citation: buildCitation(page, undefined, lexical),
      parentId: page.parentId,
      kind: page.kind as KbPageKind,
      sourceId: page.sourceId,
    });
  }

  const results = combined.sort((a, b) => b.score - a.score).slice(0, limit);
  for (const hit of results) {
    knowledgeUsageRepo.recordHit({
      workspaceId,
      targetKind: 'page',
      targetId: hit.pageId,
      hitCount: 1,
    });
  }
  return results;
}

export async function hybridSearchPages(
  workspaceId: string,
  query: string,
  lexicalHits: KbSearchHit[],
  limit = 20,
  filters: KbSearchFilters = {},
): Promise<KbSearchHit[]> {
  let semanticHits: SemanticPageHit[];
  try {
    semanticHits = await semanticSearch(workspaceId, query, Math.max(limit * 3, 30));
  } catch (err) {
    // Embedding local indisponível/falhou: NÃO derruba a busca. Cai pro BM25
    // puro (UI e tool kb_search continuam funcionais). Só loga em warn.
    console.warn(
      '[kb-search] busca semântica indisponível; usando fallback lexical (BM25):',
      err instanceof Error ? err.message : String(err),
    );
    return lexicalFallbackHits(workspaceId, query, lexicalHits, limit, filters);
  }

  const lexicalNorm = normalizeScores(lexicalHits.map((h) => [h.pageId, h.score]));
  const semanticNorm = normalizeScores(semanticHits.map((h) => [h.pageId, h.score]));
  const ids = [
    ...new Set([...lexicalHits.map((h) => h.pageId), ...semanticHits.map((h) => h.pageId)]),
  ];
  if (ids.length === 0) return [];

  const db = getDatabase();
  const pages = db
    .select()
    .from(kbPages)
    .where(
      sql`workspace_id = ${workspaceId} AND id IN (${sql.raw(
        ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',') || "''",
      )})`,
    )
    .all();
  const lexicalById = new Map(lexicalHits.map((h) => [h.pageId, h]));
  const semanticById = new Map(semanticHits.map((h) => [h.pageId, h]));
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const usageById = knowledgeUsageRepo.statsForPages(workspaceId, ids);
  const feedbackById = aiLearningRepo.findRagFeedbackExamplesByPageId({
    workspaceId,
    query,
    pageIds: ids,
  });

  const combined: KbSearchHit[] = [];
  for (const pageId of ids) {
    const page = pageById.get(pageId);
    if (!page) continue;
    if (!filters.includeArchived && page.isArchived === 1) continue;
    if (filters.kinds?.length && !filters.kinds.includes(page.kind as KbPageKind)) continue;
    if (
      filters.sourceId !== undefined &&
      filters.sourceId !== null &&
      page.sourceId !== filters.sourceId
    ) {
      continue;
    }
    if (filters.updatedAfter && page.updatedAt < filters.updatedAfter) continue;
    const lexicalScore = lexicalNorm.get(pageId) ?? 0;
    const semanticScore = semanticNorm.get(pageId) ?? 0;
    const usage = usageById.get(pageId);
    const lexical = lexicalById.get(pageId);
    const semantic = semanticById.get(pageId);
    const selectedExcerpt =
      semantic?.bestPreview || lexical?.excerpt || excerpt(page.contentMd ?? '');
    const localRerank = localRerankScore({
      query,
      title: page.title,
      body: page.contentMd ?? '',
      excerpt: selectedExcerpt,
    });
    const rerankSignals = {
      recency: recencyBoost(page.updatedAt),
      usage: usageBoost(usage?.lastUsedAt, usage?.useCount ?? 0),
      feedback: feedbackBoost(feedbackById.get(pageId)),
      localRerank: localRerank.score,
      queryCoverage: localRerank.queryCoverage,
      titleMatch: localRerank.titleMatch,
      phraseMatch: localRerank.phraseMatch,
    };
    const score =
      lexicalScore * 0.34 +
      semanticScore * 0.5 +
      rerankSignals.recency +
      rerankSignals.usage +
      rerankSignals.feedback +
      rerankSignals.localRerank;
    if (filters.requireUsage && !usage) continue;
    if (filters.minScore !== undefined && score < filters.minScore) continue;
    combined.push({
      pageId,
      title: page.title,
      slug: page.slug,
      excerpt: selectedExcerpt,
      score,
      lexicalScore,
      semanticScore: semantic?.score ?? 0,
      retrievalMode:
        lexicalScore > 0 && semanticScore > 0
          ? 'hybrid'
          : semanticScore > 0
            ? 'semantic'
            : 'lexical',
      explanation: [
        lexicalScore > 0 ? `BM25=${lexicalScore.toFixed(2)}` : null,
        semantic ? `embedding=${semantic.score.toFixed(3)} (${semantic.bestItemKind})` : null,
        rerankSignals.usage > 0 ? `uso=+${rerankSignals.usage.toFixed(2)}` : null,
        rerankSignals.recency !== 0 ? `idade=${rerankSignals.recency.toFixed(2)}` : null,
        rerankSignals.feedback !== 0 ? `feedback=${rerankSignals.feedback.toFixed(2)}` : null,
        rerankSignals.localRerank > 0
          ? `rerank-local=+${rerankSignals.localRerank.toFixed(2)}`
          : null,
        rerankSignals.queryCoverage > 0
          ? `cobertura=${Math.round(rerankSignals.queryCoverage * 100)}%`
          : null,
      ].filter(Boolean) as string[],
      bestChunkTitle: semantic?.bestItemKind === 'chunk' ? semantic.bestTitle : undefined,
      rerankSignals,
      citation: buildCitation(page, semantic, lexical),
      parentId: page.parentId,
      kind: page.kind as KbPageKind,
      sourceId: page.sourceId,
    });
  }

  const results = combined.sort((a, b) => b.score - a.score).slice(0, limit);

  for (const hit of results) {
    knowledgeUsageRepo.recordHit({
      workspaceId,
      targetKind: 'page',
      targetId: hit.pageId,
      hitCount: 1,
    });
  }
  return results;
}

export function sourceHashForPage(workspaceId: string, pageId: string): string | null {
  const db = getDatabase();
  const page = db
    .select()
    .from(kbPages)
    .where(sql`workspace_id = ${workspaceId} AND id = ${pageId}`)
    .get();
  return page ? sha256Short(pageText(page)) : null;
}

/**
 * Página já está indexada para o conteúdo atual? Usado pela fila de embedding
 * para PULAR páginas inalteradas sem re-walk/re-split/re-embed. Computa o hash
 * do texto da página (mesmo formato de `indexPageEmbedding`) e confirma, via
 * repo, que o item `page` + todos os `chunk` têm vetor sob o modelo ativo.
 * Retorna `false` quando não há modelo ativo (deixa o reuse por-item decidir).
 */
export function isPageEmbeddingUpToDate(
  page: Pick<typeof kbPages.$inferSelect, 'id' | 'workspaceId' | 'title' | 'contentMd'>,
): boolean {
  const activeModel = kbEmbeddingRepo.activeModel();
  if (!activeModel) return false;
  const text = `# ${page.title}\n\n${page.contentMd ?? ''}`.trim();
  if (!text) return false;
  return kbEmbeddingRepo.isPageFullyEmbedded({
    workspaceId: page.workspaceId,
    pageId: page.id,
    modelId: activeModel.id,
    pageSourceHash: sha256Short(text),
  });
}
