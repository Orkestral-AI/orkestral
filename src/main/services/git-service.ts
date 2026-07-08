/**
 * Wrapper do CLI `git` pra operações de versionamento no source ativo.
 *
 * Por que execFile e não simple-git: o usuário já tem `git` no PATH (senão
 * o clone do GitHub não rodaria). Evita dependência extra e funciona
 * idêntico em macOS/Linux/Windows.
 *
 * Todas as funções recebem o `repoPath` (caminho do source) — nunca o
 * sourceId. Resolução de sourceId → path fica nos handlers IPC.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 32 * 1024 * 1024; // 32MB — suficiente pra diffs grandes
const COMMAND_TIMEOUT = 30_000;

export interface GitFileChange {
  /** Caminho relativo ao repo. */
  path: string;
  /** Status no staging area (X) — pega do `git status --porcelain`. */
  indexStatus: ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!';
  /** Status no working tree (Y). */
  workingStatus: ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!';
  /** True se há mudança staged (X != ' '). */
  staged: boolean;
  /** True se há mudança no working tree (Y != ' '). */
  unstaged: boolean;
  /** Path original em casos de rename (R) ou copy (C). */
  oldPath?: string;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  lastCommit?: { sha: string; subject: string; relativeDate: string };
}

function assertPath(repoPath: string): void {
  if (!repoPath || !existsSync(repoPath)) {
    throw new Error(`Path do source não existe: ${repoPath}`);
  }
}

/**
 * Valida um nome de branch/ref vindo do IPC antes de passar pro `git`. Como o
 * valor é posicional, um nome iniciado com `-` (ex: `--orphan`, `-D`) seria
 * interpretado pelo git como flag em vez de ref (argument/option injection).
 * Rejeita também chars de controle. Não é shell-injection (usamos execFile),
 * mas fecha a brecha de opção. Retorna o próprio valor pra encadear.
 */
function assertRef(ref: string, label = 'ref'): string {
  // eslint-disable-next-line no-control-regex -- intencional: barra chars de controle no ref
  if (!ref || ref.startsWith('-') || /[\x00-\x1f\x7f]/.test(ref)) {
    throw new Error(`Nome de ${label} inválido: ${JSON.stringify(ref)}`);
  }
  return ref;
}

/**
 * Auth EFÊMERA pra operações de rede (push/pull/fetch) de repo privado HTTPS.
 * Injeta `http.extraHeader=<token>` via os env vars `GIT_CONFIG_*` em vez de
 * `-c ...` no argv: o token sai da lista de argumentos do processo (visível por
 * `ps`/`/proc` a outros usuários da máquina) e fica no ambiente do filho, que é
 * efêmero e não é gravado no `.git/config`. Vazio quando não há auth (repo
 * público / SSH / Azure).
 */
function authEnv(authHeader?: string): NodeJS.ProcessEnv {
  if (!authHeader) return {};
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: authHeader,
  };
}

async function git(repoPath: string, ...args: string[]): Promise<string> {
  return gitEnv(repoPath, {}, args);
}

/**
 * Igual ao `git()`, mas com env vars extras (ex: auth via `GIT_CONFIG_*`).
 * Usado pelas operações de rede que precisam do header de auth efêmero sem
 * expor o token no argv.
 */
async function gitEnv(
  repoPath: string,
  extraEnv: NodeJS.ProcessEnv,
  args: string[],
): Promise<string> {
  assertPath(repoPath);
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      maxBuffer: MAX_BUFFER,
      timeout: COMMAND_TIMEOUT,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `git ${args.join(' ')} falhou: ${(e.stderr ?? '').trim() || e.message || 'sem mensagem'}`,
    );
  }
}

async function gitWithInput(repoPath: string, args: string[], input: string): Promise<void> {
  assertPath(repoPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`git ${args.join(' ')} excedeu timeout`));
    }, COMMAND_TIMEOUT);
    // Drena o stdout mesmo sem usá-lo: um apply verboso (undo de mudança grande)
    // enche o pipe não-lido e trava o filho até o timeout/SIGTERM, reportando
    // falha mesmo quando o git teria sucesso. Consumir evita o deadlock.
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `git ${args.join(' ')} falhou: ${stderr.trim() || `exit code ${code ?? 'unknown'}`}`,
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}

/**
 * Variante do `git()` que tolera exit code 1 e devolve o stdout mesmo assim.
 * Necessária pro `git diff --no-index`, que sai com código 1 (não-erro) quando
 * os arquivos diferem — o diff vai pro stdout. Sem isso, o diff de arquivos
 * novos/untracked era perdido e virava "Command failed".
 */
async function gitAllowExit1(repoPath: string, ...args: string[]): Promise<string> {
  assertPath(repoPath);
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      maxBuffer: MAX_BUFFER,
      timeout: COMMAND_TIMEOUT,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    // exit 1 com stdout presente = diferença detectada (caso normal do --no-index)
    if (e.code === 1 && typeof e.stdout === 'string') {
      return e.stdout;
    }
    throw new Error(
      `git ${args.join(' ')} falhou: ${(e.stderr ?? '').trim() || e.message || 'sem mensagem'}`,
    );
  }
}

/**
 * URL do remote `origin` de um checkout local (ou null se não houver). Usado pra
 * reconhecer que uma pasta local já é um repo git com remote e "apontar pro repo
 * existente" ao adicionar a source.
 */
/**
 * Inicializa um repo git numa pasta local que ainda não é git (botão "Criar
 * repositório" da aba Git). Cria branch `main` por default e um `.gitignore`
 * básico se não existir, pra a primeira tela de changes não vir com lixo.
 */
export async function gitInit(repoPath: string): Promise<void> {
  await git(repoPath, 'init', '-b', 'main');
}

export async function gitRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const out = await git(repoPath, 'config', '--get', 'remote.origin.url');
    return out.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const EMPTY_STATUS: GitStatus = {
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
};

export async function gitStatus(repoPath: string): Promise<GitStatus> {
  // -b: head + ahead/behind no header. --porcelain=v1 -z: parse seguro.
  // -uall: lista CADA arquivo untracked individualmente (não colapsa pastas
  // novas numa única entrada "dir/"), então cada arquivo novo aparece como
  // sua própria mudança e ganha diff de conteúdo no painel.
  try {
    const raw = await git(repoPath, 'status', '--porcelain=v1', '-b', '-z', '-uall');
    return parseStatus(raw);
  } catch (err) {
    // Pasta que NÃO é repo git (source de pasta simples, ou greenfield ainda sem
    // `git init`): devolve status vazio em vez de lançar. Quem distingue "é repo?"
    // usa o handler `git:is-repo`. Sem isto, o poll do painel Git cuspia a stack
    // inteira a cada ciclo ("not a git repository"). Erros REAIS (git ausente,
    // timeout, corrupção) continuam propagando.
    if (/not a git repository/i.test((err as Error).message)) {
      return EMPTY_STATUS;
    }
    throw err;
  }
}

function parseStatus(raw: string): GitStatus {
  const entries = raw.split('\0').filter(Boolean);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileChange[] = [];

  for (let i = 0; i < entries.length; i++) {
    const line = entries[i];
    if (line.startsWith('## ')) {
      // ## main...origin/main [ahead 1, behind 2]
      const header = line.slice(3);
      const noBracket = header.replace(/\s*\[(.+)\]\s*$/, (_m, info: string) => {
        const a = /ahead (\d+)/.exec(info);
        const b = /behind (\d+)/.exec(info);
        if (a) ahead = parseInt(a[1], 10);
        if (b) behind = parseInt(b[1], 10);
        return '';
      });
      if (noBracket.includes('...')) {
        const [b, up] = noBracket.split('...');
        branch = b.trim();
        upstream = up.trim();
      } else if (noBracket.startsWith('No commits yet on ')) {
        branch = noBracket.slice('No commits yet on '.length).trim();
      } else {
        branch = noBracket.trim();
      }
      continue;
    }
    // Linha "XY path" — chars 0/1 são status, depois espaço, depois path
    const indexStatus = (line[0] ?? ' ') as GitFileChange['indexStatus'];
    const workingStatus = (line[1] ?? ' ') as GitFileChange['workingStatus'];
    let path = line.slice(3);
    let oldPath: string | undefined;
    // Rename/copy ocupa duas entradas: "R  newpath" + "\0oldpath"
    if (indexStatus === 'R' || indexStatus === 'C') {
      oldPath = entries[i + 1];
      i++;
    }
    files.push({
      path,
      indexStatus,
      workingStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
      unstaged: workingStatus !== ' ' || indexStatus === '?',
      oldPath,
    });
  }

  return { branch, upstream, ahead, behind, files };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export async function gitDiff(
  repoPath: string,
  filePath: string,
  staged: boolean,
): Promise<string> {
  // --no-color pra renderer interpretar; -U6 pra dar bom contexto visual.
  // `--` separa flags de paths.
  if (staged) {
    return git(repoPath, 'diff', '--cached', '--no-color', '-U6', '--', filePath);
  }
  // Untracked: git diff não mostra. Faz diff contra /dev/null.
  const status = await gitStatus(repoPath);
  const entry = status.files.find((f) => f.path === filePath);
  if (entry?.indexStatus === '?' && entry.workingStatus === '?') {
    // Diretório untracked: com `-uall` o git status lista cada arquivo novo
    // individualmente, então normalmente caímos no ramo de arquivo abaixo. Um
    // path terminando em '/' só sobra pra um diretório de fato VAZIO — nesse
    // caso tenta concatenar o diff dos arquivos dentro; se não houver nenhum,
    // mostra a mensagem de pasta vazia como guarda.
    if (filePath.endsWith('/')) {
      try {
        const { readdir, stat } = await import('node:fs/promises');
        const absDir = join(repoPath, filePath);
        const dirEntries = (await readdir(absDir, { recursive: true })) as string[];
        const parts: string[] = [];
        for (const f of dirEntries) {
          const childAbs = join(absDir, f);
          try {
            if (!(await stat(childAbs)).isFile()) continue;
            const childDiff = await gitDiff(repoPath, join(filePath, f), false);
            if (childDiff && childDiff.trim()) parts.push(childDiff);
          } catch {
            // ignora arquivos ilegíveis
          }
        }
        if (parts.length > 0) return parts.join('\n');
      } catch {
        // ignora — cai na mensagem de pasta vazia
      }
      return `Pasta nova sem arquivos trackeados: ${filePath}`;
    }
    // arquivo untracked — mostra como add bruto. `git diff --no-index` sai com
    // exit 1 quando há diferença (caso normal aqui) e joga o diff no stdout, então
    // usamos gitAllowExit1 pra ler esse stdout em vez de tratar como erro.
    const out = await gitAllowExit1(
      repoPath,
      'diff',
      '--no-color',
      '-U6',
      '--no-index',
      '--',
      '/dev/null',
      filePath,
    );
    if (out && out.trim()) return out;
    // Fallback: se o --no-index não devolveu nada (arquivo vazio, binário, ou
    // edge case de exit 1 sem stdout), sintetiza um diff de adições lendo o
    // arquivo direto. Garante que o painel nunca mostre "Command failed".
    try {
      const content = await readFile(join(repoPath, filePath), 'utf8');
      const lines = content.length ? content.replace(/\n$/, '').split('\n') : [];
      const body = lines.map((l) => `+${l}`).join('\n');
      return `diff --git a/${filePath} b/${filePath}\nnew file\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
    } catch {
      return out;
    }
  }
  return git(repoPath, 'diff', '--no-color', '-U6', '--', filePath);
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export async function gitBranches(repoPath: string): Promise<GitBranch[]> {
  // for-each-ref dá tudo num go: nome, é HEAD?, upstream, último commit
  const fmt = [
    '%(refname:short)',
    '%(HEAD)',
    '%(upstream:short)',
    '%(objectname:short)',
    '%(subject)',
    '%(committerdate:relative)',
  ].join('\x01');
  const raw = await git(repoPath, 'for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream, sha, subject, date] = line.split('\x01');
      const remote = name.includes('/') && !name.startsWith('refs/heads');
      return {
        name,
        current: head === '*',
        remote,
        upstream: upstream || undefined,
        lastCommit: sha && subject ? { sha, subject, relativeDate: date ?? '' } : undefined,
      } as GitBranch;
    })
    .filter((b) => !b.name.startsWith('origin/HEAD'));
}

export async function gitCurrentBranch(repoPath: string): Promise<string> {
  const out = await git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  return out.trim();
}

export async function gitHeadSha(repoPath: string): Promise<string> {
  const out = await git(repoPath, 'rev-parse', 'HEAD');
  return out.trim();
}

export async function gitUpstreamSha(repoPath: string): Promise<string | null> {
  try {
    const out = await git(repoPath, 'rev-parse', '@{u}');
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Diff do que HEAD adiciona sobre o merge-base com `base` (estilo PR:
 * `git diff base...HEAD`). `base` pode ser local ("dev") ou remoto
 * ("origin/dev"). Retorna '' em qualquer erro (ref inexistente etc.).
 */
export async function gitRangeDiff(repoPath: string, base: string, head = 'HEAD'): Promise<string> {
  try {
    assertRef(base, 'base');
    assertRef(head, 'head');
    return await git(repoPath, 'diff', '--no-color', `${base}...${head}`);
  } catch {
    return '';
  }
}

export async function gitCheckoutBranch(repoPath: string, branch: string): Promise<void> {
  assertRef(branch, 'branch');
  // `--` final garante que o branch validado seja tratado como ref, nunca pathspec/flag.
  await git(repoPath, 'checkout', branch, '--');
}

export async function gitCreateBranch(
  repoPath: string,
  name: string,
  fromBranch?: string,
): Promise<void> {
  assertRef(name, 'branch');
  if (fromBranch) {
    assertRef(fromBranch, 'branch');
    await git(repoPath, 'checkout', '-b', name, fromBranch, '--');
  } else {
    await git(repoPath, 'checkout', '-b', name, '--');
  }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export async function gitStage(repoPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await git(repoPath, 'add', '--', ...files);
}

export async function gitUnstage(repoPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await git(repoPath, 'restore', '--staged', '--', ...files);
}

// ---------------------------------------------------------------------------
// Commit + push
// ---------------------------------------------------------------------------

export async function gitCommit(
  repoPath: string,
  message: string,
  files?: string[],
): Promise<{ sha: string }> {
  if (files && files.length > 0) {
    await gitStage(repoPath, files);
  }
  await git(repoPath, 'commit', '-m', message);
  const sha = (await git(repoPath, 'rev-parse', 'HEAD')).trim();
  return { sha };
}

export async function gitPush(
  repoPath: string,
  branch?: string,
  setUpstream = true,
  authHeader?: string,
): Promise<void> {
  const args: string[] = ['push'];
  if (setUpstream) args.push('-u');
  args.push('origin');
  args.push(assertRef(branch ?? (await gitCurrentBranch(repoPath)), 'branch'));
  try {
    await gitEnv(repoPath, authEnv(authHeader), args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/rejected/i.test(msg) && /fetch first|non-fast-forward/i.test(msg)) {
      throw new Error(
        'Remote tem commits que você ainda não puxou. Faça Pull primeiro pra integrar e tente push de novo.',
      );
    }
    if (/Everything up-to-date/i.test(msg)) {
      throw new Error('Nada pra enviar — branch já está sincronizada com origin.');
    }
    if (/Authentication failed|could not read Username/i.test(msg)) {
      throw new Error(
        'Falha de autenticação no GitHub. Configure suas credenciais (gh auth login / SSH key) e tente novamente.',
      );
    }
    throw err;
  }
}

export async function gitFetch(repoPath: string, authHeader?: string): Promise<void> {
  await gitEnv(repoPath, authEnv(authHeader), ['fetch', '--prune', 'origin']);
}

export async function gitPull(
  repoPath: string,
  opts: { rebase?: boolean; branch?: string; authHeader?: string } = {},
): Promise<{ summary: string }> {
  const args = ['pull'];
  if (opts.rebase) args.push('--rebase');
  args.push(
    '--no-edit',
    'origin',
    assertRef(opts.branch ?? (await gitCurrentBranch(repoPath)), 'branch'),
  );
  try {
    const out = await gitEnv(repoPath, authEnv(opts.authHeader), args);
    return { summary: out.trim().split('\n').slice(0, 4).join('\n') || 'Atualizado.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/CONFLICT|Merge conflict/i.test(msg)) {
      throw new Error(
        'Pull resultou em conflitos de merge. Resolva os conflitos manualmente no editor e finalize com commit.',
      );
    }
    if (/divergent branches/i.test(msg)) {
      throw new Error(
        'Branch local e remota divergiram. Tente Pull com rebase, ou resolva manualmente.',
      );
    }
    throw err;
  }
}

export async function gitPullFastForward(
  repoPath: string,
  opts: { branch?: string; authHeader?: string } = {},
): Promise<{ summary: string }> {
  const args = ['pull', '--ff-only', 'origin'];
  args.push(opts.branch ?? (await gitCurrentBranch(repoPath)));
  try {
    const out = await gitEnv(repoPath, authEnv(opts.authHeader), args);
    return { summary: out.trim().split('\n').slice(0, 4).join('\n') || 'Atualizado.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Not possible to fast-forward|divergent|non-fast-forward/i.test(msg)) {
      throw new Error(
        'Remote tem commits que exigem merge/rebase manual. Abra o source, integre a branch e execute novamente.',
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Log (history)
// ---------------------------------------------------------------------------

export interface GitCommitEntry {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  relativeDate: string;
  isoDate: string;
}

export async function gitLog(
  repoPath: string,
  opts: { limit?: number; branch?: string } = {},
): Promise<GitCommitEntry[]> {
  // Separadores de controle inequívocos: %x1f (unit sep) entre campos, %x1e
  // (record sep) entre commits. Como o corpo (%b) pode conter \n e \t — sobretudo
  // em merge commits — separadores normais (\t, \n) colidiam com o conteúdo e a
  // parsing parava após o primeiro registro. Com \x1f/\x1e isso nunca acontece.
  const ENTRY = '\x1e';
  const SEP = '\x1f';
  const fmt = '%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%cr%x1f%cI%x1e';
  const args = ['log', `--pretty=format:${fmt}`, '--no-color', `-n${opts.limit ?? 50}`];
  if (opts.branch) args.push(assertRef(opts.branch, 'branch'));
  const raw = await git(repoPath, ...args);
  return (
    raw
      .split(ENTRY)
      // `git log --pretty=format` insere um \n entre registros: removemos qualquer
      // \n/\r à esquerda pra o primeiro campo (%H) nunca vir sujo.
      .map((record) => record.replace(/^[\r\n]+/, ''))
      .filter((record) => record.length > 0)
      .map((record) => {
        const [sha, shortSha, subject, body, authorName, authorEmail, relativeDate, isoDate] =
          record.split(SEP);
        return {
          sha,
          shortSha,
          subject,
          body: body?.trim() ?? '',
          authorName,
          authorEmail,
          relativeDate,
          isoDate,
        };
      })
  );
}

export interface GitCommitFile {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
  additions: number;
  deletions: number;
}

export interface GitCommitDetails {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  relativeDate: string;
  isoDate: string;
  parents: string[];
  files: GitCommitFile[];
}

export async function gitShowCommit(repoPath: string, sha: string): Promise<GitCommitDetails> {
  assertRef(sha, 'commit');
  const SEP = '\x1f';
  const fmt = ['%H', '%h', '%s', '%b', '%an', '%ae', '%cr', '%cI', '%P'].join(SEP);
  const out = await git(
    repoPath,
    'show',
    `--pretty=format:${fmt}%n--META-END--`,
    '--numstat',
    '--name-status',
    '--no-color',
    sha,
    '--',
  );
  const [metaPart, ...rest] = out.split('\n--META-END--\n');
  const [
    shaFull,
    shortSha,
    subject,
    body,
    authorName,
    authorEmail,
    relativeDate,
    isoDate,
    parentsRaw,
  ] = metaPart.split(SEP);

  // Após o META vem em sequência: --numstat (\t-separated) + linha em branco + --name-status (\t-separated)
  const tail = rest.join('\n--META-END--\n').split('\n').filter(Boolean);
  const numByPath = new Map<string, { additions: number; deletions: number }>();
  const statusByPath = new Map<string, { status: GitCommitFile['status']; oldPath?: string }>();

  for (const line of tail) {
    const cols = line.split('\t');
    // numstat: "<adds>\t<dels>\t<path>" (adds/dels = "-" pra binários)
    if (cols.length === 3 && /^[\d-]+$/.test(cols[0]) && /^[\d-]+$/.test(cols[1])) {
      const adds = cols[0] === '-' ? 0 : parseInt(cols[0], 10);
      const dels = cols[1] === '-' ? 0 : parseInt(cols[1], 10);
      numByPath.set(cols[2], { additions: adds, deletions: dels });
      continue;
    }
    // name-status: "<status>\t<path>" ou "<status>\t<old>\t<new>" pra rename
    const status = cols[0]?.[0] as GitCommitFile['status'] | undefined;
    if (!status) continue;
    if ((status === 'R' || status === 'C') && cols.length >= 3) {
      statusByPath.set(cols[2], { status, oldPath: cols[1] });
    } else if (cols.length >= 2) {
      statusByPath.set(cols[1], { status });
    }
  }

  const files: GitCommitFile[] = [];
  for (const [path, num] of numByPath.entries()) {
    const s = statusByPath.get(path);
    files.push({
      path,
      oldPath: s?.oldPath,
      status: s?.status ?? 'M',
      additions: num.additions,
      deletions: num.deletions,
    });
  }
  // Quando o name-status traz arquivo que não veio em numstat (ex: deleção pura)
  for (const [path, s] of statusByPath.entries()) {
    if (!numByPath.has(path)) {
      files.push({
        path,
        oldPath: s.oldPath,
        status: s.status,
        additions: 0,
        deletions: 0,
      });
    }
  }

  return {
    sha: shaFull,
    shortSha,
    subject,
    body: body?.trim() ?? '',
    authorName,
    authorEmail,
    relativeDate,
    isoDate,
    parents: parentsRaw?.trim() ? parentsRaw.trim().split(' ') : [],
    files,
  };
}

export async function gitCommitFileDiff(
  repoPath: string,
  sha: string,
  filePath: string,
): Promise<string> {
  assertRef(sha, 'commit');
  return git(repoPath, 'show', '--no-color', '-U6', sha, '--', filePath);
}

export async function gitDiscard(repoPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  const requested = new Set(files);
  const status = await gitStatus(repoPath);
  const tracked: string[] = [];
  const untracked: string[] = [];

  for (const file of status.files) {
    if (!requested.has(file.path)) continue;
    if (file.indexStatus === '?' && file.workingStatus === '?') {
      untracked.push(file.path);
    } else {
      tracked.push(file.path);
    }
  }

  if (tracked.length > 0) {
    await git(repoPath, 'restore', '--staged', '--worktree', '--', ...tracked);
  }
  if (untracked.length > 0) {
    await git(repoPath, 'clean', '-f', '--', ...untracked);
  }
}

export async function gitCombinedDiff(repoPath: string, files?: string[]): Promise<string> {
  const requested = files?.length ? new Set(files) : null;
  const status = await gitStatus(repoPath);
  const patches: string[] = [];
  for (const file of status.files) {
    if (requested && !requested.has(file.path)) continue;
    if (file.staged) {
      const diff = await gitDiff(repoPath, file.path, true);
      if (diff.trim()) patches.push(diff);
    }
    if (file.unstaged) {
      const diff = await gitDiff(repoPath, file.path, false);
      if (diff.trim()) patches.push(diff);
    }
  }
  return patches.join('\n');
}

export async function gitApplyReversePatch(repoPath: string, patch: string): Promise<void> {
  if (!patch.trim()) return;
  await gitWithInput(repoPath, ['apply', '--reverse', '--whitespace=nowarn', '-'], patch);
}
