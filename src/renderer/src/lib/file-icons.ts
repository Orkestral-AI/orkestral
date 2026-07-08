import {
  File,
  FileCode,
  FileJson,
  FileText,
  FileImage,
  FileType,
  FileCog,
  type LucideIcon,
} from 'lucide-react';

/**
 * Ícone (lucide) por extensão de arquivo — pro menu de `@` e os chips de
 * menção de arquivo no chat (paridade com o opencode, em versão enxuta).
 */
export function fileIconFor(path: string): LucideIcon {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (
    [
      'ts',
      'tsx',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'py',
      'go',
      'rs',
      'java',
      'rb',
      'php',
      'c',
      'cpp',
      'cs',
      'swift',
      'kt',
      'vue',
      'svelte',
      'sh',
    ].includes(ext)
  ) {
    return FileCode;
  }
  if (ext === 'json') return FileJson;
  if (['md', 'mdx', 'txt', 'rst'].includes(ext)) return FileText;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif'].includes(ext)) return FileImage;
  if (['css', 'scss', 'sass', 'less'].includes(ext)) return FileType;
  if (['yml', 'yaml', 'toml', 'env', 'ini', 'lock'].includes(ext)) return FileCog;
  return File;
}

/** Basename de um caminho (último segmento). */
export function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

/** Diretório (tudo menos o basename), com a barra final. Vazio se na raiz. */
export function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx + 1) : '';
}
