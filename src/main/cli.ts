import { app } from './platform/electron';
import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { bootstrapServices } from './bootstrap';
import { resumeInterruptedWork } from './services/issue-execution-service';
import { appInfo } from './platform/host';
import { resolveActiveWorkspaceId } from './cli/active-workspace';
import { collectStatus } from './cli/status';
import { feedTime, formatFeedEvent } from './cli/feed-format';
import { chatStreamBus } from './services/chat-service';
import type { ChatStreamEvent } from '../shared/types';
import { Cockpit } from './cli/ui/Cockpit';
import { InitWizard } from './cli/ui/InitWizard';
import { Repl } from './cli/ui/Repl';
import { runPrintMode } from './cli/print-mode';
import { PERMISSION_MODE_VALUES, isPermissionMode, setPermissionMode } from './cli/permission';
import { SettingsRepository } from './db/repositories/settings.repo';
import { WorkspaceRepository } from './db/repositories/workspace.repo';
import { startWebGateway, gatewayUrl } from './services/web-gateway';
import { GATEWAY_DEFAULT_PORT } from '../shared/gateway';
import { installDaemon, uninstallDaemon, daemonStatus } from './cli/daemon';
import { runDoctor, printDoctorReport } from './cli/doctor';
import { runUninstall } from './cli/uninstall';
import readline from 'node:readline';

// Tudo aqui é condicional: em Node puro (npm i -g, sem Electron) `app` é
// undefined e não há Chromium nem userData do Electron pra configurar.
if (app) {
  // Headless/container: o CLI nunca renderiza janela; desliga GPU/sandbox/shm pra o
  // Chromium do Electron subir sem travar em init de GPU/dbus/X num servidor sem tela.
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disable-dev-shm-usage');

  // userData DETERMINÍSTICO: rodando `electron out/main/cli.js` (não empacotado), o
  // app.getName() do Electron poderia resolver 'orkestral' (minúsculo, do package.json
  // name) em vez de 'Orkestral' (productName do build). Isso mudaria o dir de userData
  // (~/.config/Orkestral), quebrando o secret.key/auth do WhatsApp entre o app
  // empacotado, o CLI e o volume do Docker. Fixamos pra casar com o app empacotado.
  // Em Node puro não há `app` nenhum: appInfo.path (host.ts) cai no fallback
  // determinístico ~/.orkestral, então o setName nem se aplica.
  app.setName('Orkestral');
}

/** Sob Electron, espera o app ficar pronto e esconde o ícone do Dock (macOS);
 *  em Node puro é no-op — não existe ciclo de vida do Electron pra esperar. */
async function whenRuntimeReady(): Promise<void> {
  if (!app) return;
  await app.whenReady();
  app.dock?.hide?.();
}

const program = new Command();
program.name('orkestral').description('Orkestral CLI (headless)').version(appInfo.version());

program
  .option('--permission-mode <m>', 'default|acceptEdits|plan|dangerously-skip')
  .option('--dangerously-skip-permissions', 'modo full-auto (atalho)')
  .option('--new', 'começa uma sessão nova (não retoma a última)')
  .option('--resume', 'abre o REPL já no picker de sessões recentes')
  .option('-p, --print [prompt]', 'modo print: responde e sai (sem valor ou "-" lê o stdin)')
  .option('--continue', 'com -p: retoma a última sessão em vez de abrir uma nova');

// Aplica o modo de permissão ANTES de qualquer comando (serve/status/init/default).
// Vale só pra CLI; a GUI nunca passa por aqui, então fica em `default` (no-op).
// `--permission-mode` inválido é ERRO (exit 1) — nunca um cast silencioso que
// viraria `default` mudo em cima de um typo de `dangerously-skip`.
program.hook('preAction', () => {
  const o = program.opts<{ dangerouslySkipPermissions?: boolean; permissionMode?: string }>();
  if (o.dangerouslySkipPermissions) {
    setPermissionMode('dangerously-skip');
    return;
  }
  if (o.permissionMode) {
    if (!isPermissionMode(o.permissionMode)) {
      console.error(
        `[orkestral] --permission-mode inválido: "${o.permissionMode}". ` +
          `Modos válidos: ${PERMISSION_MODE_VALUES.join(' | ')}.`,
      );
      process.exit(1);
    }
    setPermissionMode(o.permissionMode);
  }
});

/**
 * Carrega o modo de permissão PERSISTIDO (escolhido via `/permissions`/Shift+Tab
 * no REPL) — flags da CLI vencem a persistência (já aplicadas no preAction).
 * Chamado no boot do REPL e do serve, DEPOIS do bootstrapServices (DB pronto).
 * Valor persistido corrompido/desconhecido é ignorado (fica no default).
 */
function loadPersistedPermissionMode(): void {
  const o = program.opts<{ dangerouslySkipPermissions?: boolean; permissionMode?: string }>();
  if (o.dangerouslySkipPermissions || o.permissionMode) return;
  const stored = new SettingsRepository().getDaemonPermissionMode();
  if (stored && isPermissionMode(stored)) setPermissionMode(stored);
}

program.action(async () => {
  await whenRuntimeReady();
  bootstrapServices({ headless: true });
  // Modo print (`-p`) vem ANTES do check de TTY: ele existe justamente pra
  // scripts/pipes (sem TTY nenhum). `runPrintMode` nunca retorna — sai 0/1/2.
  const opts = program.opts<{ print?: string | boolean; continue?: boolean }>();
  if (opts.print !== undefined) {
    loadPersistedPermissionMode();
    await runPrintMode({ promptArg: opts.print, continueSession: !!opts.continue });
    return;
  }
  if (!process.stdout.isTTY) {
    console.error('orkestral (REPL) precisa de TTY. Pra headless use `orkestral serve`.');
    process.exit(1);
  }
  loadPersistedPermissionMode();
  // Título do terminal: `orkestral · <workspace>` via OSC 0, UMA vez antes do
  // Ink montar (estamos garantidamente num TTY aqui). Sem restore no exit — o
  // shell/terminal repõe o título dele sozinho quando o processo fecha.
  const activeWorkspaceId = resolveActiveWorkspaceId();
  const workspaceName = activeWorkspaceId
    ? new WorkspaceRepository().listAll().find((w) => w.id === activeWorkspaceId)?.name
    : undefined;
  process.stdout.write(`\x1b]0;orkestral${workspaceName ? ` · ${workspaceName}` : ''}\x07`);
  // exitOnCtrlC desligado: o Repl trata Ctrl+C — CANCELA o run quando há um
  // streaming, e só SAI quando ocioso (handler próprio, sempre ativo).
  // `--resume` boota normal e abre o picker de sessões por cima (Esc fecha e
  // fica na sessão do boot de sempre).
  const replOpts = program.opts<{ new?: boolean; resume?: boolean }>();
  render(
    React.createElement(Repl, {
      forceNewSession: !!replOpts.new,
      initialResumePicker: !!replOpts.resume,
    }),
    { exitOnCtrlC: false },
  );
});

program
  .command('init')
  .description('setup no terminal (workspace, agente, canal)')
  .action(async () => {
    await whenRuntimeReady();
    bootstrapServices({ headless: true });
    render(React.createElement(InitWizard));
  });

/** Pergunta sim/não no terminal (fora do Ink). Enter = default. */
async function askYesNo(question: string, def: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) =>
    rl.question(`${question} ${def ? '(S/n)' : '(s/N)'} `, resolve),
  );
  rl.close();
  const a = answer.trim().toLowerCase();
  if (!a) return def;
  return a.startsWith('s') || a.startsWith('y');
}

program
  .command('onboard')
  .description('instalação em 2 passos: wizard + serviço em segundo plano + URL da UI web')
  .option('--host <host>', 'bind do gateway web (0.0.0.0 expõe na rede)', '127.0.0.1')
  .option('--port <port>', 'porta do gateway web', String(GATEWAY_DEFAULT_PORT))
  .option('--daemon', 'instala o serviço sem perguntar')
  .option('--no-daemon', 'só o wizard, sem serviço')
  .action(async (opts: { host: string; port: string; daemon?: boolean }) => {
    await whenRuntimeReady();
    bootstrapServices({ headless: true });
    if (!process.stdout.isTTY) {
      console.error('orkestral onboard precisa de TTY (wizard interativo).');
      process.exit(1);
    }
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`[orkestral] --port inválida: "${opts.port}".`);
      process.exit(1);
    }

    // Checagem de ambiente ANTES do wizard: sem Node 22 / CLI de agente / auth
    // o chat cai mudo depois. Avisa cedo (não bloqueia — o usuário pode instalar
    // o agente depois), mas deixa explícito o que falta.
    printDoctorReport(await runDoctor());

    // 1/2 — wizard existente (workspace, agente, canal). waitUntilExit espera o
    // usuário concluir; o wizard cuida do próprio ciclo de telas.
    const wizard = render(React.createElement(InitWizard), { exitOnCtrlC: true });
    await wizard.waitUntilExit();

    // 2/2 — serviço em segundo plano + URL. `--daemon`/`--no-daemon` pulam a
    // pergunta (opts.daemon fica undefined quando nenhuma das flags veio).
    const wantDaemon =
      opts.daemon ??
      (await askYesNo('Rodar o Orkestral em segundo plano (inicia no login)?', true));

    const url = gatewayUrl(opts.host, port);
    if (wantDaemon) {
      const result = installDaemon({ host: opts.host, port });
      if (!result.ok) {
        console.error(`[orkestral] serviço falhou: ${result.message}`);
        console.error('[orkestral] alternativa: rode `orkestral serve` num terminal.');
        process.exit(1);
      }
      console.log(`[orkestral] ${result.message}`);
      console.log(`[orkestral] UI web: ${url}`);
      console.log('[orkestral] Pronto. O daemon já está rodando — abra a URL no navegador.');
    } else {
      console.log('[orkestral] Sem serviço. Pra subir manualmente: orkestral serve');
      console.log(`[orkestral] Quando o serve estiver rodando, a UI fica em: ${url}`);
    }
    process.exit(0);
  });

const daemonCmd = program
  .command('daemon')
  .description('gerencia o serviço em segundo plano (launchd/systemd)');
daemonCmd
  .command('install')
  .description('instala e inicia o serviço')
  .option('--host <host>', 'bind do gateway web', '127.0.0.1')
  .option('--port <port>', 'porta do gateway web', String(GATEWAY_DEFAULT_PORT))
  .action(async (opts: { host: string; port: string }) => {
    await whenRuntimeReady();
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`[orkestral] --port inválida: "${opts.port}".`);
      process.exit(1);
    }
    const result = installDaemon({ host: opts.host, port });
    console.log(`[orkestral] ${result.message}`);
    if (result.ok) console.log(`[orkestral] UI web: ${gatewayUrl(opts.host, port)}`);
    process.exit(result.ok ? 0 : 1);
  });
daemonCmd
  .command('uninstall')
  .description('para e remove o serviço')
  .action(async () => {
    await whenRuntimeReady();
    const result = uninstallDaemon();
    console.log(`[orkestral] ${result.message}`);
    process.exit(result.ok ? 0 : 1);
  });
daemonCmd
  .command('status')
  .description('mostra o estado do serviço')
  .action(async () => {
    await whenRuntimeReady();
    const result = daemonStatus();
    console.log(`[orkestral] ${result.message}`);
    process.exit(result.ok ? 0 : 1);
  });

program
  .command('doctor')
  .description('checa pré-requisitos (Node, CLI de agente, credenciais)')
  .action(async () => {
    const ok = printDoctorReport(await runDoctor());
    process.exit(ok ? 0 : 1);
  });

program
  .command('uninstall')
  .description('remove o Orkestral por completo (serviço + dados)')
  .option('--yes', 'não pergunta — assume confirmado (scripts/CI)')
  .option('--keep-data', 'mantém ~/.orkestral (só remove o serviço)')
  .action(async (opts: { yes?: boolean; keepData?: boolean }) => {
    await whenRuntimeReady();
    console.log('Isto vai remover o Orkestral desta máquina:');
    console.log('  • para e apaga o serviço em segundo plano (launchd/systemd)');
    if (opts.keepData) {
      console.log('  • MANTÉM seus dados em ~/.orkestral (--keep-data)');
    } else {
      console.log(
        '  • APAGA ~/.orkestral — banco, tokens, workspaces, logs, modelos (IRREVERSÍVEL)',
      );
    }
    // Confirmação explícita pra ação destrutiva: exige digitar "orkestral"
    // (mais forte que y/N — evita apagar tudo por engano). --yes pula (scripts).
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        console.error('\norkestral uninstall precisa de confirmação — rode com --yes em scripts.');
        process.exit(1);
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const typed = await new Promise<string>((resolve) =>
        rl.question('\nDigite "orkestral" para confirmar (ou Enter pra cancelar): ', resolve),
      );
      rl.close();
      if (typed.trim().toLowerCase() !== 'orkestral') {
        console.log('Cancelado — nada foi removido.');
        process.exit(0);
      }
    }

    const result = runUninstall({ keepData: !!opts.keepData });
    const icon = { done: '✓', skipped: '-', error: '✗' } as const;
    console.log('');
    for (const step of result.steps) {
      console.log(`  ${icon[step.status]} ${step.label} — ${step.detail}`);
    }
    const hadError = result.steps.some((s) => s.status === 'error');
    console.log(
      `\nPra terminar de remover o pacote global, rode:\n  ${result.finalHint}\n` +
        '(um processo npm não consegue se auto-desinstalar enquanto está rodando)',
    );
    process.exit(hadError ? 1 : 0);
  });

program
  .command('serve')
  .description('sobe o Orkestral headless + cockpit + UI web')
  .option('--no-tui', 'sem painel (loga linhas; pra systemd/sem TTY)')
  .option('--no-web', 'não sobe o gateway web (só daemon/canais)')
  .option('--host <host>', 'bind do gateway web (0.0.0.0 expõe na rede)', '127.0.0.1')
  .option('--port <port>', 'porta do gateway web', String(GATEWAY_DEFAULT_PORT))
  .action(async (opts: { tui: boolean; web: boolean; host: string; port: string }) => {
    await whenRuntimeReady();
    bootstrapServices({ headless: true });
    loadPersistedPermissionMode();
    // Gateway web ANTES do Ink montar: erro de porta sai legível no stdout
    // normal, não escondido pelo alternate screen do cockpit.
    if (opts.web) {
      const port = Number.parseInt(opts.port, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`[orkestral] --port inválida: "${opts.port}".`);
        process.exit(1);
      }
      try {
        const gateway = await startWebGateway({ host: opts.host, port });
        console.log(`[orkestral] UI web: ${gateway.url}`);
        if (opts.host !== '127.0.0.1') {
          console.log(
            `[orkestral] gateway exposto em ${opts.host}:${port} — acesso exige o token da URL acima.`,
          );
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          console.error(
            `[orkestral] porta ${port} já em uso — outro serve rodando? Use --port <outra>.`,
          );
        } else {
          console.error('[orkestral] gateway web falhou ao subir:', err);
        }
        process.exit(1);
      }
    }
    // Daemon boot: retoma o trabalho que ficou parado quando o processo caiu
    // (planos ativos + issues `todo`). Só no `serve` — status/init/REPL não
    // existem pra tocar trabalho de fundo.
    try {
      resumeInterruptedWork();
    } catch (err) {
      console.warn('[orkestral] resume do trabalho interrompido falhou:', err);
    }
    const wsId = resolveActiveWorkspaceId();
    if (opts.tui && process.stdout.isTTY) {
      render(React.createElement(Cockpit, { workspaceId: wsId }));
    } else {
      // Sem TUI (systemd/log): loga o MESMO feed do cockpit — status no boot +
      // uma linha por evento relevante do bus (run/tool/canal), com HH:MM.
      const s = collectStatus(wsId);
      const channels = s.channels.map((c) => `${c.type}=${c.status}`).join(' ') || 'nenhum';
      console.log(
        `[orkestral] serve headless (sem TUI) · v${s.version} · ` +
          `workspace=${s.workspace?.name ?? '—'} · agente=${s.agent?.name ?? '—'} · ` +
          `canais: ${channels}`,
      );
      console.log('[orkestral] Ctrl+C pra sair.');
      chatStreamBus.on('event', (e: ChatStreamEvent) => {
        const text = formatFeedEvent(e);
        if (text) console.log(`${feedTime(Date.now())} ${text}`);
      });
      setInterval(() => {}, 1 << 30);
    }
  });

program
  .command('status')
  .description('imprime status e sai (healthcheck)')
  .option('--require-channel', 'healthcheck estrito: exit 1 se nenhum canal conectado')
  .action(async (opts: { requireChannel?: boolean }) => {
    await whenRuntimeReady();
    bootstrapServices({ headless: true });
    const s = collectStatus(resolveActiveWorkspaceId());
    console.log(JSON.stringify(s, null, 2));
    // Exit 0 = DB abriu + workspace resolvido. Canal desconectado NÃO é doença
    // do daemon (instalação nova ainda sem canal é saudável) — só derruba o
    // exit code com `--require-channel` (semântica de healthcheck do systemd).
    const baseOk = s.workspace !== null;
    const channelOk = s.channels.some((c) => c.status === 'connected');
    process.exit(baseOk && (!opts.requireChannel || channelOk) ? 0 : 1);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error('[orkestral] erro:', err);
  process.exit(1);
});
