/**
 * Service de orquestração da knowledge base. Junta page-repo + link-repo +
 * search-service + chunk-snapshot pra expor uma API unificada pros handlers IPC.
 */

import { KbPageRepository } from '../db/repositories/kb-page.repo';
import { KbLinkRepository } from '../db/repositories/kb-link.repo';
import { KbEntityRepository } from '../db/repositories/kb-entity.repo';
import { kbEmbeddingRepo } from '../db/repositories/kb-embedding.repo';
import { indexPage, reindexWorkspace, search, searchCode } from './kb-search';
import {
  rebuildChunksForWorkspace,
  writeBkfSnapshot,
  scheduleBkfRebuild,
  getBkfSnapshotInfo,
} from './kb-binary-storage';
import { hybridSearchPages } from './kb-semantic-search';
import {
  cancelEmbeddingJob,
  enqueuePageEmbedding,
  enqueueWorkspaceEmbeddings,
  listEmbeddingJobs,
} from './kb-embedding-queue';
import type {
  KbEmbeddingJobSummary,
  KbGraph,
  KbGraphEdge,
  KbGraphNode,
  KbGraphStats,
  KbPage,
  KbSearchFilters,
  KbSearchHit,
} from '../../shared/types';

const pageRepo = new KbPageRepository();
const linkRepo = new KbLinkRepository();
const entityRepo = new KbEntityRepository();

function schedulePageEmbeddingIndex(workspaceId: string, pageId: string): void {
  enqueuePageEmbedding({ workspaceId, pageId, reason: 'page-write' });
}

export function listPages(workspaceId: string, includeArchived = false): KbPage[] {
  return pageRepo.listByWorkspace(workspaceId, includeArchived);
}

export function pageTree(workspaceId: string) {
  return pageRepo.tree(workspaceId);
}

export function getPageWithBacklinks(pageId: string) {
  const page = pageRepo.get(pageId);
  if (!page) return null;
  const backlinks = linkRepo.backlinksToPage(pageId);
  return { page, backlinks };
}

export function resolveWikilink(workspaceId: string, label: string) {
  return pageRepo.resolveWikilink(workspaceId, label);
}

export function createPage(input: Parameters<KbPageRepository['create']>[0]): KbPage {
  const page = pageRepo.create(input);
  // Index inicial só com título (corpo vazio)
  indexPage(page.workspaceId, page.id, page.title, page.contentMd ?? '');
  schedulePageEmbeddingIndex(page.workspaceId, page.id);
  scheduleBkfRebuild(page.workspaceId);
  return page;
}

export function updatePage(input: {
  pageId: string;
  patch: Parameters<KbPageRepository['update']>[1];
  links?: Array<{
    targetKind: 'page' | 'entity' | 'external';
    targetId?: string | null;
    targetLabel?: string | null;
    targetUrl?: string | null;
  }>;
}): KbPage | null {
  const updated = pageRepo.update(input.pageId, input.patch);
  // Página sumiu no meio (race com job de análise/limpeza concorrente) → nada a
  // reindexar; devolve null em vez de quebrar (o chamador trata).
  if (!updated) return null;
  // Reindex com novo conteúdo
  indexPage(updated.workspaceId, updated.id, updated.title, updated.contentMd ?? '');
  schedulePageEmbeddingIndex(updated.workspaceId, updated.id);
  // Sync links se vieram
  if (input.links) {
    linkRepo.setLinksForPage(updated.workspaceId, updated.id, input.links);
  }
  scheduleBkfRebuild(updated.workspaceId);
  return updated;
}

export function deletePage(pageId: string): void {
  const page = pageRepo.get(pageId);
  pageRepo.delete(pageId);
  // Se ficou sem nenhuma página no workspace, limpa também entidades órfãs
  // pra não restarem "asteroides" cinzas no grafo apontando pra nada.
  if (page) {
    const remaining = pageRepo.listByWorkspace(page.workspaceId, true);
    if (remaining.length === 0) {
      entityRepo.deleteOrphans(page.workspaceId);
    }
    scheduleBkfRebuild(page.workspaceId);
  }
}

export async function searchPages(
  workspaceId: string,
  query: string,
  limit = 20,
  filters: KbSearchFilters = {},
) {
  const lexical = search(workspaceId, query, Math.max(limit * 2, 20));
  const pageHits = await hybridSearchPages(workspaceId, query, lexical, limit, filters);
  return mergeCodeHits(workspaceId, query, pageHits, limit, filters);
}

/**
 * Funde os hits de CÓDIGO-FONTE (BM25 sobre kb_code_chunks) com os hits de PÁGINAS
 * da KB num único ranking. Code e KB são corpora separados com escalas de score
 * distintas, então normaliza cada lado [0,1] antes de intercalar — assim ambos
 * aparecem em vez de um corpus dominar a janela. Code hits respeitam o filtro de
 * sourceId; o filtro de `kinds` só se aplica a páginas (code não tem KbPageKind).
 */
function mergeCodeHits(
  workspaceId: string,
  query: string,
  pageHits: KbSearchHit[],
  limit: number,
  filters: KbSearchFilters,
): KbSearchHit[] {
  // Filtro EXPLÍCITO de kinds pede um subconjunto específico de páginas KB — o
  // caller não quer código nesse caso. Sem kinds (default) inclui ambos os corpora.
  if (filters.kinds?.length) return pageHits;
  let codeHits = searchCode(workspaceId, query, Math.max(limit, 10));
  if (filters.sourceId !== undefined && filters.sourceId !== null) {
    codeHits = codeHits.filter((h) => h.sourceId === filters.sourceId);
  }
  if (codeHits.length === 0) return pageHits;

  const norm = (hits: KbSearchHit[]): Map<string, number> => {
    if (hits.length === 0) return new Map();
    const max = Math.max(...hits.map((h) => h.score));
    const min = Math.min(...hits.map((h) => h.score));
    const span = Math.max(0.000001, max - min);
    return new Map(hits.map((h) => [h.pageId, (h.score - min) / span]));
  };
  const pageNorm = norm(pageHits);
  const codeNorm = norm(codeHits);
  const combined = [...pageHits, ...codeHits].map((h) => ({
    hit: h,
    sort: h.sourceKind === 'code' ? (codeNorm.get(h.pageId) ?? 0) : (pageNorm.get(h.pageId) ?? 0),
  }));
  return combined
    .sort((a, b) => b.sort - a.sort)
    .slice(0, limit)
    .map((c) => c.hit);
}

/**
 * Snapshot do grafo: páginas + entidades como nós, wikilinks + relations
 * como arestas. Usado pelo visualizador galaxy.
 */
export function getGraph(workspaceId: string): KbGraph {
  const pages = pageRepo.listByWorkspace(workspaceId, false);
  const entities = entityRepo.listByWorkspace(workspaceId);
  const wikilinks = linkRepo.listByWorkspace(workspaceId);
  const relations = entityRepo.listRelations(workspaceId);

  // Conta degree por nó (inclui hierarquia parent→child)
  const degrees = new Map<string, number>();
  function bump(id: string) {
    degrees.set(id, (degrees.get(id) ?? 0) + 1);
  }
  // 1. Parent→child da hierarquia de páginas
  for (const p of pages) {
    if (p.parentId) {
      bump(p.parentId);
      bump(p.id);
    }
  }
  // 2. Wikilinks explícitos
  for (const l of wikilinks) {
    bump(l.sourcePageId);
    if (l.targetId) bump(l.targetId);
  }
  // 3. Entity relations
  for (const r of relations) {
    bump(r.sourceEntityId);
    bump(r.targetEntityId);
  }

  // Liga cada entidade órfã (sem relation) ao planeta do repo de origem, pra
  // aparecer como uma estrelinha orbitando o source (o renderer desenha esses
  // nós BEM pequenos). Match pelo label da source na descrição "Usado em `x`";
  // com 1 repo só, liga todas nele.
  const rootPages = pages.filter((p) => !p.parentId);
  const syntheticEntityEdges: KbGraphEdge[] = [];
  if (rootPages.length > 0) {
    for (const e of entities) {
      if ((degrees.get(e.id) ?? 0) > 0) continue;
      let root = rootPages[0];
      if (rootPages.length > 1) {
        const label = (e.description ?? '').match(/`([^`]+)`/)?.[1]?.toLowerCase();
        if (label) {
          root = rootPages.find((p) => p.title.toLowerCase().includes(label)) ?? rootPages[0];
        }
      }
      syntheticEntityEdges.push({
        id: `mention:${root.id}:${e.id}`,
        source: root.id,
        target: e.id,
        kind: 'wikilink',
        label: 'menciona',
        weight: 0.3,
      });
      bump(root.id);
      bump(e.id);
    }
  }

  // Segmentos (chunks) realmente indexados por página — vem do repo de
  // embeddings, não de um campo na page (que nunca era escrito → HUD em 0).
  const chunkByPage = kbEmbeddingRepo.chunkCountsByPage(workspaceId);

  const nodes: KbGraphNode[] = [];
  for (const p of pages) {
    nodes.push({
      id: p.id,
      kind: 'page',
      label: p.title,
      subtype: p.kind,
      degree: degrees.get(p.id) ?? 0,
      excerpt: (p.contentMd ?? '').slice(0, 120),
      chunkCount: chunkByPage.get(p.id) ?? 0,
      // createdAt/updatedAt alimentam o "Crescimento" e a aurora <7d. Sem isso
      // o cálculo semanal lia undefined → sempre "+0 esta semana".
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    });
  }
  // TODAS as entidades viram nós (inclui as órfãs — ex.: dependências npm). O
  // grafo "Tudo" esconde as órfãs (degree 0) no renderer pra não virar hairball,
  // mas o filtro "Entidades" precisa delas pra mostrar o que existe (antes o
  // filtro ficava vazio apesar do badge "131 entidades").
  for (const e of entities) {
    nodes.push({
      id: e.id,
      kind: 'entity',
      label: e.name,
      subtype: e.kind,
      degree: degrees.get(e.id) ?? 0,
      excerpt: e.description ?? undefined,
      createdAt: e.createdAt,
    });
  }

  const edges: KbGraphEdge[] = [];
  // Hierarquia parent→child como edge sintético
  for (const p of pages) {
    if (p.parentId) {
      edges.push({
        id: `hier:${p.parentId}:${p.id}`,
        source: p.parentId,
        target: p.id,
        kind: 'wikilink',
        label: 'contém',
        weight: 1.5,
      });
    }
  }
  for (const l of wikilinks) {
    if (l.targetKind !== 'page' || !l.targetId) continue;
    edges.push({
      id: l.id,
      source: l.sourcePageId,
      target: l.targetId,
      kind: 'wikilink',
      label: l.targetLabel,
      weight: l.strength,
    });
  }
  for (const r of relations) {
    edges.push({
      id: r.id,
      source: r.sourceEntityId,
      target: r.targetEntityId,
      kind: 'relation',
      label: r.relationType,
      weight: r.weight,
    });
  }
  // Arestas finas repo→entidade (estrelinhas orbitando o source).
  edges.push(...syntheticEntityEdges);

  return { nodes, edges, stats: buildGraphStats(nodes, edges, entities.length) };
}

function buildGraphStats(
  nodes: KbGraphNode[],
  edges: KbGraphEdge[],
  // Total REAL de entidades do workspace (inclui órfãs, que o grafo esconde mas
  // contam como conhecimento). O grafo filtra entidades sem conexão, então
  // `nodes` subconta — usamos este pra "Massa de conhecimento".
  realEntityCount: number,
): KbGraphStats {
  const pages = nodes.filter((n) => n.kind === 'page');
  const entities = nodes.filter((n) => n.kind === 'entity');
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * dayMs;
  const pageCreatedTimes = pages
    .map((p) => ({ node: p, time: p.createdAt ? Date.parse(p.createdAt) : Number.NaN }))
    .filter((p) => Number.isFinite(p.time));
  const layerCounts = new Map<string, number>();
  for (const node of nodes) {
    // Key da camada = nome puro que o HUD traduz (knowledge.hud.layer.<key>) e
    // colore (LAYER_COLORS): entidades agregam em 'entity'; páginas usam o kind
    // (doc/auto-generated/agent-memory/index). Sem prefixo `page:`.
    const key = node.kind === 'entity' ? 'entity' : (node.subtype ?? 'doc');
    layerCounts.set(key, (layerCounts.get(key) ?? 0) + 1);
  }
  const weeklyGrowth = Array.from({ length: 7 }, (_, index) => {
    const start = now - (6 - index) * dayMs;
    const end = start + dayMs;
    return pageCreatedTimes.filter(({ time }) => time >= start && time < end).length;
  });
  const entityIds = new Set(entities.map((e) => e.id));
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== 'relation' || !entityIds.has(edge.source) || !entityIds.has(edge.target))
      continue;
    const sourceSet = adjacency.get(edge.source) ?? new Set<string>();
    sourceSet.add(edge.target);
    adjacency.set(edge.source, sourceSet);
    const targetSet = adjacency.get(edge.target) ?? new Set<string>();
    targetSet.add(edge.source);
    adjacency.set(edge.target, targetSet);
  }
  const visited = new Set<string>();
  let constellationCount = 0;
  for (const id of entityIds) {
    if (visited.has(id)) continue;
    const stack = [id];
    let size = 0;
    visited.add(id);
    while (stack.length > 0) {
      const current = stack.pop()!;
      size++;
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    if (size >= 2) constellationCount++;
  }
  return {
    totalPages: pages.length,
    totalEntities: realEntityCount,
    totalChunks: pages.reduce((sum, page) => sum + (page.chunkCount ?? 0), 0),
    totalRetrievals: pages.reduce((sum, page) => sum + (page.retrievalCount ?? 0), 0),
    recentlyAddedCount: pageCreatedTimes.filter(({ time }) => time >= sevenDaysAgo).length,
    edgeCount: edges.length,
    topHubs: [...nodes]
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 5)
      .map((node) => ({
        id: node.id,
        label: node.label,
        kind: node.kind,
        degree: node.degree,
        isPlanet: node.kind === 'page' && !node.parentId,
      })),
    layerDistribution: [...layerCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => ({ key, count })),
    constellationCount,
    weeklyGrowth,
    recentPages: pageCreatedTimes
      .sort((a, b) => b.time - a.time)
      .slice(0, 3)
      .map(({ node }) => ({ id: node.id, title: node.label })),
  };
}

export async function rebuildSnapshots(workspaceId: string): Promise<{
  chunks: number;
  bkfPath: string;
  bkfSizeBytes: number;
  embeddings: number;
  embeddingJobId: string;
}> {
  const chunks = rebuildChunksForWorkspace(workspaceId);
  reindexWorkspace(workspaceId);
  const embeddingJob = enqueueWorkspaceEmbeddings({ workspaceId, reason: 'workspace-rebuild' });
  // Sync (não debounced) — caller chamou explicitamente, espera o arquivo no disco
  const info = writeBkfSnapshot(workspaceId);
  return {
    chunks: chunks.length,
    bkfPath: info.path,
    bkfSizeBytes: info.sizeBytes,
    embeddings: embeddingJob.total,
    embeddingJobId: embeddingJob.id,
  };
}

/** Retorna info do snapshot BKF persistido em disco (ou null se ainda não existe). */
export function getBkfInfo(workspaceId: string) {
  return getBkfSnapshotInfo(workspaceId);
}

export function getEmbeddingJobs(workspaceId: string): KbEmbeddingJobSummary[] {
  return listEmbeddingJobs(workspaceId);
}

export function cancelEmbeddingIndexJob(jobId: string): boolean {
  return cancelEmbeddingJob(jobId);
}
