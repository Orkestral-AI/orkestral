/**
 * Binary Knowledge Format (BKF) — protocolo proprietário do Orkestral pra
 * armazenar o conhecimento de forma compactável, ordenada hierarquicamente
 * e rápida de processar pelo agente.
 *
 * Estrutura do arquivo `.bkf` agregado (gerado on-demand pra um workspace):
 *
 *   ┌─────────────────────────┐
 *   │  HEADER  (32 bytes)     │  magic "ORKBKF\0\0" + version + flags + count
 *   ├─────────────────────────┤
 *   │  CHUNK 1                │  header(40) + payload(gzip)
 *   ├─────────────────────────┤
 *   │  CHUNK 2                │
 *   ├─────────────────────────┤
 *   │  ...                    │
 *   ├─────────────────────────┤
 *   │  INDEX (variável)       │  table com offset/length por chunk
 *   └─────────────────────────┘
 *
 * Cada CHUNK:
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ id (16)   parent (16)   depth(2) flags(2)           │
 *   │ size_uncompressed(4)   size_compressed(4)           │
 *   ├─────────────────────────────────────────────────────┤
 *   │ payload[size_compressed]                            │
 *   └─────────────────────────────────────────────────────┘
 *
 * O Index no final permite ao agente abrir o arquivo, ler a tabela de offsets
 * e baixar apenas os chunks relevantes — leitura progressiva, hierárquica.
 *
 * Além de gerar o arquivo agregado, este módulo MANTÉM cada chunk persistido
 * na tabela `kb_chunks` do SQLite — fonte da verdade pro MCP search e pra
 * regenerar o arquivo agregado sob demanda.
 */

import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { eq, and } from 'drizzle-orm';
import { getDatabase, ORKESTRAL_WORKSPACES_DIR } from '../db/connection';
import { kbChunks, kbPages } from '../db/schema';

const MAGIC = Buffer.from('ORKBKF\0\0', 'ascii');
const VERSION = 1;
const HEADER_SIZE = 32;
const CHUNK_HEADER_SIZE = 44;

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(buf: Buffer): string {
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/** Compacta um conteúdo markdown e devolve metadados pro chunk. */
export function buildChunkPayload(text: string): {
  payload: Buffer;
  sizeUncompressed: number;
  sizeCompressed: number;
  checksum: string;
} {
  const raw = Buffer.from(text, 'utf-8');
  const gz = gzipSync(raw, { level: 9 });
  return {
    payload: gz,
    sizeUncompressed: raw.length,
    sizeCompressed: gz.length,
    checksum: sha256(raw),
  };
}

/** Descompacta um chunk salvo no DB. */
export function decompressChunk(payload: Buffer): string {
  return gunzipSync(payload).toString('utf-8');
}

interface ChunkRow {
  id: string;
  pageId: string;
  parentChunkId: string | null;
  depth: number;
  payload: Buffer;
  sizeUncompressed: number;
  sizeCompressed: number;
  checksum: string;
}

/**
 * Regenera os chunks SQLite a partir do estado atual das páginas do workspace.
 * Estratégia: deleta os chunks antigos e cria novos. Idempotente.
 *
 * Retorna lista de chunks pra eventual serialização no arquivo BKF.
 */
export function rebuildChunksForWorkspace(workspaceId: string): ChunkRow[] {
  const db = getDatabase();
  // 1. Snapshot ordenado das páginas pelo workspace
  const pages = db.select().from(kbPages).where(eq(kbPages.workspaceId, workspaceId)).all();

  // 2. Calcula depth via mapping parent → depth
  const depthOf = new Map<string, number>();
  function depth(pageId: string): number {
    if (depthOf.has(pageId)) return depthOf.get(pageId)!;
    const p = pages.find((x) => x.id === pageId);
    if (!p || !p.parentId) {
      depthOf.set(pageId, 0);
      return 0;
    }
    const d = depth(p.parentId) + 1;
    depthOf.set(pageId, d);
    return d;
  }

  // 3. Deleta chunks atuais do workspace
  db.delete(kbChunks).where(eq(kbChunks.workspaceId, workspaceId)).run();

  // 4. Cria novos chunks — texto base = title + content_md (fallback content_json)
  const chunks: ChunkRow[] = [];
  const pageIdToChunkId = new Map<string, string>();
  // Cria primeiro pra todas as páginas (pra resolver parent depois)
  for (const p of pages) {
    pageIdToChunkId.set(p.id, randomUUID());
  }
  const now = new Date().toISOString();
  for (const p of pages) {
    const text = buildChunkText(p);
    const { payload, sizeUncompressed, sizeCompressed, checksum } = buildChunkPayload(text);
    const chunkId = pageIdToChunkId.get(p.id)!;
    const parentChunkId = p.parentId ? (pageIdToChunkId.get(p.parentId) ?? null) : null;
    const row: ChunkRow = {
      id: chunkId,
      pageId: p.id,
      parentChunkId,
      depth: depth(p.id),
      payload,
      sizeUncompressed,
      sizeCompressed,
      checksum,
    };
    db.insert(kbChunks)
      .values({
        id: chunkId,
        workspaceId,
        pageId: p.id,
        parentChunkId,
        depth: depth(p.id),
        payload,
        sizeUncompressed,
        sizeCompressed,
        checksum,
        snapshotVersion: 1,
        createdAt: now,
      })
      .run();
    chunks.push(row);
  }
  return chunks;
}

/** Concatena title + content em texto bruto pro chunk. */
function buildChunkText(page: typeof kbPages.$inferSelect): string {
  const md = page.contentMd ?? extractMarkdownFromJson(page.contentJson) ?? '';
  return `# ${page.title}\n\n${md}`;
}

/**
 * Best-effort: extrai markdown de um JSON BlockNote. Se vier malformado,
 * devolve null e o caller usa string vazia. Não tenta render fancy — pra busca
 * o que importa é o texto.
 */
function extractMarkdownFromJson(json: string | null): string | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json);
    if (!Array.isArray(data)) return null;
    const lines: string[] = [];
    walk(data, lines);
    return lines.join('\n');
  } catch {
    return null;
  }
}

function walk(blocks: unknown[], out: string[]): void {
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Record<string, unknown>;
    const content = block.content as unknown;
    if (Array.isArray(content)) {
      const text = content
        .map((c) => {
          if (typeof c === 'string') return c;
          if (c && typeof c === 'object' && 'text' in c) {
            return String((c as { text: unknown }).text ?? '');
          }
          return '';
        })
        .join('');
      if (text.trim()) out.push(text);
    } else if (typeof content === 'string') {
      out.push(content);
    }
    const children = (block.children as unknown[]) ?? [];
    if (Array.isArray(children)) walk(children, out);
  }
}

/** Serializa todos os chunks de um workspace num único Buffer BKF. */
export function serializeWorkspaceBkf(workspaceId: string): Buffer {
  const db = getDatabase();
  const rows = db.select().from(kbChunks).where(eq(kbChunks.workspaceId, workspaceId)).all();

  const buffers: Buffer[] = [];

  // 1. HEADER (32 bytes)
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0, 0, 8);
  header.writeUInt16LE(VERSION, 8);
  header.writeUInt16LE(0, 10); // flags
  header.writeUInt32LE(rows.length, 12);
  // root_offset (8) + index_offset (8) preenchidos depois
  buffers.push(header);

  // 2. CHUNKS
  const indexEntries: Array<{ id: string; offset: number; length: number; parent: string | null }> =
    [];
  let offset = HEADER_SIZE;

  for (const row of rows) {
    const chunkHeader = Buffer.alloc(CHUNK_HEADER_SIZE);
    uuidToBytes(row.id).copy(chunkHeader, 0); // 16
    uuidToBytes(row.parentChunkId ?? '00000000-0000-0000-0000-000000000000').copy(chunkHeader, 16); // 16
    chunkHeader.writeUInt16LE(row.depth, 32); // 2
    chunkHeader.writeUInt16LE(0, 34); // flags (2)
    chunkHeader.writeUInt32LE(row.sizeUncompressed, 36); // 4
    chunkHeader.writeUInt32LE(row.sizeCompressed, 40); // 4

    const total = CHUNK_HEADER_SIZE + (row.payload as Buffer).length;
    indexEntries.push({
      id: row.id,
      offset,
      length: total,
      parent: row.parentChunkId,
    });

    buffers.push(chunkHeader);
    buffers.push(row.payload as Buffer);
    offset += total;
  }

  // 3. INDEX
  const indexOffset = offset;
  const indexHead = Buffer.alloc(4);
  indexHead.writeUInt32LE(indexEntries.length, 0);
  buffers.push(indexHead);
  for (const e of indexEntries) {
    const entry = Buffer.alloc(16 + 8 + 4 + 16);
    uuidToBytes(e.id).copy(entry, 0);
    entry.writeBigUInt64LE(BigInt(e.offset), 16);
    entry.writeUInt32LE(e.length, 24);
    uuidToBytes(e.parent ?? '00000000-0000-0000-0000-000000000000').copy(entry, 28);
    buffers.push(entry);
  }

  // Volta no header e escreve index_offset
  header.writeBigUInt64LE(BigInt(HEADER_SIZE), 16); // root_offset = início dos chunks
  header.writeBigUInt64LE(BigInt(indexOffset), 24);

  return Buffer.concat(buffers);
}

/** Util pra debug: parseia um BKF e devolve a lista de entries. */
export function parseBkfIndex(bkf: Buffer): Array<{
  id: string;
  offset: number;
  length: number;
  parent: string | null;
}> {
  if (bkf.subarray(0, 8).compare(MAGIC) !== 0) {
    throw new Error('Não é um arquivo BKF válido (magic incorreto)');
  }
  const indexOffset = Number(bkf.readBigUInt64LE(24));
  const count = bkf.readUInt32LE(indexOffset);
  const entries: Array<{ id: string; offset: number; length: number; parent: string | null }> = [];
  let pos = indexOffset + 4;
  for (let i = 0; i < count; i++) {
    const id = bytesToUuid(bkf.subarray(pos, pos + 16));
    const off = Number(bkf.readBigUInt64LE(pos + 16));
    const len = bkf.readUInt32LE(pos + 24);
    const parent = bytesToUuid(bkf.subarray(pos + 28, pos + 44));
    entries.push({
      id,
      offset: off,
      length: len,
      parent: parent === '00000000-0000-0000-0000-000000000000' ? null : parent,
    });
    pos += 44;
  }
  return entries;
}

void and; // mantém import disponível

// ---------------------------------------------------------------------------
// Persistência em disco do arquivo .bkf
// ---------------------------------------------------------------------------

/**
 * Caminho onde o snapshot BKF de um workspace é persistido. O arquivo é
 * (re)gerado automaticamente quando a KB muda — agentes podem consumi-lo
 * direto pra carregar a base inteira de forma rápida e ordenada.
 *
 *   ~/.orkestral/workspaces/<workspaceId>/kb/snapshot.bkf
 */
export function getBkfSnapshotPath(workspaceId: string): string {
  return join(ORKESTRAL_WORKSPACES_DIR, workspaceId, 'kb', 'snapshot.bkf');
}

/**
 * Serializa o estado atual e escreve em disco. Retorna `{ path, size, chunks }`.
 * Cria os diretórios pai conforme necessário. Idempotente: pode ser chamado
 * múltiplas vezes — sobrescreve.
 *
 * Performance: gera o buffer in-memory antes de escrever (atomic-ish — não há
 * risco de leitor pegar o arquivo metade escrito porque `writeFileSync` faz
 * write em um syscall).
 */
export function writeBkfSnapshot(workspaceId: string): {
  path: string;
  sizeBytes: number;
  chunkCount: number;
} {
  const buf = serializeWorkspaceBkf(workspaceId);
  const path = getBkfSnapshotPath(workspaceId);
  mkdirSync(join(ORKESTRAL_WORKSPACES_DIR, workspaceId, 'kb'), { recursive: true });
  writeFileSync(path, buf);
  // Lê o count direto do header (offset 12, 4 bytes LE)
  const chunkCount = buf.readUInt32LE(12);
  return { path, sizeBytes: buf.length, chunkCount };
}

/** Retorna metadados do snapshot atual em disco, ou null se ainda não existe. */
export function getBkfSnapshotInfo(workspaceId: string): {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
} | null {
  const path = getBkfSnapshotPath(workspaceId);
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return {
    path,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Debounce de regeneração — evita re-escrever o arquivo 30 vezes quando o
// agente cria 30 páginas em rajada. Coalesces em um único write 800ms depois
// da última mutação.
// ---------------------------------------------------------------------------

const pendingWrites = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 800;

/**
 * Agenda uma regeneração do snapshot. Múltiplas chamadas dentro de DEBOUNCE_MS
 * são coalesced em uma única escrita. Use após mutações na KB.
 */
export function scheduleBkfRebuild(workspaceId: string): void {
  const existing = pendingWrites.get(workspaceId);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    pendingWrites.delete(workspaceId);
    try {
      rebuildChunksForWorkspace(workspaceId);
      const info = writeBkfSnapshot(workspaceId);
      console.log(
        `[bkf] snapshot regenerado workspace=${workspaceId} chunks=${info.chunkCount} size=${info.sizeBytes}B`,
      );
    } catch (err) {
      console.warn(
        `[bkf] regeneração falhou pra ${workspaceId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }, DEBOUNCE_MS);
  pendingWrites.set(workspaceId, handle);
}
