/**
 * Contexto TYPE-AWARE pra CRIAR arquivo novo: acha um arquivo EXISTENTE similar no
 * repo pra servir de TEMPLATE de estilo/estrutura. O modelo pequeno imita um exemplo
 * concreto (imports, convenções) em vez de inventar do zero — decisivo no create de
 * frontend (ex.: novo `*Context.tsx` olhando outro `*Context.tsx`). Determinístico;
 * só lê arquivo de verdade. Mesma filosofia de region.ts/morph.ts.
 */
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';

/** Última "palavra" CamelCase de um identificador (CallContext → "Context"). */
export function camelSuffix(name: string): string {
  const m = name.match(/[A-Z][a-z0-9]*$/);
  return m ? m[0] : '';
}

/**
 * Acha um arquivo EXISTENTE similar pra usar como TEMPLATE ao criar `filePath`:
 * mesma extensão, preferindo o MESMO diretório e o mesmo sufixo CamelCase do nome
 * (CallContext→AuthContext, SoftPhoneWidget→OtherWidget). Devolve o conteúdo (capado
 * em `maxChars`), ou null se não houver candidato.
 */
export function findCreateTemplate(
  repoPath: string,
  filePath: string,
  maxChars: number,
): string | null {
  const ext = extname(filePath);
  if (!ext) return null;
  const dir = dirname(filePath);
  const baseName = basename(filePath, ext);
  const targetSuffix = camelSuffix(baseName);
  const dirs = [dir];
  const parent = dirname(dir);
  if (parent && parent !== dir && parent !== '.') dirs.push(parent);

  let best: { path: string; score: number } | null = null;
  for (const d of dirs) {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(repoPath, d), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || extname(e.name) !== ext) continue;
      const eBase = basename(e.name, ext);
      if (eBase === baseName) continue;
      let score = d === dir ? 2 : 0;
      if (targetSuffix && camelSuffix(eBase) === targetSuffix) score += 3;
      // Empate → mantém o 1º (estável); só troca por score ESTRITAMENTE maior.
      if (!best || score > best.score) best = { path: join(d, e.name), score };
    }
  }
  if (!best) return null;
  try {
    const content = readFileSync(join(repoPath, best.path), 'utf-8');
    return content.length > maxChars ? content.slice(0, maxChars) : content;
  } catch {
    return null;
  }
}
