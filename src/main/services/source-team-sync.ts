import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { broadcast } from '../platform/host';
import { AgentRepository } from '../db/repositories/agent.repo';
import { WorkspaceSourceRepository } from '../db/repositories/workspace-source.repo';
import { ActivityRepository } from '../db/repositories/activity.repo';
import { KbPageRepository } from '../db/repositories/kb-page.repo';
import { kbEmbeddingJobRepo } from '../db/repositories/kb-embedding-job.repo';
import {
  ensureDefaultInstructions,
  readEntryInstruction,
  writeInstruction,
} from './agent-instructions';
import {
  inferAgentCoverageRole,
  inferSourceRoleFromSignals,
  normalizeSourceRole,
  planSourceAgentAssignments,
} from './agent-assignment-policy';
import type { Agent, WorkspaceSource, WorkspaceSourceRole } from '../../shared/types';

const sourceRepo = new WorkspaceSourceRepository();
const agentRepo = new AgentRepository();
const activityRepo = new ActivityRepository();
const pageRepo = new KbPageRepository();

const CAP_BLOCK_START = '[[ORK_SOURCE_SYNC_START]]';
const CAP_BLOCK_END = '[[ORK_SOURCE_SYNC_END]]';
const ENTRY_CONTEXT_START = '[[ORK_REPO_INTELLIGENCE_START]]';
const ENTRY_CONTEXT_END = '[[ORK_REPO_INTELLIGENCE_END]]';
const MAX_CONTEXT_FILES = 700;
const MAX_CONTEXT_FILE_BYTES = 160 * 1024;
const IGNORED_CONTEXT_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'storage',
  'target',
  'vendor',
]);

interface SourceFileSignal {
  path: string;
  ext: string;
  size: number;
}

interface SourceContextDossier {
  source: WorkspaceSource;
  role: WorkspaceSourceRole | null;
  stack: string[];
  scripts: string[];
  design: string[];
  files: SourceFileSignal[];
  dirs: string[];
  important: string[];
  contracts: string[];
  tests: string[];
  designRelated: string[];
  components: string[];
  tokens: string[];
  knowledge: string[];
  kbPageCount: number;
  embeddingLines: string[];
  embeddingStatus: string;
  hasAgentsMd: boolean;
  hasClaudeMd: boolean;
}

function stripAutoBlock(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(
      new RegExp(`\\n*${escapeRegex(CAP_BLOCK_START)}[\\s\\S]*?${escapeRegex(CAP_BLOCK_END)}`, 'g'),
      '',
    )
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readPackageHints(path: string | null): string {
  if (!path) return '';
  const hints: string[] = [];
  const pkgPath = join(path, 'package.json');
  try {
    if (existsSync(pkgPath)) {
      const raw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      hints.push(
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.scripts ?? {}),
      );
    }
  } catch {
    // best-effort
  }
  const composerPath = join(path, 'composer.json');
  try {
    if (existsSync(composerPath)) {
      const raw = readFileSync(composerPath, 'utf8');
      const composer = JSON.parse(raw) as {
        require?: Record<string, string>;
        'require-dev'?: Record<string, string>;
        scripts?: Record<string, unknown>;
      };
      hints.push(
        'php',
        ...Object.keys(composer.require ?? {}),
        ...Object.keys(composer['require-dev'] ?? {}),
        ...Object.keys(composer.scripts ?? {}),
      );
    }
  } catch {
    // best-effort
  }
  const markerFiles = [
    'next.config.js',
    'next.config.ts',
    'vite.config.ts',
    'vite.config.js',
    'tailwind.config.js',
    'tailwind.config.ts',
    'components.json',
    'metro.config.js',
    'metro.config.ts',
    'eas.json',
  ];
  for (const marker of markerFiles) {
    if (existsSync(join(path, marker))) hints.push(marker);
  }
  for (const markerDir of ['android', 'ios']) {
    try {
      if (existsSync(join(path, markerDir)) && statSync(join(path, markerDir)).isDirectory()) {
        hints.push(markerDir);
      }
    } catch {
      // best-effort
    }
  }
  const appJson = readJsonFile(path, 'app.json');
  if (appJson && typeof appJson.expo === 'object' && appJson.expo) {
    hints.push('expo app.json');
  }
  return hints.join(' ');
}

function readJsonFile(path: string | null, fileName: string): Record<string, unknown> | null {
  if (!path) return null;
  const filePath = join(path, fileName);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readTextFile(path: string | null, fileName: string): string | null {
  if (!path) return null;
  const filePath = join(path, fileName);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf8').slice(0, 4000);
  } catch {
    return null;
  }
}

function walkSourceFiles(path: string | null): SourceFileSignal[] {
  if (!path || !existsSync(path)) return [];
  const root = path;
  const files: SourceFileSignal[] = [];
  function visit(dir: string): void {
    if (files.length >= MAX_CONTEXT_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_CONTEXT_FILES) return;
      if (IGNORED_CONTEXT_DIRS.has(entry) || entry.startsWith('.DS_Store')) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (IGNORED_CONTEXT_DIRS.has(entry)) continue;
        visit(full);
      } else if (stat.isFile() && stat.size <= MAX_CONTEXT_FILE_BYTES) {
        files.push({
          path: relative(root, full),
          ext: extname(entry).toLowerCase(),
          size: stat.size,
        });
      }
    }
  }
  visit(root);
  return files;
}

function buildSourceContextDossier(
  source: WorkspaceSource,
  role: WorkspaceSourceRole | null,
): SourceContextDossier {
  const stack = stackSignals(source);
  const scripts = packageScripts(source);
  const design = designSystemSignals(source);
  const files = walkSourceFiles(source.path);
  const sourcePages = pageRepo
    .listByWorkspace(source.workspaceId, false)
    .filter((page) => page.sourceId === source.id);
  const latestEmbedding = kbEmbeddingJobRepo
    .listByWorkspace(source.workspaceId, 100)
    .find((job) => job.sourceId === source.id);
  const embeddingStatus =
    latestEmbedding && latestEmbedding.total > 0
      ? `${latestEmbedding.status} ${latestEmbedding.current}/${latestEmbedding.total}`
      : latestEmbedding
        ? latestEmbedding.status
        : 'not queued';
  return {
    source,
    role,
    stack,
    scripts,
    design,
    files,
    dirs: topDirectories(files),
    important: importantFiles(source, files),
    contracts: contractFiles(files),
    tests: testFiles(files),
    designRelated: designFiles(files),
    components: componentInventory(files),
    tokens: extractDesignTokens(source),
    knowledge: knowledgePageSummary(source),
    kbPageCount: sourcePages.length,
    embeddingLines: embeddingJobSummary(source),
    embeddingStatus,
    hasAgentsMd: !!readTextFile(source.path, 'AGENTS.md'),
    hasClaudeMd: !!readTextFile(source.path, 'CLAUDE.md'),
  };
}

function buildSourceContextDossiers(
  sources: WorkspaceSource[],
  roles: Map<string, WorkspaceSourceRole | null>,
): Map<string, SourceContextDossier> {
  return new Map(
    sources.map((source) => [
      source.id,
      buildSourceContextDossier(source, roles.get(source.id) ?? null),
    ]),
  );
}

function topDirectories(files: SourceFileSignal[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = file.path.split(/[\\/]/)[0] || '.';
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([dir, count]) => `${dir} (${count})`);
}

function matchingFiles(files: SourceFileSignal[], patterns: RegExp[], limit: number): string[] {
  return files
    .filter((file) => patterns.some((pattern) => pattern.test(file.path)))
    .map((file) => file.path)
    .slice(0, limit);
}

function importantFiles(source: WorkspaceSource, files: SourceFileSignal[]): string[] {
  const candidates = [
    'README.md',
    'package.json',
    'composer.json',
    'artisan',
    'phpunit.xml',
    'Dockerfile',
    'docker-compose.yml',
    'tsconfig.json',
    'next.config.js',
    'next.config.ts',
    'vite.config.ts',
    'tailwind.config.js',
    'tailwind.config.ts',
    'components.json',
  ].filter((file) => source.path && existsSync(join(source.path, file)));
  return [
    ...candidates,
    ...matchingFiles(
      files,
      [
        /(^|\/)(main|index|server|app|bootstrap|Program)\.(tsx?|jsx?|py|go|java|cs|php)$/i,
        /(^|\/)(routes?|controllers?|handlers?|schema|models?|entities|services?)\//i,
      ],
      35,
    ),
  ].slice(0, 45);
}

function contractFiles(files: SourceFileSignal[]): string[] {
  return matchingFiles(
    files,
    [
      /(^|\/)(api|routes?|controllers?|schemas?|dto|contracts?|openapi|swagger|graphql|proto)\b/i,
      /(^|\/)(app\/Http\/Controllers|app\/Models|app\/Services|routes)\//i,
      /(^|\/)(src\/api|src\/services|src\/lib\/api|src\/server|src\/routes)\//i,
    ],
    45,
  );
}

function testFiles(files: SourceFileSignal[]): string[] {
  return matchingFiles(
    files,
    [
      /(^|\/)(__tests__|tests?|specs?)\//i,
      /(\.|-)(test|spec)\.(tsx?|jsx?|php|py|go|rs)$/i,
      /(^|\/)phpunit\.xml$/i,
    ],
    35,
  );
}

function designFiles(files: SourceFileSignal[]): string[] {
  return matchingFiles(
    files,
    [
      /(^|\/)(src\/components|components|src\/styles|src\/theme|src\/design-system)\//i,
      /(^|\/)(tailwind\.config\.(js|ts)|components\.json|global\.css|globals\.css)$/i,
      /(^|\/)(storybook|\.storybook)\//i,
    ],
    50,
  );
}

function componentInventory(files: SourceFileSignal[]): string[] {
  return matchingFiles(
    files,
    [/(\bcomponents\b|src\/components|app\/components|ui)\/.*\.(tsx|jsx|vue|svelte)$/i],
    40,
  );
}

function extractDesignTokens(source: WorkspaceSource): string[] {
  if (!source.path) return [];
  const candidates = [
    'tailwind.config.ts',
    'tailwind.config.js',
    'src/styles/globals.css',
    'src/styles/global.css',
    'src/app/globals.css',
    'app/globals.css',
    'src/index.css',
  ];
  const tokens = new Set<string>();
  for (const file of candidates) {
    const text = readTextFile(source.path, file);
    if (!text) continue;
    const colorMatches = text.match(/#[0-9a-fA-F]{3,8}\b|rgb[a]?\([^)]+\)|hsl[a]?\([^)]+\)/g) ?? [];
    for (const match of colorMatches.slice(0, 18)) tokens.add(match);
    const cssVars = text.match(/--[a-zA-Z0-9-_]+/g) ?? [];
    for (const match of cssVars.slice(0, 24)) tokens.add(match);
    const semanticKeys =
      text.match(
        /\b(primary|secondary|accent|muted|background|foreground|border|ring|card|popover|destructive)\b/g,
      ) ?? [];
    for (const match of semanticKeys.slice(0, 16)) tokens.add(match);
  }
  return [...tokens].slice(0, 40);
}

function formatList(items: string[], empty: string, limit = 20): string[] {
  if (items.length === 0) return [`- ${empty}`];
  return items.slice(0, limit).map((item) => `- ${item}`);
}

function packageScripts(source: WorkspaceSource): string[] {
  const pkg = readJsonFile(source.path, 'package.json') as {
    scripts?: Record<string, string>;
  } | null;
  const composer = readJsonFile(source.path, 'composer.json') as {
    scripts?: Record<string, unknown>;
  } | null;
  return [
    ...Object.keys(pkg?.scripts ?? {}).map((name) => `npm:${name}`),
    ...Object.keys(composer?.scripts ?? {}).map((name) => `composer:${name}`),
  ].slice(0, 16);
}

function stackSignals(source: WorkspaceSource): string[] {
  const hasLocalPath = !!source.path;
  const pkg = readJsonFile(source.path, 'package.json') as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null;
  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };
  const composer = readJsonFile(source.path, 'composer.json') as {
    require?: Record<string, string>;
    'require-dev'?: Record<string, string>;
  } | null;
  const composerDeps = {
    ...(composer?.require ?? {}),
    ...(composer?.['require-dev'] ?? {}),
  };
  const names = Object.keys(deps);
  const phpNames = Object.keys(composerDeps);
  const signals = [
    names.includes('react') ? 'React' : null,
    names.includes('next') || names.includes('next-intl') ? 'Next.js' : null,
    names.includes('vite') ? 'Vite' : null,
    names.includes('tailwindcss') ? 'Tailwind CSS' : null,
    names.includes('react-native') ? 'React Native' : null,
    names.includes('expo') ? 'Expo' : null,
    names.includes('@nestjs/core') ? 'NestJS' : null,
    names.includes('express') ? 'Express' : null,
    names.includes('fastify') ? 'Fastify' : null,
    names.includes('prisma') ? 'Prisma' : null,
    names.includes('drizzle-orm') ? 'Drizzle ORM' : null,
    names.includes('vitest') ? 'Vitest' : null,
    names.includes('jest') ? 'Jest' : null,
    names.includes('@playwright/test') || names.includes('playwright') ? 'Playwright' : null,
    composer ? 'PHP' : null,
    phpNames.includes('laravel/framework') ||
    (hasLocalPath && existsSync(join(source.path!, 'artisan')))
      ? 'Laravel'
      : null,
    phpNames.includes('symfony/framework-bundle') ||
    phpNames.some((name) => name.startsWith('symfony/'))
      ? 'Symfony'
      : null,
    phpNames.includes('livewire/livewire') ? 'Livewire' : null,
    phpNames.includes('inertiajs/inertia-laravel') ? 'Inertia Laravel' : null,
    phpNames.includes('pestphp/pest') ? 'Pest' : null,
    phpNames.includes('phpunit/phpunit') ? 'PHPUnit' : null,
    hasLocalPath && existsSync(join(source.path!, 'composer.json')) ? 'Composer' : null,
    hasLocalPath && existsSync(join(source.path!, 'Dockerfile')) ? 'Docker' : null,
  ].filter((item): item is string => !!item);
  return [...new Set(signals)].slice(0, 14);
}

function knowledgePageSummary(source: WorkspaceSource): string[] {
  const pages = pageRepo
    .listByWorkspace(source.workspaceId, false)
    .filter((page) => page.sourceId === source.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (pages.length === 0) return [];
  const lines = [`- KB pages: ${pages.length}`];
  for (const page of pages.slice(0, 12)) {
    lines.push(`  - [[${page.title}]] (${page.kind}, retrievals=${page.retrievalCount})`);
  }
  if (pages.length > 12)
    lines.push(`  - ...and ${pages.length - 12} more KB pages for this source.`);
  return lines;
}

function embeddingJobSummary(source: WorkspaceSource): string[] {
  const jobs = kbEmbeddingJobRepo
    .listByWorkspace(source.workspaceId, 100)
    .filter((job) => job.sourceId === source.id);
  if (jobs.length === 0) return ['- Embeddings: not queued yet'];
  const latest = jobs[0];
  const progress =
    latest.total > 0
      ? `${latest.current}/${latest.total} (${Math.round((latest.current / latest.total) * 100)}%)`
      : '0/0';
  const finished = latest.completedAt ? `; completedAt=${latest.completedAt}` : '';
  const error = latest.error ? `; error=${latest.error}` : '';
  return [
    `- Embeddings: ${latest.status}; progress=${progress}; reason=${latest.reason}${finished}${error}`,
  ];
}

function designSystemSignals(source: WorkspaceSource): string[] {
  const path = source.path;
  if (!path) return [];
  const candidates = [
    'src/components',
    'src/design-system',
    'src/styles',
    'src/theme',
    'tailwind.config.js',
    'tailwind.config.ts',
    'components.json',
    'storybook.config.ts',
    '.storybook',
  ];
  return candidates.filter((candidate) => existsSync(join(path, candidate))).slice(0, 10);
}

export function inferSourceRole(source: WorkspaceSource): WorkspaceSourceRole | null {
  return inferSourceRoleFromSignals({ source, packageHints: readPackageHints(source.path) });
}

function sourceLine(source: WorkspaceSource, role: WorkspaceSourceRole | null): string {
  const bits = [
    source.isPrimary ? 'primary' : null,
    role ? `role=${role}` : 'role=unclassified',
    source.kind,
  ].filter(Boolean);
  const location = source.path ?? source.repoFullName ?? 'path pending';
  return `- ${source.label} (${bits.join(', ')}) -> ${location}`;
}

function roleForAgent(agent: Agent): WorkspaceSourceRole | 'lead' | 'review' | null {
  return inferAgentCoverageRole(agent);
}

function sourcesForAgent(
  agent: Agent,
  sources: WorkspaceSource[],
  roles: Map<string, WorkspaceSourceRole | null>,
): WorkspaceSource[] {
  const role = roleForAgent(agent);
  if (!role || role === 'lead' || role === 'review') return sources;
  return sources.filter((source) => roles.get(source.id) === role);
}

function buildSourcesInstruction(input: {
  agent: Agent;
  sources: WorkspaceSource[];
  roles: Map<string, WorkspaceSourceRole | null>;
  reason?: string;
}): string {
  const assigned = sourcesForAgent(input.agent, input.sources, input.roles);
  const agentRole = roleForAgent(input.agent);
  return [
    '# Workspace Sources',
    '',
    'This file is maintained automatically by Orkestral whenever a source is added, removed, cloned, or reclassified.',
    input.reason ? `Last sync reason: ${input.reason}` : null,
    '',
    '## All Sources',
    '',
    ...input.sources.map((source) => sourceLine(source, input.roles.get(source.id) ?? null)),
    '',
    '## Your Focus',
    '',
    agentRole === 'lead'
      ? 'You coordinate all sources and keep cross-repo architecture coherent.'
      : agentRole === 'review'
        ? 'You review changes across all sources, especially cross-repo contracts.'
        : assigned.length > 0
          ? 'Prioritize these sources for your role:'
          : 'No source is classified for your role yet. Use list_sources before planning work.',
    ...(assigned.length > 0
      ? ['', ...assigned.map((source) => sourceLine(source, input.roles.get(source.id) ?? null))]
      : []),
    '',
    '## Operating Rules',
    '',
    '- Call list_sources before planning cross-repo work.',
    '- If a source is new or its KB looks incomplete, ask the CEO to run source analysis.',
    '- When you learn a non-obvious source convention, save it as an agent-memory KB page.',
    '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function sourceProfileLine(
  source: WorkspaceSource,
  role: WorkspaceSourceRole | null,
  dossiers?: Map<string, SourceContextDossier>,
): string {
  const dossier = dossiers?.get(source.id) ?? buildSourceContextDossier(source, role);
  const stack = dossier.stack;
  const scripts = dossier.scripts;
  const design = dossier.design;
  const files = dossier.files;
  const dirs = dossier.dirs;
  const important = dossier.important;
  const contracts = dossier.contracts;
  const tests = dossier.tests;
  const designRelated = dossier.designRelated;
  const components = dossier.components;
  const tokens = dossier.tokens;
  return [
    `### ${source.label}`,
    '',
    `- Role: ${role ?? 'unclassified'}`,
    `- Location: ${source.path ?? source.repoFullName ?? 'path pending'}`,
    `- Files mapped for context: ${files.length}${files.length >= MAX_CONTEXT_FILES ? `+ (limited at ${MAX_CONTEXT_FILES})` : ''}`,
    stack.length ? `- Stack signals: ${stack.join(', ')}` : '- Stack signals: not detected yet',
    scripts.length ? `- Scripts: ${scripts.join(', ')}` : '- Scripts: not detected yet',
    design.length ? `- Design-system signals: ${design.join(', ')}` : null,
    ...dossier.knowledge,
    ...dossier.embeddingLines,
    dossier.hasAgentsMd ? '- Repo has its own AGENTS.md; read it before editing.' : null,
    dossier.hasClaudeMd ? '- Repo has CLAUDE.md; read it before editing.' : null,
    '',
    '#### Top directories',
    ...formatList(dirs, 'No directory map detected.', 12),
    '',
    '#### Important files to inspect first',
    ...formatList(important, 'No important files detected yet.', 28),
    '',
    '#### Contract/API files',
    ...formatList(contracts, 'No contract/API files detected yet.', 28),
    '',
    '#### Test/QA files',
    ...formatList(tests, 'No test files detected yet.', 24),
    designRelated.length > 0 || components.length > 0 || tokens.length > 0 ? '' : null,
    designRelated.length > 0 || components.length > 0 || tokens.length > 0
      ? '#### Design system / UI inventory'
      : null,
    ...(designRelated.length > 0 ? ['Design files:', ...formatList(designRelated, '', 22)] : []),
    ...(components.length > 0 ? ['Components:', ...formatList(components, '', 28)] : []),
    ...(tokens.length > 0 ? [`Tokens/colors: ${tokens.join(', ')}`] : []),
  ]
    .filter((line): line is string => !!line)
    .join('\n');
}

function sourceOverviewLine(
  source: WorkspaceSource,
  role: WorkspaceSourceRole | null,
  dossiers?: Map<string, SourceContextDossier>,
): string {
  const dossier = dossiers?.get(source.id) ?? buildSourceContextDossier(source, role);
  const stack = dossier.stack;
  const scripts = dossier.scripts;
  const files = dossier.files;
  const kbPages = dossier.kbPageCount;
  const embedding = dossier.embeddingStatus;
  return [
    `- ${source.label}: role=${role ?? 'unclassified'}; stack=${stack.join(', ') || 'unknown'}; scripts=${scripts.slice(0, 8).join(', ') || 'none'}; mappedFiles=${files.length}; kbPages=${kbPages}; embeddings=${embedding}; location=${source.path ?? source.repoFullName ?? 'path pending'}`,
  ].join('\n');
}

function roleOperatingRules(agent: Agent): string[] {
  const role = roleForAgent(agent);
  const key = `${agent.role} ${agent.name} ${agent.title ?? ''}`.toLowerCase();
  if (role === 'review' || /code[-\s_]?review|reviewer/.test(key)) {
    return [
      'Act as the cross-repo quality gate: architecture, contracts, security, tests, performance and cost.',
      'For linked frontend/backend work, validate payload shape, status codes, auth assumptions and deploy ordering.',
      'Prefer a small number of high-impact findings over generic style comments.',
    ];
  }
  if (/\bqa\b|quality|test/.test(key)) {
    return [
      'Own smoke-test confidence. Find the fastest reliable verification path for each source.',
      'For UI/mobile work, include design-system, responsiveness and basic accessibility checks.',
      'For backend work, validate API behavior, data persistence and frontend contract expectations.',
    ];
  }
  if (/design|designer|ux|ui[-\s_]?designer/.test(key)) {
    return [
      'Own design-system consistency, accessibility, hierarchy, spacing, responsiveness and interaction quality.',
      'Before giving UI guidance, inspect existing components/styles and follow the established system.',
      'Escalate if implementation drifts from the product experience or visual language.',
    ];
  }
  if (role === 'lead') {
    return [
      'Coordinate all sources as one architecture. Split work by source and assign to the right owner.',
      'Keep contracts between repos explicit and ask Code Reviewer/QA to validate risky changes.',
      'Make sure source-specific specialists update KB when they learn durable conventions.',
    ];
  }
  if (role === 'frontend') {
    return [
      'Own web UI, browser behavior, design-system implementation, client state and frontend contracts.',
      'Before editing UI, inspect existing components, tokens/styles and nearby screens.',
    ];
  }
  if (role === 'mobile') {
    return [
      'Own mobile runtime, navigation, platform build, device UX and app-specific design-system differences.',
      'Do not treat mobile as just web frontend; verify mobile constraints explicitly.',
    ];
  }
  if (role === 'backend') {
    return [
      'Own APIs, services, persistence, business rules, integrations and backend/frontend contracts.',
      'Before editing endpoints or DTOs, validate consumers in frontend/mobile sources when present.',
    ];
  }
  if (role === 'infra') {
    return [
      'Own CI/CD, deployments, containers, environments, secrets handling and operational reliability.',
      'Verify local scripts and pipeline assumptions before proposing infra changes.',
    ];
  }
  return [
    'Use the source role and KB context to stay inside your domain. Escalate unclear ownership to the CEO.',
  ];
}

function buildRepoContextInstruction(input: {
  agent: Agent;
  sources: WorkspaceSource[];
  roles: Map<string, WorkspaceSourceRole | null>;
  dossiers?: Map<string, SourceContextDossier>;
  reason?: string;
}): string {
  const assigned = sourcesForAgent(input.agent, input.sources, input.roles);
  const visible = assigned.length > 0 ? assigned : input.sources;
  return [
    '# Repo Intelligence',
    '',
    'This file is maintained automatically by Orkestral from connected sources.',
    input.reason ? `Last sync reason: ${input.reason}` : null,
    '',
    '## Your Operating Contract',
    '',
    ...roleOperatingRules(input.agent).map((line) => `- ${line}`),
    '',
    '## All Connected Sources Overview',
    '',
    ...input.sources.map((source) =>
      sourceOverviewLine(source, input.roles.get(source.id) ?? null, input.dossiers),
    ),
    '',
    '## Deep Source Dossier',
    '',
    assigned.length > 0
      ? 'The detailed sections below are your primary domain. Use the overview above for cross-repo context.'
      : 'The detailed sections below cover every connected source because this role is cross-repo.',
    '',
    ...visible.map((source) =>
      sourceProfileLine(source, input.roles.get(source.id) ?? null, input.dossiers),
    ),
    '',
    '## How to use this dossier',
    '',
    '- When it points to a file, read that exact file before changing or judging that area.',
    '- For cross-repo changes, inspect every source in the overview and validate contracts between them.',
    '- If the KB for the target source looks incomplete, ask the CEO to run source analysis before making broad claims.',
    '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function patchEntryRepoIntelligence(agent: Agent, repoContext: string): void {
  const current = readEntryInstruction(agent.workspaceId, agent.id);
  if (!current) return;
  const block = [
    ENTRY_CONTEXT_START,
    '## Repo Intelligence Files',
    '',
    'Orkestral maintains additional local instruction files for this agent:',
    '',
    '- `SOURCES.md`: all connected workspace sources and your source focus.',
    '- `REPO_CONTEXT.md`: stack signals, scripts, design-system hints and role-specific operating rules.',
    '',
    'Consult them when the task touches a source; if it crosses repos, inspect every affected source and verify contracts between them.',
    '',
    repoContext
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('- Role:') ||
          line.startsWith('- Stack signals:') ||
          line.startsWith('- Scripts:'),
      )
      .slice(0, 9)
      .join('\n'),
    ENTRY_CONTEXT_END,
  ]
    .filter(Boolean)
    .join('\n');
  const rx = new RegExp(
    `\\n*${escapeRegex(ENTRY_CONTEXT_START)}[\\s\\S]*?${escapeRegex(ENTRY_CONTEXT_END)}`,
    'g',
  );
  const next = `${current.replace(rx, '').trim()}\n\n${block}\n`;
  if (next !== current) {
    writeInstruction(agent.workspaceId, agent.id, 'AGENTS.md', next);
  }
}

function buildCapabilityBlock(assigned: WorkspaceSource[]): string {
  const labels = assigned.map((source) => source.label).join(', ') || 'no classified source yet';
  return [
    CAP_BLOCK_START,
    `Source awareness: ${labels}.`,
    'Use list_sources before source-specific work when the target repo is unclear.',
    CAP_BLOCK_END,
  ].join('\n');
}

function logMissingSpecialistProposals(input: {
  workspaceId: string;
  sources: WorkspaceSource[];
  agents: Agent[];
  roles: Map<string, WorkspaceSourceRole | null>;
  reason: string;
  /** Quando a proposta nasce de uma aprovação no chat, propaga a sessão pra ela
   *  também aparecer inline no chat (o Inbox segue mostrando, é workspace-scoped). */
  originSessionId?: string;
}): void {
  // Não propõe especialista de source enquanto o time inicial não existe (só o
  // CEO). Nesse momento quem cobre as sources é a PROPOSTA do CEO (plano de
  // contratação completo). Sem essa guarda, aparecia um "Frontend solto" no
  // Inbox antes mesmo do CEO propor o time — exatamente o que confundia.
  const hasInitialTeam = input.agents.some((agent) => !agent.isOrchestrator);
  if (!hasInitialTeam) return;
  const assignments = planSourceAgentAssignments({
    sources: input.sources,
    agents: input.agents,
    packageHintsBySourceId: Object.fromEntries(
      input.sources.map((source) => [source.id, readPackageHints(source.path)]),
    ),
  });
  const existing = activityRepo
    .listByWorkspace(input.workspaceId, 500)
    .filter((entry) => entry.kind === 'proposal.pending');
  for (const assignment of assignments) {
    if (!assignment.needsNewAgent || !assignment.recommendedAgentRole) continue;
    const alreadyPending = existing.some((entry) => {
      const payload = entry.payload as { type?: string; sourceId?: string } | undefined;
      return payload?.type === 'source-specialist' && payload.sourceId === assignment.sourceId;
    });
    if (alreadyPending) continue;
    const title = `Aprovar agente ${assignment.recommendedAgentName} para ${assignment.sourceLabel}`;
    activityRepo.log({
      workspaceId: input.workspaceId,
      kind: 'proposal.pending',
      actorKind: 'system',
      subjectKind: 'source',
      subjectId: assignment.sourceId,
      title,
      payload: {
        type: 'source-specialist',
        sourceId: assignment.sourceId,
        sourceLabel: assignment.sourceLabel,
        sourceRole: assignment.sourceRole,
        recommendedAgentRole: assignment.recommendedAgentRole,
        recommendedAgentName: assignment.recommendedAgentName,
        reason: assignment.reason,
        syncReason: input.reason,
        ...(input.originSessionId ? { originSessionId: input.originSessionId } : {}),
      },
    });
    // Notifica o renderer pra um toast com ação (Aprovar) onde quer que o
    // usuário esteja — sem precisar abrir a Caixa de entrada.
    broadcast('inbox:proposal-created', {
      workspaceId: input.workspaceId,
      sourceId: assignment.sourceId,
      sourceLabel: assignment.sourceLabel,
      recommendedAgentName: assignment.recommendedAgentName,
      title,
    });
  }
}

/**
 * Conserta roles de source provavelmente erradas: quando o NOME do repo indica
 * claramente uma role web/app (frontend/backend/mobile) que CONTRADIZ a salva.
 * Só mexe nessas auto-inferidas — nunca em roles deliberadas (infra/docs/other)
 * nem em sources sem role. Roda no boot pra corrigir classificações antigas do
 * bug `axios`→mobile. Idempotente. Retorna quantas corrigiu.
 */
const AUTO_INFERRED_ROLES = new Set<WorkspaceSourceRole>(['frontend', 'backend', 'mobile']);

export function reconcileSourceRolesByName(workspaceId: string): number {
  let fixed = 0;
  for (const source of sourceRepo.listByWorkspace(workspaceId)) {
    const current = source.role;
    if (!current || !AUTO_INFERRED_ROLES.has(current)) continue;
    const nameRole = normalizeSourceRole(
      [source.label, source.repoFullName].filter(Boolean).join(' '),
    );
    if (!nameRole || !AUTO_INFERRED_ROLES.has(nameRole) || nameRole === current) continue;
    sourceRepo.update(source.id, { role: nameRole });
    fixed++;
    console.log(
      `[source-role] corrigido "${source.label}": ${current} → ${nameRole} (nome contradiz a role salva)`,
    );
  }
  return fixed;
}

export function syncWorkspaceTeamForSources(
  workspaceId: string,
  reason = 'source-sync',
  originSessionId?: string,
): void {
  const sources = sourceRepo.listByWorkspace(workspaceId);
  // NÃO cria o squad core (TechLead/Code Reviewer/QA/Designer) aqui. Antes este
  // sync seedava o time em TODO boot/onboarding/source-add — então os agentes
  // apareciam ANTES de qualquer análise, sem o CEO propor. O squad agora nasce
  // só quando o usuário aprova o plano de contratação do CEO
  // (materializeApprovedHiringPlan → ensureWorkspaceCoreSquad). Este sync segue
  // cuidando só do mapeamento source→agente e das propostas de especialista.
  const agents = agentRepo.listByWorkspace(workspaceId);
  const roles = new Map<string, WorkspaceSourceRole | null>();

  for (const source of sources) {
    const inferred = inferSourceRole(source);
    roles.set(source.id, inferred);
    if (inferred && source.role !== inferred) {
      sourceRepo.update(source.id, { role: inferred });
      source.role = inferred;
      roles.set(source.id, inferred);
    }
  }

  const dossiers = buildSourceContextDossiers(sources, roles);

  for (const agent of agents) {
    try {
      ensureDefaultInstructions(agent);
      const assigned = sourcesForAgent(agent, sources, roles);
      writeInstruction(
        agent.workspaceId,
        agent.id,
        'SOURCES.md',
        buildSourcesInstruction({ agent, sources, roles, reason }),
      );
      const repoContext = buildRepoContextInstruction({ agent, sources, roles, dossiers, reason });
      writeInstruction(agent.workspaceId, agent.id, 'REPO_CONTEXT.md', repoContext);
      patchEntryRepoIntelligence(agent, repoContext);
      const base = stripAutoBlock(agent.capabilities);
      const block = buildCapabilityBlock(assigned);
      agentRepo.update(agent.id, {
        capabilities: [base, block].filter(Boolean).join('\n\n'),
      });
    } catch (err) {
      console.warn('[source-team-sync] falhou sincronizar agente:', agent.name, err);
    }
  }

  try {
    logMissingSpecialistProposals({ workspaceId, sources, agents, roles, reason, originSessionId });
  } catch (err) {
    console.warn('[source-team-sync] falhou criar propostas de especialista:', err);
  }

  try {
    activityRepo.log({
      workspaceId,
      kind: 'team.sources.synced',
      actorKind: 'system',
      subjectKind: 'workspace',
      subjectId: workspaceId,
      title: 'Time sincronizado com os sources do workspace',
      payload: {
        reason,
        sourceCount: sources.length,
        agentCount: agents.length,
      },
    });
  } catch {
    // best-effort
  }
}
