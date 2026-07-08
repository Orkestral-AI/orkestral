import { listFilesUnder } from '../ipc/handlers/sources';
import { WorkspaceSourceRepository } from '../db/repositories/workspace-source.repo';

/**
 * Mentions de `@arquivo` no composer do REPL — paridade com a GUI: a mention
 * vai LITERAL no texto da mensagem (`@caminho/relativo `), sem expansão no
 * servidor; o modelo resolve o path porque o cwd do spawn é a raiz da source.
 * Este módulo cuida da LISTA de arquivos (walker da source primary, com cache)
 * e do filtro/detecção de token — tudo puro fora do `loadWorkspaceFiles`.
 */

/** Um arquivo da source, com path relativo à raiz dela (formato da mention). */
export interface WorkspaceFile {
  relPath: string;
}

/** Máximo de sugestões no popup — lista curta cabe sem janela rolante. */
export const FILE_MATCH_CAP = 8;

/** Validade do cache de arquivos por workspace — re-varre o disco no máx. 1x/min. */
const FILES_CACHE_TTL_MS = 60_000;

const filesCache = new Map<string, { at: number; files: WorkspaceFile[] }>();

/**
 * Arquivos da source PRIMARY do workspace (mesmo walker do mention da GUI:
 * BFS com caps, pula dot-dirs/node_modules etc). Cache por workspaceId com TTL
 * de 60s — o popup consulta a cada tecla, mas o disco só é varrido no primeiro
 * `@` e depois de expirar. Workspace sem source primary (ou sem path) = lista
 * vazia (o popup simplesmente não abre).
 */
export function loadWorkspaceFiles(workspaceId: string): WorkspaceFile[] {
  const hit = filesCache.get(workspaceId);
  if (hit && Date.now() - hit.at < FILES_CACHE_TTL_MS) return hit.files;
  const primary = new WorkspaceSourceRepository().getPrimary(workspaceId);
  const files = primary?.path ? listFilesUnder(primary.path).map((relPath) => ({ relPath })) : [];
  filesCache.set(workspaceId, { at: Date.now(), files });
  return files;
}

/**
 * Filtra os arquivos pela query do token `@…`: `includes` case-insensitive no
 * path inteiro (igual à GUI), com prefix-boost — paths cujo BASENAME começa com
 * a query vêm primeiro (quem digita `@repl` quer `Repl.tsx`, não um diretório
 * que contém "repl" no meio). Query vazia = primeiros `cap` arquivos. Para de
 * varrer cedo quando os prefix-matches já enchem o cap.
 */
export function filterFiles(
  files: readonly WorkspaceFile[],
  query: string,
  cap: number = FILE_MATCH_CAP,
): WorkspaceFile[] {
  const q = query.trim().toLowerCase();
  if (!q) return files.slice(0, cap);
  const prefix: WorkspaceFile[] = [];
  const contains: WorkspaceFile[] = [];
  for (const file of files) {
    const lower = file.relPath.toLowerCase();
    if (!lower.includes(q)) continue;
    const basename = lower.slice(lower.lastIndexOf('/') + 1);
    (basename.startsWith(q) ? prefix : contains).push(file);
    // Prefix vence sempre: com `cap` deles, nenhum contains entraria no corte.
    if (prefix.length >= cap) break;
  }
  return [...prefix, ...contains].slice(0, cap);
}

/**
 * Detecta um token `@…` ATIVO no cursor: o trecho do último whitespace (antes
 * do cursor) até o cursor precisa começar com `@` — sem espaço no meio, por
 * construção. `foo@bar` não ativa (o token é "foo@bar", não começa com `@`) —
 * e-mail/handle colado no texto não abre popup. Retorna a query (sem o `@`) e
 * o índice onde o token começa (pro aceite substituir o trecho certo).
 */
export function activeMentionToken(
  text: string,
  cursor: number,
): { query: string; start: number } | null {
  const before = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  let start = before.length;
  while (start > 0 && !/\s/.test(before[start - 1])) start--;
  const token = before.slice(start);
  if (!token.startsWith('@')) return null;
  return { query: token.slice(1), start };
}
