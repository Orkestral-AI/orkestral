/**
 * Motor v2: contexto do repo pro planner (brownfield awareness).
 *
 * O planner sem contexto recria arquivos que ja existem (no run 1 ele recriou package.json
 * e tsconfig). Aqui montamos um resumo compacto do que JA EXISTE (arvore de arquivos +
 * deps), pra o premium planejar EM CIMA do que ha, nao do zero. Deterministico, testavel.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const IGNORE = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.turbo',
  'coverage',
  '.vercel',
]);

function walk(dir: string, base: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    if (IGNORE.has(e.name)) continue;
    const rel = path.join(base, e.name);
    if (e.isDirectory()) {
      walk(path.join(dir, e.name), rel, out, limit);
    } else {
      out.push(rel);
    }
  }
}

function pkgSummary(projectRoot: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort();
    const scripts = Object.keys(pkg.scripts ?? {});
    return `package.json: deps=[${deps.slice(0, 40).join(', ')}] scripts=[${scripts.join(', ')}]`;
  } catch {
    return null;
  }
}

/** Lista os arquivos do projeto (sem node_modules etc), relativos ao root. Pra ATERRA. */
export function listProjectFiles(projectRoot: string, max = 80): string[] {
  const out: string[] = [];
  walk(projectRoot, '', out, max);
  return out.sort();
}

/**
 * Resumo compacto do estado atual do repo: arvore de arquivos (sem node_modules etc) +
 * resumo do package.json. Vazio quando o repo nao tem nada (greenfield de verdade).
 */
export function gatherRepoContext(projectRoot: string, maxFiles = 80): string {
  const files: string[] = [];
  walk(projectRoot, '', files, maxFiles);
  const parts: string[] = [];
  const pkg = pkgSummary(projectRoot);
  if (pkg) parts.push(pkg);
  if (files.length > 0) {
    parts.push(
      `Arquivos que JA EXISTEM (nao recrie, edite se precisar):\n${files
        .sort()
        .map((f) => `  ${f}`)
        .join('\n')}`,
    );
  } else {
    parts.push('Repo vazio (greenfield): comece pela base.');
  }
  return parts.join('\n\n');
}
