/**
 * Starter templates (inspirado no STARTER_TEMPLATES do bolt.diy) — resolve o problema
 * do GREENFIELD AMADOR: em vez do modelo ARQUITETAR a base do zero (e produzir
 * package.json/tsconfig/estrutura inconsistentes + código órfão), partimos de uma base
 * COMPROVADA. Diferente do bolt.diy (que clona repos do GitHub, que apodrecem), usamos
 * os SCAFFOLDERS OFICIAIS (create-next-app, create vite) — sempre atuais e que buildam.
 * O agente só CUSTOMIZA em cima de uma base que já compila.
 */
import { exec } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface ProjectTemplate {
  name: string;
  label: string;
  description: string;
  /** Termos que casam a intenção do usuário (heurística de seleção). */
  tags: string[];
  stack: 'nextjs' | 'vite-react' | 'node-api' | 'blank';
  designSystem: 'shadcn' | null;
  /** Comandos de scaffold rodados em sequência no diretório do projeto (vazio). */
  commands: string[];
  /**
   * OVERLAY curado escrito DEPOIS dos comandos (o "igual bolt.diy"): estrutura + exemplos
   * + um AGENTS.md que ENSINA o modelo onde cada coisa vai. É o que evita o lixo de rota
   * órfã — o agente lê o AGENTS.md (protocolo de execução manda ler) e segue as convenções.
   */
  overlayFiles?: Array<{ path: string; content: string }>;
}

/** AGENTS.md gravado na raiz do projeto Next — o protocolo de execução manda os agentes
 *  LEREM AGENTS.md antes de mexer, então isto guia a colocação de arquivos (anti-órfão). */
const NEXTJS_AGENTS_MD = [
  '# AGENTS.md — convenções deste projeto',
  '',
  'Stack: **Next.js 15 (App Router) · TypeScript · Tailwind v4 · shadcn/ui**.',
  'A base foi scaffoldada pelos CLIs oficiais e **JÁ COMPILA** (`npm run build` passa).',
  'Customize EM CIMA dela — não recrie `package.json`, `tsconfig`, config de Tailwind nem a estrutura.',
  '',
  '## Onde cada coisa vai — REGRA (nunca na raiz do repo)',
  'O Next.js só roteia o que está sob `src/app/`. Arquivo de rota fora daí é IGNORADO (rota não existe).',
  '',
  '- **Página:** `src/app/<rota>/page.tsx` — ex.: `/dashboard` → `src/app/dashboard/page.tsx`.',
  '- **Layout:** `src/app/<rota>/layout.tsx`.',
  '- **API / route handler:** `src/app/api/<nome>/route.ts` — ex.: `GET /api/users` → `src/app/api/users/route.ts`.',
  '  NUNCA crie `route.ts` na raiz, em `config/`, `sessions/`, `widgets/` etc. Sempre sob `src/app/api/`.',
  '- **Componentes shadcn/ui:** `src/components/ui/` (já instalados: button, card, input, label, form, dialog,',
  '  table, dropdown-menu, sonner, avatar, badge). Pra mais: `npx shadcn@latest add <comp>`.',
  '- **Componentes do app:** `src/components/`.',
  '- **Helpers/libs:** `src/lib/` (o `cn()` já está em `src/lib/utils.ts`).',
  '- **Tipos:** co-localizados ou `src/types/`.',
  '- **Prisma (se usar):** schema em `prisma/schema.prisma`, client em `src/lib/db.ts`.',
  '',
  '## Convenções',
  "- Server Components por padrão; `'use client'` só quando precisa de estado/efeito/handler de evento.",
  '- UI = shadcn/ui + classes Tailwind. Não traga outra biblioteca de componentes.',
  '- `cn()` de `@/lib/utils` pra className condicional (nunca template string).',
  '- Import alias: `@/*` → `src/*`.',
  '- Variáveis de ambiente: `.env.local` (veja `.env.example`); nunca commite segredos.',
  '',
  '## Comandos',
  '- `npm run dev` — servidor de desenvolvimento.',
  '- `npm run build` — **TEM que passar** antes de considerar qualquer tela/rota pronta.',
  '- `npm run lint` — eslint.',
  '',
  'Exemplo de route handler correto está em `src/app/api/health/route.ts`.',
  '',
].join('\n');

const NEXTJS_HEALTH_ROUTE = [
  "import { NextResponse } from 'next/server';",
  '',
  '// Exemplo de route handler. TODAS as APIs ficam em src/app/api/<nome>/route.ts',
  '// (o Next só roteia sob src/app/). Acesse em GET /api/health.',
  'export function GET() {',
  "  return NextResponse.json({ status: 'ok', service: 'api' });",
  '}',
  '',
].join('\n');

const ENV_EXAMPLE = [
  '# Copie para .env.local e preencha. NUNCA commite segredos reais.',
  '# DATABASE_URL="postgresql://user:pass@localhost:5432/app"',
  '# NEXT_PUBLIC_APP_URL="http://localhost:3000"',
  '',
].join('\n');

const VITE_AGENTS_MD = [
  '# AGENTS.md — convenções deste projeto',
  '',
  'Stack: **Vite · React 19 · TypeScript · Tailwind v4**. A base já compila (`npm run build`).',
  'Customize em cima — não recrie config/estrutura.',
  '',
  '## Onde cada coisa vai',
  '- **Entrada:** `src/main.tsx` (monta o React) e `src/App.tsx` (raiz).',
  '- **Componentes:** `src/components/`. **Helpers:** `src/lib/`. **Hooks:** `src/hooks/`.',
  '- **Estilos:** Tailwind (classes utilitárias) — Tailwind v4 já plugado no `vite.config`.',
  '- **Assets:** `src/assets/` (importados) ou `public/` (servidos crus).',
  '',
  '## Convenções',
  '- SPA client-side; sem backend aqui (chame uma API externa via fetch).',
  '- shadcn/ui pode ser adicionado com `npx shadcn@latest add <comp>` → vai pra `src/components/ui/`.',
  '- Import alias: configure `@/*` → `src/*` no `tsconfig` + `vite.config` se for usar.',
  '',
  '## Comandos',
  '- `npm run dev` · `npm run build` (TEM que passar) · `npm run preview`.',
  '',
].join('\n');

const NODE_API_AGENTS_MD = [
  '# AGENTS.md — convenções deste projeto',
  '',
  'Stack: **Node · Express · TypeScript** (API HTTP, sem UI).',
  '',
  '## Onde cada coisa vai',
  '- **Entrada:** `src/index.ts` (sobe o servidor — exemplo já incluso).',
  '- **Rotas:** `src/routes/<recurso>.ts` (um Router por recurso), montadas no `src/index.ts`.',
  '- **Lógica/serviços:** `src/services/`. **Middlewares:** `src/middlewares/`. **Tipos:** `src/types/`.',
  '- **Config/env:** `.env` (use `dotenv`); nunca commite segredos.',
  '',
  '## Convenções',
  '- TypeScript estrito; rode com `tsx` em dev. Valide input (zod) nas rotas.',
  '- 1 responsabilidade por arquivo; rota fina chamando service.',
  '',
  '## Comandos',
  '- Dev: `npx tsx watch src/index.ts` · Build: `npx tsc`.',
  '',
].join('\n');

const NODE_API_INDEX = [
  "import express from 'express';",
  '',
  'const app = express();',
  'app.use(express.json());',
  '',
  '// Exemplo de rota. Crie novas rotas em src/routes/<recurso>.ts e monte-as aqui.',
  "app.get('/health', (_req, res) => {",
  "  res.json({ status: 'ok' });",
  '});',
  '',
  'const port = Number(process.env.PORT ?? 3000);',
  'app.listen(port, () => console.log(`API on http://localhost:${port}`));',
  '',
].join('\n');

/**
 * Catálogo. Os comandos usam os CLIs oficiais em modo não-interativo (`--yes`/`-d`),
 * com `.` como destino (diretório atual, que precisa estar vazio).
 */
export const STARTER_TEMPLATES: ProjectTemplate[] = [
  {
    name: 'nextjs-shadcn',
    label: 'Next.js + shadcn/ui',
    description:
      'App full-stack: Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui. Base ideal pra produto com UI (dashboard, SaaS, painel).',
    tags: [
      'next',
      'nextjs',
      'next.js',
      'react',
      'shadcn',
      'app',
      'dashboard',
      'saas',
      'web',
      'fullstack',
      'painel',
      'frontend',
      'ui',
    ],
    stack: 'nextjs',
    designSystem: 'shadcn',
    commands: [
      'npx --yes create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes',
      'npx --yes shadcn@latest init -d',
      'npx --yes shadcn@latest add button card input label form dialog table dropdown-menu sonner avatar badge',
      // Prova que a base BUILDA (senão scaffoldFromTemplate retorna ok=false e o agente sabe).
      'npm run build',
    ],
    // Overlay curado (estilo bolt.diy): convenções + exemplo de rota → o modelo sabe
    // ONDE pôr cada arquivo (evita route.ts órfão na raiz/config/sessions).
    overlayFiles: [
      { path: 'AGENTS.md', content: NEXTJS_AGENTS_MD },
      { path: 'src/app/api/health/route.ts', content: NEXTJS_HEALTH_ROUTE },
      { path: '.env.example', content: ENV_EXAMPLE },
    ],
  },
  {
    name: 'vite-react-shadcn',
    label: 'Vite + React + Tailwind',
    description:
      'SPA leve: Vite + React + TypeScript + Tailwind v4 (build verificado). shadcn/ui pode ser adicionado pelo agente depois (init é instável em projeto Vite recém-criado).',
    tags: ['vite', 'react', 'spa', 'shadcn', 'frontend', 'single page', 'dashboard'],
    stack: 'vite-react',
    designSystem: null,
    commands: [
      'npm create vite@latest . -- --template react-ts',
      'npm install',
      // Tailwind v4 via plugin oficial do Vite (mais robusto que init manual de config).
      'npm install -D tailwindcss @tailwindcss/vite',
      'npm run build',
    ],
    overlayFiles: [{ path: 'AGENTS.md', content: VITE_AGENTS_MD }],
  },
  {
    name: 'node-api',
    label: 'Node API (Express + TypeScript)',
    description: 'Backend HTTP só de API: Node + Express + TypeScript. Sem UI.',
    tags: ['api', 'backend', 'express', 'node', 'server', 'rest', 'webhook'],
    stack: 'node-api',
    designSystem: null,
    commands: [
      'npm init -y',
      'npm install express',
      'npm install -D typescript @types/express @types/node tsx',
      'npx --yes tsc --init',
    ],
    overlayFiles: [
      { path: 'AGENTS.md', content: NODE_API_AGENTS_MD },
      { path: 'src/index.ts', content: NODE_API_INDEX },
    ],
  },
];

/**
 * Escolhe o template que melhor casa com o pedido (heurística determinística por tags —
 * sem LLM, testável e barata). Empate/zero → o de UI (Next.js+shadcn) é o default
 * sensato pra "criar um sistema/app" (a maioria dos pedidos é produto com UI).
 */
export function selectTemplate(
  request: string,
  templates: ProjectTemplate[] = STARTER_TEMPLATES,
): ProjectTemplate {
  const q = request.toLowerCase();
  let best = templates[0];
  let bestScore = -1;
  for (const t of templates) {
    let score = 0;
    for (const tag of t.tags) {
      if (q.includes(tag)) score += tag.length >= 5 ? 2 : 1; // tags específicas pesam mais
    }
    // Sinal forte de "só API/sem tela" empurra pro node-api.
    if (
      t.stack === 'node-api' &&
      /\b(s[oó]\s+api|apenas api|api[- ]only|sem (tela|ui|front))\b/.test(q)
    )
      score += 4;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/** Diretório está vazio o bastante pra scaffoldar? (ignora dotfiles/.git). */
export function isScaffoldable(repoPath: string): boolean {
  try {
    const entries = readdirSync(repoPath).filter(
      (e) => e !== '.git' && e !== '.DS_Store' && !e.startsWith('.idea'),
    );
    return entries.length === 0;
  } catch {
    return true; // diretório não existe ainda → criável
  }
}

function run(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: '1' } },
      (error, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(-2000);
        resolve({ ok: !error, out });
      },
    );
  });
}

export interface ScaffoldResult {
  ok: boolean;
  template: string;
  ranCommands: number;
  failedCommand?: string;
  output: string;
}

/**
 * Roda os comandos do template no `repoPath` (precisa estar vazio). Para no primeiro
 * que falhar e devolve o resultado. NÃO lança — quem chama decide o fallback (deixar o
 * agente scaffoldar do jeito antigo). Timeout generoso por comando (npm install é lento).
 */
export async function scaffoldFromTemplate(
  repoPath: string,
  template: ProjectTemplate,
  perCommandTimeoutMs = 10 * 60 * 1000,
): Promise<ScaffoldResult> {
  if (!isScaffoldable(repoPath)) {
    return {
      ok: false,
      template: template.name,
      ranCommands: 0,
      failedCommand: '(diretório não está vazio)',
      output: 'O diretório do projeto não está vazio — scaffold abortado pra não sobrescrever.',
    };
  }
  let ran = 0;
  const logs: string[] = [];
  for (const cmd of template.commands) {
    const r = await run(cmd, repoPath, perCommandTimeoutMs);
    ran++;
    logs.push(`$ ${cmd}\n${r.out}`);
    if (!r.ok) {
      return {
        ok: false,
        template: template.name,
        ranCommands: ran,
        failedCommand: cmd,
        output: logs.join('\n\n').slice(-4000),
      };
    }
  }
  // Overlay curado: escreve os arquivos de convenção/exemplo DEPOIS do scaffold oficial.
  // Best-effort: uma falha de escrita não invalida a base (que já compila).
  for (const f of template.overlayFiles ?? []) {
    try {
      const abs = join(repoPath, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content, 'utf-8');
      logs.push(`+ ${f.path}`);
    } catch (err) {
      logs.push(`! falha ao escrever ${f.path}: ${String(err)}`);
    }
  }
  return {
    ok: true,
    template: template.name,
    ranCommands: ran,
    output: logs.join('\n\n').slice(-4000),
  };
}
