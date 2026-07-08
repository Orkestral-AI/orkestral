/**
 * Serviço em segundo plano do Orkestral — `orkestral daemon install|uninstall|status`
 * e o passo final do `onboard`.
 *
 * macOS  → LaunchAgent do usuário (~/Library/LaunchAgents/com.orkestral.daemon.plist)
 * Linux  → systemd: root instala unit de sistema (VPS); usuário comum instala unit
 *          de usuário (~/.config/systemd/user) — com aviso sobre loginctl linger.
 * Windows→ não suportado ainda (usar `orkestral serve` num terminal).
 *
 * O ExecStart reusa o MESMO runtime desta execução (process.execPath + argv[1]):
 * instalação global npm roda `node …/bin/orkestral`, checkout dev roda
 * `electron …/out/main/cli.js` — os dois shapes funcionam sem detecção extra.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface DaemonOptions {
  host: string;
  port: number;
}

export interface DaemonResult {
  ok: boolean;
  message: string;
}

const MAC_LABEL = 'com.orkestral.daemon';
const LINUX_UNIT = 'orkestral.service';

function macPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
}

function linuxIsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function linuxUnitPath(): string {
  return linuxIsRoot()
    ? join('/etc/systemd/system', LINUX_UNIT)
    : join(homedir(), '.config', 'systemd', 'user', LINUX_UNIT);
}

function logsDir(): string {
  return join(homedir(), '.orkestral', 'logs');
}

/** Comando que relança este mesmo CLI: [execPath, entry] + args do serve.
 *  `resolve()` no entry é OBRIGATÓRIO: launchd/systemd executam com cwd `/`,
 *  e argv[1] pode ser relativo (ex.: `electron out/main/cli.js daemon install`). */
function serveCommand(opts: DaemonOptions): string[] {
  return [
    process.execPath,
    resolve(process.argv[1]),
    'serve',
    '--no-tui',
    '--host',
    opts.host,
    '--port',
    String(opts.port),
  ];
}

function run(cmd: string, args: string[]): { status: number; out: string } {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

function xmlEscape(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// ── macOS (launchd) ─────────────────────────────────────────────────────────

function macPlist(opts: DaemonOptions): string {
  const args = serveCommand(opts)
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');
  const log = join(logsDir(), 'daemon.log');
  // PATH explícito: LaunchAgents nascem com PATH mínimo e os agentes spawnam
  // git/claude/npx — inclui os prefixos usuais de macOS (Homebrew arm64 e Intel).
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

function macInstall(opts: DaemonOptions): DaemonResult {
  const plist = macPlistPath();
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
  writeFileSync(plist, macPlist(opts));
  const uid = process.getuid?.() ?? 501;
  // Recarrega se já existia (idempotente) — bootout falhar é ok (não estava carregado).
  run('launchctl', ['bootout', `gui/${uid}`, plist]);
  const boot = run('launchctl', ['bootstrap', `gui/${uid}`, plist]);
  if (boot.status !== 0) {
    // launchctl legado (macOS antigo) não tem bootstrap
    const legacy = run('launchctl', ['load', '-w', plist]);
    if (legacy.status !== 0) {
      return { ok: false, message: `launchctl falhou: ${boot.out || legacy.out}` };
    }
  }
  return { ok: true, message: `LaunchAgent instalado (${plist}) — sobe junto com o login.` };
}

function macUninstall(): DaemonResult {
  const plist = macPlistPath();
  if (!existsSync(plist)) return { ok: true, message: 'serviço não estava instalado.' };
  const uid = process.getuid?.() ?? 501;
  run('launchctl', ['bootout', `gui/${uid}`, plist]);
  rmSync(plist, { force: true });
  return { ok: true, message: 'LaunchAgent removido.' };
}

function macStatus(): DaemonResult {
  if (!existsSync(macPlistPath())) return { ok: false, message: 'não instalado.' };
  const uid = process.getuid?.() ?? 501;
  const res = run('launchctl', ['print', `gui/${uid}/${MAC_LABEL}`]);
  return res.status === 0
    ? { ok: true, message: 'instalado e carregado (launchd).' }
    : { ok: false, message: 'instalado mas NÃO carregado — rode `orkestral daemon install`.' };
}

// ── Linux (systemd) ─────────────────────────────────────────────────────────

function linuxUnit(opts: DaemonOptions): string {
  const exec = serveCommand(opts)
    .map((a) => (a.includes(' ') ? `"${a}"` : a))
    .join(' ');
  // EnvironmentFile do install.sh legado: aproveita se existir (secret key da VPS).
  const envFile = existsSync('/etc/orkestral/env') ? 'EnvironmentFile=/etc/orkestral/env\n' : '';
  const wantedBy = linuxIsRoot() ? 'multi-user.target' : 'default.target';
  return `[Unit]
Description=Orkestral daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${envFile}ExecStart=${exec}
Restart=always
RestartSec=5

[Install]
WantedBy=${wantedBy}
`;
}

function systemctl(args: string[]): { status: number; out: string } {
  return linuxIsRoot() ? run('systemctl', args) : run('systemctl', ['--user', ...args]);
}

function linuxInstall(opts: DaemonOptions): DaemonResult {
  const unitPath = linuxUnitPath();
  mkdirSync(join(unitPath, '..'), { recursive: true });
  writeFileSync(unitPath, linuxUnit(opts));
  const reload = systemctl(['daemon-reload']);
  if (reload.status !== 0) return { ok: false, message: `daemon-reload falhou: ${reload.out}` };
  const enable = systemctl(['enable', '--now', LINUX_UNIT]);
  if (enable.status !== 0) return { ok: false, message: `enable --now falhou: ${enable.out}` };
  const linger = linuxIsRoot() ? '' : ' Pra sobreviver ao logout: `loginctl enable-linger $USER`.';
  return { ok: true, message: `unit systemd instalada (${unitPath}) e iniciada.${linger}` };
}

function linuxUninstall(): DaemonResult {
  const unitPath = linuxUnitPath();
  if (!existsSync(unitPath)) return { ok: true, message: 'serviço não estava instalado.' };
  systemctl(['disable', '--now', LINUX_UNIT]);
  rmSync(unitPath, { force: true });
  systemctl(['daemon-reload']);
  return { ok: true, message: 'unit systemd removida.' };
}

function linuxStatus(): DaemonResult {
  if (!existsSync(linuxUnitPath())) return { ok: false, message: 'não instalado.' };
  const res = systemctl(['is-active', LINUX_UNIT]);
  return res.status === 0
    ? { ok: true, message: 'instalado e ativo (systemd).' }
    : { ok: false, message: `instalado mas inativo (${res.out || 'inactive'}).` };
}

// ── API ─────────────────────────────────────────────────────────────────────

export function installDaemon(opts: DaemonOptions): DaemonResult {
  if (process.platform === 'darwin') return macInstall(opts);
  if (process.platform === 'linux') return linuxInstall(opts);
  return {
    ok: false,
    message: 'serviço automático ainda não suportado no Windows — use `orkestral serve`.',
  };
}

export function uninstallDaemon(): DaemonResult {
  if (process.platform === 'darwin') return macUninstall();
  if (process.platform === 'linux') return linuxUninstall();
  return { ok: true, message: 'nada a remover nesta plataforma.' };
}

export function daemonStatus(): DaemonResult {
  if (process.platform === 'darwin') return macStatus();
  if (process.platform === 'linux') return linuxStatus();
  return { ok: false, message: 'não suportado nesta plataforma.' };
}
