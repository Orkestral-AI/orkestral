import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * Apps Electron abertos pelo Finder/Dock herdam um PATH mínimo
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) e NÃO enxergam CLIs instalados via npm
 * global, Homebrew, nvm, bun, etc. — por isso `spawn('claude')` falha com
 * ENOENT no app empacotado (em dev funciona porque herda o PATH do terminal).
 *
 * Esta função resolve o PATH do shell de LOGIN do usuário e o mescla em
 * `process.env.PATH`, somando também diretórios comuns de binários. No-op no
 * Windows. Deve rodar ANTES de qualquer spawn (logo no boot do main).
 */
export function fixPath(): void {
  if (platform() === 'win32') return;

  const home = homedir();
  const commonDirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    join(home, '.local/bin'),
    join(home, 'bin'),
    join(home, '.npm-global/bin'),
    join(home, '.yarn/bin'),
    join(home, '.bun/bin'),
    join(home, '.deno/bin'),
    join(home, '.volta/bin'),
    join(home, '.cargo/bin'),
  ];

  let shellPath = '';
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    // Login + interactive pra carregar ~/.zprofile, ~/.zshrc, nvm, etc.
    // Marcadores isolam o PATH de qualquer ruído que os rc files imprimam.
    const out = execFileSync(shell, ['-ilc', 'printf "__ORK_PATH__%s__ORK_END__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    shellPath = out.match(/__ORK_PATH__(.*)__ORK_END__/s)?.[1] ?? '';
  } catch {
    // Sem shell utilizável — segue só com os diretórios comuns.
  }

  const merged: string[] = [];
  const seen = new Set<string>();
  for (const p of [
    ...shellPath.split(':'),
    ...(process.env.PATH ?? '').split(':'),
    ...commonDirs,
  ]) {
    const dir = p.trim();
    if (!dir || seen.has(dir)) continue;
    // Mantém entradas do shell/PATH atual mesmo sem checar; pros comuns, só os que existem.
    seen.add(dir);
    merged.push(dir);
  }

  process.env.PATH = merged.filter((d) => existsSync(d)).join(':') || (process.env.PATH ?? '');
}
