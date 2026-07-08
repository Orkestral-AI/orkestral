// Resolve nome de arquivo/pasta -> URL do SVG do Material Icon Theme (PKief), o
// tema oficial atual. O mapeamento vem de `materialIconManifest.json` (subset do
// manifest gerado por scripts/gen-material-icon-manifest.mjs — rode após dar
// upgrade no pacote `material-icon-theme`). Os SVGs são expostos via glob do Vite
// (sem plugin de build); só os ícones realmente usados são requisitados em runtime.
import manifest from './materialIconManifest.json';

interface IconManifest {
  file: string;
  folder: string;
  folderExpanded: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
}
const m = manifest as IconManifest;

const ICON_URLS = import.meta.glob<string>(
  '../../../../node_modules/material-icon-theme/icons/*.svg',
  { eager: true, query: '?url', import: 'default' },
);

/** Mapa { 'typescript': '/assets/typescript.xxxx.svg', ... } (nome do ícone -> url). */
const urlByName: Record<string, string> = {};
for (const [path, url] of Object.entries(ICON_URLS)) {
  const name = path
    .split('/')
    .pop()!
    .replace(/\.svg$/, '');
  urlByName[name] = url;
}

function urlFor(iconName: string): string | null {
  return urlByName[iconName] ?? null;
}

/** Nome do ícone pra um arquivo: nome exato primeiro, depois a extensão mais
 *  longa (compostas como `test.tsx` têm prioridade), senão o ícone default. */
function iconNameForFile(name: string): string {
  const lower = name.toLowerCase();
  const byName = m.fileNames[lower];
  if (byName) return byName;
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.');
    const byExt = m.fileExtensions[ext];
    if (byExt) return byExt;
  }
  return m.file;
}

/** Nome do ícone pra uma pasta (variante expandida quando `open`). */
function iconNameForFolder(name: string, open: boolean): string {
  const lower = name.toLowerCase();
  const map = open ? m.folderNamesExpanded : m.folderNames;
  const byName = map[lower];
  if (byName) return byName;
  return open ? m.folderExpanded : m.folder;
}

/** URL do ícone Material pra um arquivo (por extensão/nome especial). */
export function getFileIconUrl(name: string): string | null {
  return urlFor(iconNameForFile(name)) ?? urlFor(m.file);
}

/** URL do ícone Material pra uma pasta. `open` usa a variante expandida. */
export function getFolderIconUrl(name: string, open = false): string | null {
  return urlFor(iconNameForFolder(name, open)) ?? urlFor(open ? m.folderExpanded : m.folder);
}
