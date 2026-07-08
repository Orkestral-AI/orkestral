/**
 * Classificador determinístico (sem IA) de tasks/issues. Decide risco e
 * `executionMode` a partir de heurísticas: arquivos afetados, áreas críticas,
 * palavras-chave de alto risco e contexto disponível.
 *
 * O Forge (local) é o executor PRIMÁRIO: na dúvida, roda local (e explora o
 * repo se o título não traz arquivos). Só escala pro premium em área crítica de
 * ARQUIVO ou em mudanças grandes demais. Nunca roda local em área crítica sem
 * `allowLocalOnCritical`.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isInsideRepo } from './diff';
import type {
  Issue,
  SmartExecConfig,
  TaskClassification,
  FallbackPolicy,
} from '../../../shared/types';

const DEFAULT_FALLBACK: FallbackPolicy = {
  onPatchFailure: 'retry_local_once',
  onValidationFailure: 'retry_local_once_then_premium',
  onHighRiskDetected: 'premium_model',
  onLargeDiff: 'premium_model',
};

// Palavras que indicam alto risco / decisão arquitetural / área sensível.
const HIGH_RISK_KEYWORDS = [
  'auth',
  'autentic',
  'login',
  'senha',
  'password',
  'token',
  'permiss',
  'authoriz',
  'autoriz',
  'pagamento',
  'payment',
  'billing',
  'cobran',
  'banco de dados',
  'database',
  'migration',
  'migra',
  'schema do banco',
  'cript',
  'encrypt',
  'secret',
  'credential',
  'credencial',
  '.env',
  'infra',
  'deploy',
  'ci/cd',
  'cicd',
  'pipeline',
  'segurança',
  'security',
  'refator',
  'refactor',
  'arquitetura',
  'architecture',
];

const MEDIUM_RISK_KEYWORDS = [
  'endpoint',
  'api',
  'rota',
  'route',
  'integraç',
  'integration',
  'webhook',
  'concorr',
  'concurren',
];

/** Converte um glob simples em RegExp (`**` = qualquer, `*` = dentro do segmento). */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if ('.+^$()[]{}|\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

function matchesAnyGlob(path: string, globs: string[]): boolean {
  const norm = path.replace(/^\.?\//, '');
  return globs.some((g) => {
    const re = globToRegExp(g);
    return re.test(path) || re.test(norm);
  });
}

/** Extrai caminhos de arquivo de um texto (tokens com extensão de código). */
function extractFilePaths(text: string, repoPath?: string): string[] {
  const out = new Set<string>();
  const re =
    /[A-Za-z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|md|py|go|rs|java|rb|sql|ya?ml|toml|html|vue|svelte)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[0].replace(/^\.?\//, '');
    if (p.length <= 3 || p.startsWith('http')) continue;
    // Contenção de path (segurança): descarta absolutos/`..` que escapem o repo —
    // assim um caminho de path-traversal no texto da issue nunca vira alvo.
    if (repoPath && !isInsideRepo(repoPath, p)) continue;
    out.add(p);
  }
  return [...out];
}

/**
 * Fallback de verificação por LINGUAGEM: quando o repo não tem scripts de
 * typecheck/lint no package.json, ainda assim queremos checar o SINTAXE/parse
 * do arquivo editado em vez de tratar a ausência de validação como sucesso.
 * Cada entrada mapeia a extensão pro binário verificador e um `build` que monta
 * o comando a partir do caminho relativo do arquivo.
 */
interface SyntaxChecker {
  bin: string;
  build: (file: string) => string;
}

// Só inclui checkers de SINTAXE de arquivo único confiáveis (não exigem resolver
// o grafo de módulos do projeto). TS/TSX são omitidos de propósito: um
// `tsc --noEmit` num único arquivo gera erros falsos (imports/módulos não
// resolvidos) e escalaria todo edit de TS à toa. Sem script npm de typecheck,
// um edit de TS fica 'skipped/unverified' (não 'passed'), que é o sinal correto.
const SYNTAX_CHECKERS: Record<string, SyntaxChecker> = {
  '.js': { bin: 'node', build: (f) => `node --check ${quoteArg(f)}` },
  '.mjs': { bin: 'node', build: (f) => `node --check ${quoteArg(f)}` },
  '.cjs': { bin: 'node', build: (f) => `node --check ${quoteArg(f)}` },
  '.py': { bin: 'python3', build: (f) => `python3 -m py_compile ${quoteArg(f)}` },
  '.php': { bin: 'php', build: (f) => `php -l ${quoteArg(f)}` },
  '.rb': { bin: 'ruby', build: (f) => `ruby -c ${quoteArg(f)}` },
  '.go': { bin: 'gofmt', build: (f) => `gofmt -e ${quoteArg(f)}` },
};

/** Aspas simples no caminho pra suportar espaços (POSIX e Windows lidam com '). */
function quoteArg(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

const binaryAvailability = new Map<string, boolean>();

/**
 * Checa se um binário está plausivelmente no PATH, de forma síncrona e barata.
 * `node` está sempre disponível (estamos rodando dentro dele). Para os demais,
 * usa `command -v` (POSIX) ou `where` (Windows). Conservador: na dúvida, false.
 */
function binaryAvailable(bin: string): boolean {
  if (bin === 'node') return true;
  const cached = binaryAvailability.get(bin);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    // `bin` vem do mapa SYNTAX_CHECKERS (constante, nunca input do usuário).
    const isWin = process.platform === 'win32';
    const probe = isWin
      ? spawnSync('where', [bin], { stdio: 'ignore', windowsHide: true })
      : spawnSync('command -v ' + bin, { shell: true, stdio: 'ignore' });
    ok = probe.status === 0;
  } catch {
    ok = false;
  }
  binaryAvailability.set(bin, ok);
  return ok;
}

/**
 * Fallback de verificação por arquivo: para cada arquivo editado, deriva um
 * comando de syntax-check baseado na extensão, mas só se o binário existir.
 * Arquivos cuja extensão não tem checker, ou cujo checker não está disponível,
 * NÃO geram comando — o orquestrador trata isso como 'skipped/unverified' em vez
 * de 'passed', preservando o sinal de que o edit não pôde ser verificado.
 */
function syntaxCheckCommands(repoPath: string, affectedFiles: string[]): string[] {
  const cmds = new Set<string>();
  for (const file of affectedFiles) {
    const checker = SYNTAX_CHECKERS[extname(file).toLowerCase()];
    if (!checker) continue;
    if (!binaryAvailable(checker.bin)) continue;
    if (!existsSync(join(repoPath, file))) continue;
    cmds.add(checker.build(file));
  }
  return [...cmds];
}

/**
 * Comandos de validação disponíveis no repo. Prioriza os scripts npm
 * (typecheck/lint do package.json); na ausência deles, cai pra um syntax-check
 * por linguagem do(s) arquivo(s) editado(s) pra não tratar "sem validação" como
 * sucesso (P0-3).
 */
export function detectValidationCommands(
  repoPath: string | undefined,
  affectedFiles: string[],
): string[] {
  if (!repoPath) return [];
  try {
    const cmds: string[] = [];
    // NÃO roda lint/typecheck do projeto do usuário (`npm run lint`/`typecheck`).
    // Esses scripts rodam no REPO INTEIRO, com a tooling e as regras do usuário que
    // o Forge "nem sabe o que é" — e FALHAM por erro PRÉ-EXISTENTE não-relacionado,
    // bloqueando uma mudança boa. O agente é pra ALTERAR o que foi pedido e pronto;
    // a verificação real de qualidade é o Code Reviewer na cadeia. Aqui só fica o
    // SYNTAX-CHECK do(s) arquivo(s) tocado(s) (o arquivo parseia?), que é barato,
    // local e nunca falha por estado pré-existente do repo.
    for (const c of syntaxCheckCommands(repoPath, affectedFiles)) {
      if (!cmds.includes(c)) cmds.push(c);
    }
    return cmds;
  } catch {
    return [];
  }
}

export interface ClassifyOptions {
  config: SmartExecConfig;
  repoPath?: string;
}

// --- Intenção de CRIAÇÃO de arquivo novo (migration/model) ---
// Sem isto, uma task "criar migration X" não tinha como expressar que o alvo é um
// arquivo NOVO: a busca achava migrations EXISTENTES e o Forge as sobrescrevia.
// Detecção DIRIGIDA PELO TÍTULO no padrão "<tipo(s)>: <lista de entidades>" — a
// descrição é prosa ruidosa demais (extrair tokens dela gerava dezenas de
// caminhos-lixo, trocando um bug por outro pior). Tipos creational só no CABEÇALHO.
const MIGRATION_TYPE_RE = /\bmigrations?\b|\bmigra(?:ç|c)(?:ã|a)o\b|\btabelas?\b|\btables?\b/i;
const MODEL_TYPE_RE = /\bmodels?\b|\bmodelos?\b/i;

const DESIGN_ISSUE_RE = /^\s*\[design\]/i;
const QA_ISSUE_RE = /^\s*\[qa\]/i;

/**
 * Issue NON-CODE (Design/QA): o deliverable é um TEXTO (spec de design / relatório
 * de QA), não um diff. Roda o patcher de código nelas → 0 edições → bloqueio (erro
 * de categoria). Detecta pelo prefixo do título "[Design]"/"[QA]" OU pelos labels
 * design/qa (o orquestrador padroniza ambos no plano). Null = issue de código normal.
 */
function detectDeliverableKind(issue: Issue): 'design' | 'qa' | null {
  const title = issue.title ?? '';
  const labels = (issue.labels ?? []).map((l) => l.toLowerCase());
  if (DESIGN_ISSUE_RE.test(title) || labels.includes('design')) return 'design';
  if (QA_ISSUE_RE.test(title) || labels.includes('qa')) return 'qa';
  return null;
}

// Issue de PLANEJAMENTO/SPEC/ARQUITETURA/REVIEW: o deliverable é um documento (spec,
// arquitetura, RFC, design doc) ou uma revisão — NÃO um diff de código. Deve rodar no
// MODELO do agente (o premium configurado, ex.: Opus), não no Forge executor. Detecta
// pelo prefixo do título "[Spec]/[Plan]/[Review]…", pela palavra de planejamento NO
// INÍCIO do título (ancorada, pra "Add review button…" NÃO casar) ou por label. Não
// varre a prosa da descrição (gera falso-positivo). É só SINAL DE ROTEAMENTO — não muda
// o executionMode da classificação de código.
const PLANNING_ISSUE_RE =
  /^\s*\[(spec|plan|planning|arch|architecture|rfc|design[- ]?doc|review)\]/i;
const PLANNING_HEAD_RE =
  /^\s*(spec\b|especifica|arquitetura|architecture|planejamento|planning|rfc\b|design doc|technical design|revis|review\b)/i;
const PLANNING_LABELS = ['spec', 'planning', 'architecture', 'rfc', 'review'];

export function isPlanningIssue(issue: Issue): boolean {
  const title = issue.title ?? '';
  if (PLANNING_ISSUE_RE.test(title) || PLANNING_HEAD_RE.test(title)) return true;
  const labels = (issue.labels ?? []).map((l) => l.toLowerCase());
  return labels.some((l) => PLANNING_LABELS.includes(l));
}

function studlyCase(s: string): string {
  return s
    .replace(/[_\-\s]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/** Singulariza a ÚLTIMA palavra (calls→call, sessions→session, config→config). */
function singularizeLast(snake: string): string {
  const parts = snake.split('_');
  const last = parts[parts.length - 1];
  parts[parts.length - 1] = last
    .replace(/ies$/i, 'y')
    .replace(/sses$/i, 'ss')
    .replace(/([^s])s$/i, '$1');
  return parts.join('_');
}

/** Já existe uma migration `*_create_<tabela>_table.php` (qualquer timestamp)?
 *  Evita duplicar a migration da MESMA tabela em re-execuções (o stamp muda a
 *  cada run, então o path nunca casa o existente). */
function migrationExistsForTable(repoPath: string, table: string): boolean {
  try {
    const suffix = `_create_${table}_table.php`;
    return readdirSync(join(repoPath, 'database', 'migrations')).some((f) => f.endsWith(suffix));
  } catch {
    return false;
  }
}

/** Timestamp de migration Laravel (YYYY_MM_DD_HHMMSS), sequencial pra preservar ordem. */
function migrationStamp(baseMs: number, i: number): string {
  const d = new Date(baseMs + i * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}_${p(d.getUTCMonth() + 1)}_${p(d.getUTCDate())}_` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

const CREATE_ENTITY_STOPWORDS = new Set([
  'migration',
  'migrations',
  'migracao',
  'migração',
  'model',
  'models',
  'modelo',
  'modelos',
  'controller',
  'controllers',
  'service',
  'services',
  'servico',
  'serviço',
  'component',
  'components',
  'componente',
  'componentes',
  'endpoint',
  'endpoints',
  'tabela',
  'tabelas',
  'table',
  'tables',
  'arquivo',
  'arquivos',
  'file',
  'files',
  'and',
  'com',
  'para',
  'for',
  'the',
  'novo',
  'nova',
  'novos',
  'novas',
  'new',
  'create',
  'criar',
  'add',
  'dedicados',
  'dedicadas',
  'core',
]);

/** Extrai os NOMES das entidades de uma LISTA (ex.: "calls, call_sessions, department_call_config"). */
function extractCreateEntities(list: string, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of list.matchAll(/[A-Za-z][A-Za-z0-9_]{2,}/g)) {
    const tok = m[0];
    const low = tok.toLowerCase();
    if (CREATE_ENTITY_STOPWORDS.has(low)) continue;
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(tok);
    if (out.length >= max) break;
  }
  return out;
}

/** Diretório Laravel por sufixo de artefato (o stack do usuário). */
const ARTIFACT_DIRS: Record<string, string> = {
  Controller: 'app/Http/Controllers',
  Service: 'app/Services',
  Provider: 'app/Providers',
  Middleware: 'app/Http/Middleware',
  Job: 'app/Jobs',
  Listener: 'app/Listeners',
  Event: 'app/Events',
  Request: 'app/Http/Requests',
};

/**
 * Detecta um ARTEFATO Laravel nomeado no INÍCIO do título (ex.: "CallRecordingService
 * — proxy…", "CallSettingsController — CRUD…") e devolve o caminho do arquivo NOVO a
 * criar. Só dispara quando o identificador PascalCase abre o título E termina num
 * sufixo conhecido — assim "fix bug in CallController" (não começa com o nome) ou
 * "Tela admin" não disparam. Se o arquivo já existe, devolve null (é edição, não
 * criação). Cria a pasta certa por sufixo.
 */
function deriveArtifactFile(title: string, repoPath: string): string | null {
  const m = title.match(
    /^\s*([A-Z][A-Za-z0-9]*(Controller|Service|Provider|Middleware|Job|Listener|Event|Request))\b/,
  );
  if (!m) return null;
  const dir = ARTIFACT_DIRS[m[2]];
  if (!dir) return null;
  const path = `${dir}/${m[1]}.php`;
  if (existsSync(join(repoPath, path))) return null; // já existe → é edição, não criação
  return path;
}

/** Caminho de arquivo NOVO citado EXPLICITAMENTE após um verbo de criação no texto
 *  da issue ("Criar src/contexts/CallContext.tsx", "Create app/Services/X.php",
 *  "Novo arquivo Z.vue"). GENÉRICO — qualquer stack (frontend incluído), qualquer
 *  extensão. Só conta o que NÃO existe ainda (é CRIAÇÃO, não edição). É o caso mais
 *  comum: o CEO diz o arquivo a criar e ele não existe → o explore chutava um arquivo
 *  existente errado e BLOQUEAVA; aqui criamos o arquivo certo. */
const CREATE_VERB_PATH_RE =
  /\b(?:criar|crie|cria|create|creating|novo|nova|new|adicionar|adicione|add)\b[^\n]{0,40}?[`'"]?([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:tsx?|jsx?|mjs|cjs|php|vue|svelte|py|rb|go|css|scss|json|sql|html|kt|cs|java))[`'"]?/gi;

/** Projeto Next.js? (App Router) — decide se normalizamos rotas pra dentro de app/. Exige o
 *  `next.config.*` (marcador DEFINITIVO): um `app/` ou `src/app` solto pode ser de outro
 *  framework (Nuxt/SvelteKit/Remix) e mover rotas pra app/ ali seria errado. */
function isNextJsRepo(repoPath: string): boolean {
  return (
    existsSync(join(repoPath, 'next.config.js')) ||
    existsSync(join(repoPath, 'next.config.ts')) ||
    existsSync(join(repoPath, 'next.config.mjs'))
  );
}

/** Arquivos especiais de ROTA do App Router — só funcionam DENTRO de app/. */
const NEXT_ROUTE_FILE_RE =
  /(^|\/)(page|layout|loading|error|not-found|template|default|route|global-error)\.(tsx?|jsx?)$/;

/**
 * Normaliza um caminho de criação num projeto Next.js: arquivo de rota (page/layout/
 * route/…) citado SEM o prefixo `app/` cairia na RAIZ e o App Router o IGNORA (foi a
 * causa real do código órfão + landing-stub). Move pra `app/` (ou `src/app/` quando o
 * projeto usa `src/`). Caminhos já corretos (app/, src/) ou não-rota são preservados.
 */
export function normalizeNextRoutePath(p: string, repoPath: string): string {
  if (!isNextJsRepo(repoPath)) return p;
  if (p.startsWith('app/') || p.startsWith('src/app/') || p.startsWith('src/')) return p;
  if (!NEXT_ROUTE_FILE_RE.test('/' + p)) return p;
  const base = existsSync(join(repoPath, 'src', 'app')) ? 'src/app' : 'app';
  return `${base}/${p}`;
}

function deriveExplicitCreatePaths(issue: Issue, repoPath: string, maxFiles: number): string[] {
  const text = `${issue.title ?? ''}\n${issue.description ?? ''}`;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  CREATE_VERB_PATH_RE.lastIndex = 0;
  while ((m = CREATE_VERB_PATH_RE.exec(text)) !== null) {
    // Rota Next.js sem `app/` → normaliza pra dentro de app/ (senão vira código órfão).
    const p = normalizeNextRoutePath(m[1].replace(/^\.?\//, ''), repoPath);
    // Contenção de path (segurança): um caminho de criação guiado pelo texto da issue
    // NÃO pode apontar pra fora do repo (`..`/absoluto) — senão escreveria fora dele.
    if (
      p.length > 4 &&
      !p.startsWith('http') &&
      isInsideRepo(repoPath, p) &&
      !existsSync(join(repoPath, p))
    ) {
      out.add(p);
    }
    if (out.size >= maxFiles) break;
  }
  return [...out];
}

/**
 * Deriva caminhos de arquivos a CRIAR. Detecção DIRIGIDA PELO TÍTULO: só dispara no
 * padrão de scaffolding "<tipo creational>: <lista>" — o CABEÇALHO (antes do ':')
 * declara migration/model/table e a LISTA (depois do ':') traz as entidades.
 * Ex.: "Migration + Models: calls, call_sessions, department_call_config".
 * NUNCA extrai entidades da descrição em prosa (gerava caminhos-lixo). Cobre o
 * caso Laravel (o stack do usuário). Cap em `maxFiles` (nunca cria em massa sem
 * revisão de plano). Vazio = comportamento de edição/exploração normal.
 */
export function deriveCreateFiles(
  issue: Issue,
  repoPath: string | undefined,
  maxFiles = 8,
): string[] {
  const title = issue.title ?? '';
  if (!repoPath) return [];

  // (0) Caminho EXPLÍCITO de criação citado no TEXTO da issue ("Criar
  // `src/contexts/CallContext.tsx`", "Create app/Services/X.php"). STACK-AGNÓSTICO
  // (frontend incluído) e prioritário — é o sinal mais confiável: o CEO disse o
  // arquivo a criar e ele não existe. Sem isto, o explore chutava um arquivo
  // EXISTENTE errado e BLOQUEAVA (era o caso da issue de frontend CallContext).
  const explicit = deriveExplicitCreatePaths(issue, repoPath, maxFiles);
  if (explicit.length > 0) return explicit;

  // Daqui pra baixo é detecção específica de Laravel (o stack do backend). Só deriva
  // caminhos quando reconhece o stack (evita inventar caminho errado).
  const isLaravel =
    existsSync(join(repoPath, 'composer.json')) ||
    existsSync(join(repoPath, 'database', 'migrations'));
  if (!isLaravel) return [];

  // (A) ARTEFATO Laravel nomeado no INÍCIO do título (ex.: "CallRecordingService —
  // proxy…", "CallSettingsController — CRUD…"). O alvo é um arquivo NOVO; sem isso
  // o explore chutava um arquivo EXISTENTE errado (AssistantOpenAI.php) e bloqueava.
  // Deriva o caminho do artefato e CRIA o arquivo certo.
  const artifact = deriveArtifactFile(title, repoPath);
  if (artifact) return [artifact];

  // (B) Sem ":" mas o CABEÇALHO (antes de "(") declara migration/model. Ex.:
  // "Migration + Model CallSession (estados…)", "Migration + Model call_settings (…)".
  // O CEO VARIA o formato (com/sem ":"); aqui pegamos a ÚLTIMA entidade-identificadora
  // do cabeçalho e derivamos migration + model dela. Sem isso, esses títulos caíam no
  // explore e bloqueavam (era o bug da issue 48 no run novo).
  const headOnly = title.split(/[:(]/)[0];
  if (!title.includes(':') && (MIGRATION_TYPE_RE.test(headOnly) || MODEL_TYPE_RE.test(headOnly))) {
    const TYPE_WORD =
      /^(migrations?|models?|tables?|migra|migra(?:ç|c)(?:ã|a)o|tabelas?|modelos?)$/i;
    const toks = (headOnly.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) ?? []).filter(
      (tk) => !TYPE_WORD.test(tk),
    );
    const ent = toks[toks.length - 1];
    if (ent) {
      const snake = ent
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[\s\-]+/g, '_')
        .toLowerCase();
      const out: string[] = [];
      if (MIGRATION_TYPE_RE.test(headOnly) && !migrationExistsForTable(repoPath, snake)) {
        out.push(`database/migrations/${migrationStamp(Date.now(), 0)}_create_${snake}_table.php`);
      }
      if (MODEL_TYPE_RE.test(headOnly)) {
        const mp = `app/Models/${studlyCase(singularizeLast(snake))}.php`;
        if (!existsSync(join(repoPath, mp))) out.push(mp);
      }
      if (out.length > 0) return out;
    }
  }

  // (C) Padrão "<tipo creational>: <lista>" — CABEÇALHO declara migration/model/table
  // e a LISTA traz as entidades. Ex.: "Migration + Models: calls, call_sessions".
  const colon = title.indexOf(':');
  if (colon < 0) return []; // sem padrão "tipo: lista" → não deriva (evita falso-positivo)
  const head = title.slice(0, colon);
  const list = title.slice(colon + 1);
  // O CABEÇALHO (antes do ':') tem que DECLARAR migration/model/table — assim
  // "Tela admin: ..." ou "[QA] validation: ..." NÃO disparam criação.
  const wantsMigration = MIGRATION_TYPE_RE.test(head);
  const wantsModel = MODEL_TYPE_RE.test(head);
  if (!wantsMigration && !wantsModel) return [];
  const entities = extractCreateEntities(list, maxFiles);
  if (entities.length === 0) return [];
  const baseMs = Date.now();
  const files: string[] = [];
  let mi = 0;
  for (const ent of entities) {
    const snake = ent
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[\s\-]+/g, '_')
      .toLowerCase();
    // Dedup por TABELA (não por path): o stamp muda a cada run, então checar o
    // path exato com existsSync NUNCA casava o existente → criava migration
    // duplicada da mesma tabela em re-execuções (e o `migrate` quebrava). Aqui
    // pulamos se JÁ existe `*_create_<tabela>_table.php` com qualquer timestamp.
    if (wantsMigration && !migrationExistsForTable(repoPath, snake)) {
      files.push(`database/migrations/${migrationStamp(baseMs, mi++)}_create_${snake}_table.php`);
    }
    if (wantsModel) {
      const path = `app/Models/${studlyCase(singularizeLast(snake))}.php`;
      if (!existsSync(join(repoPath, path))) files.push(path);
    }
    if (files.length >= maxFiles) break; // teto: nunca cria em massa local sem revisão
  }
  return files;
}

export function classifyIssue(issue: Issue, opts: ClassifyOptions): TaskClassification {
  const { config, repoPath } = opts;
  const text = `${issue.title}\n${issue.description ?? ''}`.toLowerCase();

  // Arquivos afetados: metadata explícita tem prioridade; senão extrai do texto.
  const meta = (issue.metadata ?? {}) as { affectedFiles?: unknown; deterministic?: unknown };
  const rawMetaFiles = Array.isArray(meta.affectedFiles)
    ? (meta.affectedFiles.filter((f) => typeof f === 'string') as string[])
    : [];
  // Não confia em `files=` verbatim: um caminho alucinado/obsoleto da KB faria a
  // task virar um `local_patch` confiante ("edição em N arquivo(s) existente(s)")
  // contra um alvo fantasma. Quando o repo é conhecido, filtra pelos que existem;
  // se nenhum existe, cai pro caminho de exploração (sem alvos) em vez de mentir.
  // Exige que seja um ARQUIVO de verdade (não diretório). `existsSync` é true pra
  // diretório — e um diretório no `affectedFiles` (ex.: "database/migrations/")
  // fazia o resolveTargetFiles expandir em N arquivos existentes e destruir o
  // plano de CRIAÇÃO → 0 edições → bloqueio. Diretório/inexistente cai pro caminho
  // de exploração/criação, não vira alvo de edição.
  const metaFiles =
    repoPath && rawMetaFiles.length > 0
      ? rawMetaFiles.filter((f) => {
          try {
            return statSync(join(repoPath, f)).isFile();
          } catch {
            return false;
          }
        })
      : rawMetaFiles;
  // Fallback: extrai caminhos do texto. Quando o repo é conhecido, filtra pelos que
  // são ARQUIVO de verdade — senão um caminho citado em prosa (ex.: "README.md", ou
  // um path alucinado-mas-existente) virava alvo de edição e gastava uma tier à toa.
  const extracted = extractFilePaths(`${issue.title}\n${issue.description ?? ''}`, repoPath);
  const affectedFiles =
    metaFiles.length > 0
      ? metaFiles
      : repoPath
        ? extracted.filter((f) => {
            try {
              return statSync(join(repoPath, f)).isFile();
            } catch {
              return false;
            }
          })
        : extracted;

  // Arquivos a CRIAR (intenção de criação). Caminhos NOVOS, separados de
  // affectedFiles, pra a task gerar arquivo novo em vez de editar um existente.
  // Cap no mesmo teto de arquivos afetados (nunca cria em massa local sem revisão).
  const createFiles = deriveCreateFiles(issue, repoPath, config.thresholds.maxAffectedFiles);

  const validationCommands = detectValidationCommands(repoPath, [...affectedFiles, ...createFiles]);

  // Crítico = um ARQUIVO afetado cai numa área sensível (auth/pagamento/secret/
  // migration/infra). Palavras soltas na descrição NÃO escalam mais por si só —
  // antes "api", "arquitetura", "refatorar" etc. mandavam quase tudo pro premium.
  // O Forge é o executor primário; o app valida o diff e o usuário revisa.
  const isCriticalFile = affectedFiles.some((f) => matchesAnyGlob(f, config.criticalGlobs));
  const hasHighRiskKeyword = HIGH_RISK_KEYWORDS.some((k) => text.includes(k));
  const hasMediumKeyword = MEDIUM_RISK_KEYWORDS.some((k) => text.includes(k));

  let risk: TaskClassification['risk'] = 'low';
  if (isCriticalFile) risk = 'high';
  else if (hasHighRiskKeyword) risk = 'medium';
  else if (hasMediumKeyword || affectedFiles.length > config.thresholds.maxAffectedFiles)
    risk = 'medium';

  // Decisão de modo: o Forge é o EXECUTOR primário. "Sem arquivos no título"
  // NÃO escala — significa que o executor local deve EXPLORAR o repo pra achar
  // os alvos. Só escala quando arquivo é genuinamente crítico ou são arquivos
  // demais (sinal de mudança grande/arquitetural).
  let executionMode: TaskClassification['executionMode'];
  let reason: string;

  const deliverableKind = detectDeliverableKind(issue);
  if (deliverableKind) {
    // Design/QA: deliverable é TEXTO (spec/relatório), não diff. NÃO explora o repo
    // nem entra no loop de patch (que bloquearia em 0 edições). Tem que ganhar das
    // ramificações por contagem de arquivos — por isso vem PRIMEIRO.
    executionMode = 'premium_model';
    reason =
      deliverableKind === 'design'
        ? 'Issue de Design → especificação escrita pelo modelo local (sem patch).'
        : 'Issue de QA → relatório de validação pelo modelo local (sem patch).';
  } else if (isCriticalFile && !config.allowLocalOnCritical) {
    executionMode = 'premium_model';
    reason = 'Arquivo em área crítica (auth/pagamento/migração/infra/segredos) → premium.';
  } else if (affectedFiles.length === 0 && createFiles.length > 0) {
    // Task de CRIAÇÃO pura: o executor local cria os arquivos NOVOS derivados (NÃO
    // explora o repo, que acharia arquivos existentes pra editar — o bug das core).
    executionMode = 'premium_model';
    reason = `Criação de ${createFiles.length} arquivo(s) novo(s) → executor local.`;
  } else if (affectedFiles.length === 0) {
    // Antes isto ia pro premium ("provável feature nova"). Agora roda local: o
    // orquestrador EXPLORA o repo (keywords/estrutura) pra derivar alvos.
    executionMode = 'premium_model';
    reason = 'Sem alvos no título → executor local explora o repo pra achar arquivos.';
  } else if (affectedFiles.length <= config.thresholds.maxAffectedFiles) {
    if (createFiles.length === 0) {
      // Edição BARATA: o premium gera um lazy-edit compacto por arquivo e o app aplica
      // determinístico (morph/fast-apply). Escala pro run completo só em falha.
      executionMode = 'premium_edit';
      reason = `Edição localizada em ${affectedFiles.length} arquivo(s) existente(s) → premium_edit (barato).`;
    } else {
      // Mistura edição + criação de arquivo novo: o run premium completo cria com
      // contexto do repo (o premium_edit só edita arquivo existente com segurança).
      executionMode = 'premium_model';
      reason = `Edição em ${affectedFiles.length} arquivo(s) + ${createFiles.length} novo(s) → premium completo.`;
    }
  } else {
    executionMode = 'premium_model';
    reason = `Muitos arquivos afetados (${affectedFiles.length} > ${config.thresholds.maxAffectedFiles}) → premium.`;
  }

  return {
    createFiles,
    risk,
    executionMode,
    reason,
    affectedFiles,
    validationCommands,
    fallbackPolicy: DEFAULT_FALLBACK,
    ...(deliverableKind ? { deliverableKind } : {}),
  };
}
