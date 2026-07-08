/**
 * Fonte viva de skills a partir de repositórios no GitHub que seguem o padrão
 * Agent Skills (pastas com `SKILL.md` + frontmatter name/description).
 *
 * Não existe um registro público de skills equivalente ao PulseMCP dos MCPs —
 * então puxamos direto dos repos canônicos:
 *   - anthropics/skills  (skills oficiais de exemplo)
 *
 * 1 request na árvore (GitHub API) + N leituras de SKILL.md via raw
 * (raw.githubusercontent.com, fora do rate limit da API). Cacheado por 30min.
 */
import type { MarketplaceCatalogItem } from '../../shared/types';

interface SkillRepoSpec {
  owner: string;
  repo: string;
  category: string;
  author: string;
}

const SKILL_REPOS: SkillRepoSpec[] = [
  { owner: 'anthropics', repo: 'skills', category: 'Anthropic', author: 'Anthropic' },
];

interface GhTreeEntry {
  path: string;
  type: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Extrai name/description do frontmatter YAML e o corpo do SKILL.md. */
function parseSkillMd(md: string): { name?: string; description?: string; body: string } {
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!fm) return { body: md.trim() };
  const front = fm[1];
  const body = fm[2].trim();
  const grab = (key: string): string | undefined => {
    const m = front.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'im'));
    if (!m) return undefined;
    return m[1].trim().replace(/^["']|["']$/g, '');
  };
  return { name: grab('name'), description: grab('description'), body };
}

async function fetchRepoSkills(spec: SkillRepoSpec): Promise<MarketplaceCatalogItem[]> {
  const treeUrl = `https://api.github.com/repos/${spec.owner}/${spec.repo}/git/trees/HEAD?recursive=1`;
  const res = await fetch(treeUrl, {
    headers: { 'User-Agent': 'Orkestral/0.1', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { tree?: GhTreeEntry[] };
  const skillPaths = (data.tree ?? [])
    .filter((e) => e.type === 'blob' && /(^|\/)SKILL\.md$/i.test(e.path))
    .map((e) => e.path)
    .slice(0, 40);

  const items = await Promise.all(
    skillPaths.map(async (path): Promise<MarketplaceCatalogItem | null> => {
      try {
        const rawUrl = `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/HEAD/${path}`;
        const r = await fetch(rawUrl, {
          headers: { 'User-Agent': 'Orkestral/0.1' },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return null;
        const md = await r.text();
        const { name, description, body } = parseSkillMd(md);
        const dir =
          path
            .replace(/\/SKILL\.md$/i, '')
            .split('/')
            .pop() ?? path;
        const finalName = name ?? dir;
        const slug = slugify(`${spec.repo}-${dir}`);
        return {
          id: `gh.${spec.owner}.${slug}`,
          kind: 'skill' as const,
          name: finalName,
          slug,
          description: description ?? `Skill do repositório ${spec.owner}/${spec.repo}.`,
          longDescription: description,
          readme: body,
          category: spec.category,
          author: spec.author,
          iconKey: 'Sparkles',
          repoUrl: `https://github.com/${spec.owner}/${spec.repo}/tree/HEAD/${path.replace(/\/SKILL\.md$/i, '')}`,
          sourceUrl: `https://github.com/${spec.owner}/${spec.repo}`,
          provider: 'github',
          install: {
            skillKind: 'instruction' as const,
            contentTemplate: body || `# ${finalName}\n\n${description ?? ''}`,
            config: {},
          },
        } satisfies MarketplaceCatalogItem;
      } catch {
        return null;
      }
    }),
  );
  return items.filter((x): x is MarketplaceCatalogItem => x !== null);
}

let cache: { items: MarketplaceCatalogItem[]; ts: number } | null = null;
const TTL_MS = 30 * 60_000;

/** Skills vivas dos repos GitHub (cacheadas). Falha silenciosa → []. */
export async function fetchGithubSkills(): Promise<MarketplaceCatalogItem[]> {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) return cache.items;
  try {
    const all = (await Promise.all(SKILL_REPOS.map(fetchRepoSkills))).flat();
    if (all.length > 0) cache = { items: all, ts: now };
    return all;
  } catch {
    return cache?.items ?? [];
  }
}
