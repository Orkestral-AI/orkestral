/**
 * Motor v2: politica de preview CONTEXTUAL (secao 6 do plano).
 *
 * Antes de oferecer "Abrir preview", precisa decidir o que o projeto e:
 *   - so backend? (nao tem tela; preview e um endpoint HTTP ou os logs, nao um browser)
 *   - ja existe / e rodavel? (greenfield sem nada rodavel ainda nao tem o que mostrar)
 *   - precisa do backend no ar pra funcionar? (preview tem que subir/garantir o server)
 *
 * Tudo deterministico (le package.json + estrutura), entao e testavel sem rodar nada.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ProjectKind = 'frontend' | 'backend' | 'fullstack' | 'unknown';
export type PreviewMode = 'browser' | 'http-endpoint' | 'logs-only' | 'none';

export interface PreviewPlan {
  kind: ProjectKind;
  /** Tem app rodavel de verdade (package.json + script de dev/start + fonte). */
  runnable: boolean;
  /** Greenfield (acabou de nascer) vs brownfield (ja tinha codigo antes). */
  brownfield: boolean;
  /** O preview exige um servidor no ar pra funcionar. */
  needsBackendUp: boolean;
  mode: PreviewMode;
  /** URL pra browser/http; null quando nao se aplica. */
  url: string | null;
  /** Comando que sobe o app (ex: "npm run dev"); null se nao da. */
  startCommand: string | null;
  /** Explicacao curta e honesta pro usuario. */
  reason: string;
}

interface Pkg {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPkg(projectRoot: string): Pkg | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as Pkg;
  } catch {
    return null;
  }
}

const FRONTEND_DEPS = [
  'next',
  'react',
  'react-dom',
  'vue',
  'svelte',
  '@angular/core',
  'solid-js',
  'astro',
];
const BACKEND_DEPS = ['express', 'fastify', '@nestjs/core', 'koa', 'hono', '@hapi/hapi'];

function hasAny(pkg: Pkg, names: string[]): boolean {
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return names.some((n) => n in all);
}

function exists(projectRoot: string, rel: string): boolean {
  return fs.existsSync(path.join(projectRoot, rel));
}

/** Detecta se ha fonte de verdade alem do scaffold (heuristica de brownfield). */
function hasSource(projectRoot: string): boolean {
  return (
    exists(projectRoot, 'app') ||
    exists(projectRoot, 'pages') ||
    exists(projectRoot, 'src') ||
    exists(projectRoot, 'index.html') ||
    exists(projectRoot, 'server.js') ||
    exists(projectRoot, 'server.ts')
  );
}

function pickStartCommand(pkg: Pkg): string | null {
  const s = pkg.scripts ?? {};
  if (s.dev) return 'npm run dev';
  if (s.start) return 'npm start';
  if (s.serve) return 'npm run serve';
  return null;
}

/**
 * Decide como (e se) da pra dar preview de um projeto. Nunca lanca.
 * Next.js conta como fullstack (serve UI + API routes); express/fastify sozinho e backend.
 */
export function planPreview(input: { projectRoot: string; port?: number }): PreviewPlan {
  const { projectRoot, port = 3000 } = input;
  const pkg = readPkg(projectRoot);

  if (!pkg) {
    return {
      kind: 'unknown',
      runnable: false,
      brownfield: false,
      needsBackendUp: false,
      mode: 'none',
      url: null,
      startCommand: null,
      reason:
        'Sem package.json: nada rodavel ainda. Preview indisponivel ate a fatia 1 subir uma base.',
    };
  }

  const isNext = hasAny(pkg, ['next']);
  const hasFrontend = hasAny(pkg, FRONTEND_DEPS);
  const hasBackend = hasAny(pkg, BACKEND_DEPS);
  const startCommand = pickStartCommand(pkg);
  // "Rodavel" EXIGE deps instaladas (node_modules): sem elas o `npm run dev` nem sobe,
  // e o preview aparecia cedo demais e vazio. So libera quando da pra rodar algo de
  // verdade do que ja foi feito (scaffold + deps + script de start).
  const runnable = !!startCommand && hasSource(projectRoot) && exists(projectRoot, 'node_modules');
  const brownfield = hasSource(projectRoot);

  // Next.js: fullstack, serve tudo num server so. Precisa do server no ar.
  if (isNext) {
    return {
      kind: 'fullstack',
      runnable,
      brownfield,
      needsBackendUp: true,
      mode: runnable ? 'browser' : 'none',
      url: runnable ? `http://localhost:${port}` : null,
      startCommand,
      reason: runnable
        ? 'Next.js (UI + API no mesmo server): preview no browser, exige o dev server no ar.'
        : 'Next.js detectado mas ainda sem base rodavel. Preview libera quando a fatia 1 subir.',
    };
  }

  // Backend puro (express/fastify/nest, sem framework de UI): nao tem tela.
  if (hasBackend && !hasFrontend) {
    return {
      kind: 'backend',
      runnable,
      brownfield,
      needsBackendUp: true,
      mode: runnable ? 'http-endpoint' : 'logs-only',
      url: runnable ? `http://localhost:${port}/health` : null,
      startCommand,
      reason: runnable
        ? 'Projeto so de backend: sem browser. Preview e um endpoint HTTP (ex: /health) com o server no ar.'
        : 'Backend sem entrada rodavel ainda: acompanhe pelos logs ate a fatia 1 subir o server.',
    };
  }

  // Frontend (pode ser estatico ou chamar um backend separado).
  if (hasFrontend) {
    const needsBackendUp = hasBackend; // tem ambos no mesmo repo = front depende do back.
    return {
      kind: needsBackendUp ? 'fullstack' : 'frontend',
      runnable,
      brownfield,
      needsBackendUp,
      mode: runnable ? 'browser' : 'none',
      url: runnable ? `http://localhost:${port}` : null,
      startCommand,
      reason: runnable
        ? needsBackendUp
          ? 'Front + back no mesmo repo: o preview no browser exige o backend no ar tambem.'
          : 'Frontend: preview no browser. Nao depende de backend pra renderizar.'
        : 'Frontend detectado mas sem base rodavel ainda. Preview libera com a fatia 1.',
    };
  }

  // Tem package.json mas nada reconhecido: oferece comando se houver, senao logs.
  return {
    kind: 'unknown',
    runnable: !!startCommand,
    brownfield,
    needsBackendUp: !!startCommand,
    mode: startCommand ? 'http-endpoint' : 'logs-only',
    url: null,
    startCommand,
    reason: 'Stack nao reconhecida: sem preview de browser garantido. Acompanhe por logs/endpoint.',
  };
}
