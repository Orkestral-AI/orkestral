// Maps a file path to a prism-react-renderer language id. Fallback 'tsx'.
const BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  cs: 'csharp',
  php: 'php',
  css: 'css',
  scss: 'scss',
  html: 'markup',
  xml: 'markup',
  json: 'json',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  bash: 'bash',
  sql: 'sql',
  graphql: 'graphql',
};
const BY_NAME: Record<string, string> = {
  dockerfile: 'docker',
  '.dockerignore': 'docker',
};

export function langFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  const byName = BY_NAME[base.toLowerCase()];
  if (byName) return byName;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return BY_EXT[ext] ?? 'tsx';
}
