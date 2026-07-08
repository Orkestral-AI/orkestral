/**
 * Catálogo curado do marketplace de Skills + MCP servers do Orkestral.
 *
 * Por que bundlado (em vez de só fetch remoto):
 *   - Funciona offline e sempre tem dados ricos pros cards.
 *   - Os comandos de instalação (`npx ...`) são verificados — o botão "Instalar"
 *     realmente funciona em vez de depender de um registro externo que pode
 *     mudar/cair/bloquear.
 *
 * O `marketplace:list` faz merge deste catálogo com uma fonte remota opcional
 * (env ORKESTRAL_MARKETPLACE_*_API) quando disponível.
 *
 * Instalação por modelo: o spec do MCP aqui é AGNÓSTICO de runtime. O
 * chat-service projeta `config.mcpServer` pro formato do adapter ativo (Claude
 * `--mcp-config`, Codex `-c mcp_servers.*`). Por isso trocar o modelo de um
 * agente (codex ↔ claude) mantém o MCP funcionando.
 *
 * Templating de args: tokens `{ENV_KEY}` em `mcpServer.args` são substituídos
 * pelos valores coletados na instalação (ver marketplace:install). Útil pra
 * servers que recebem a credencial como argumento de linha de comando.
 */

import type { MarketplaceCatalogItem, MarketplaceRequiredEnv } from '../../shared/types';

const NPX = 'npx';

interface McpSeed {
  slug: string;
  name: string;
  tagline: string;
  longDescription: string;
  category: string;
  author: string;
  iconKey: string;
  accent?: string;
  tags: string[];
  repoUrl?: string;
  homepageUrl?: string;
  featured?: boolean;
  stars?: number;
  /** stdio: pacote npm rodado via `npx -y <pkg> <...extraArgs>`. */
  pkg?: string;
  extraArgs?: string[];
  /** http/sse: url do server remoto + headers opcionais. */
  url?: string;
  transport?: 'stdio' | 'http' | 'sse';
  requiredEnv?: MarketplaceRequiredEnv[];
  readme?: string;
}

// Serviços hospedados que exigem conta/API key e podem cobrar (tier grátis +
// planos pagos). MCPs livres/open-source (github, slack, filesystem…) ficam de
// fora — exigir um token grátis não é o mesmo que ser pago.
const FREEMIUM_SLUGS = new Set([
  'brave-search',
  'exa',
  'tavily',
  'firecrawl',
  'supabase',
  'apify',
  'e2b',
  'figma',
]);
// Cobrança por uso obrigatória (sem tier grátis prático).
const PAID_SLUGS = new Set(['google-maps']);

function pricingFor(slug: string): 'free' | 'freemium' | 'paid' {
  if (PAID_SLUGS.has(slug)) return 'paid';
  if (FREEMIUM_SLUGS.has(slug)) return 'freemium';
  return 'free';
}

function mcp(seed: McpSeed): MarketplaceCatalogItem {
  const transport = seed.transport ?? (seed.url ? 'http' : 'stdio');
  const mcpServer: Record<string, unknown> =
    transport === 'stdio'
      ? {
          command: NPX,
          args: ['-y', seed.pkg, ...(seed.extraArgs ?? [])],
          env: {},
        }
      : { url: seed.url, headers: {} };

  return {
    id: `mcp.${seed.slug}`,
    kind: 'mcp',
    name: seed.name,
    slug: seed.slug,
    description: seed.tagline,
    longDescription: seed.longDescription,
    readme: seed.readme,
    category: seed.category,
    tags: seed.tags,
    author: seed.author,
    iconKey: seed.iconKey,
    accent: seed.accent,
    homepageUrl: seed.homepageUrl,
    repoUrl: seed.repoUrl,
    sourceUrl: seed.homepageUrl ?? seed.repoUrl ?? 'https://modelcontextprotocol.io',
    provider: 'orkestral',
    featured: seed.featured,
    stars: seed.stars,
    pricing: pricingFor(seed.slug),
    transport,
    requiredEnv: seed.requiredEnv,
    install: {
      skillKind: 'mcp',
      contentTemplate: `# ${seed.name}\n\n${seed.longDescription}`,
      config: { mcpServer },
    },
  };
}

interface SkillSeed {
  slug: string;
  name: string;
  tagline: string;
  category: string;
  author: string;
  iconKey: string;
  accent?: string;
  tags: string[];
  featured?: boolean;
  content: string;
}

function skill(seed: SkillSeed): MarketplaceCatalogItem {
  return {
    id: `skill.${seed.slug}`,
    kind: 'skill',
    name: seed.name,
    slug: seed.slug,
    description: seed.tagline,
    longDescription: seed.tagline,
    readme: seed.content,
    category: seed.category,
    tags: seed.tags,
    author: seed.author,
    iconKey: seed.iconKey,
    accent: seed.accent,
    sourceUrl: 'https://orkestral.ai/skills',
    provider: 'orkestral',
    featured: seed.featured,
    install: {
      skillKind: 'instruction',
      contentTemplate: seed.content,
      config: {},
    },
  };
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

const MCPS: MarketplaceCatalogItem[] = [
  mcp({
    slug: 'context7',
    name: 'Context7',
    tagline: 'Documentação e exemplos de código atualizados pros LLMs.',
    longDescription:
      'Injeta documentação e exemplos de código sempre atualizados, direto da fonte, no contexto do agente. Acaba com APIs alucinadas e exemplos desatualizados — o agente lê a doc real da versão que você usa.',
    category: 'Developer Tools',
    author: 'Upstash',
    iconKey: 'BookOpen',
    accent: 'accent-blue',
    tags: ['docs', 'rag', 'coding'],
    pkg: '@upstash/context7-mcp',
    repoUrl: 'https://github.com/upstash/context7',
    homepageUrl: 'https://context7.com',
    featured: true,
    stars: 56000,
    requiredEnv: [
      {
        key: 'CONTEXT7_API_KEY',
        label: 'Context7 API Key',
        description: 'Opcional — aumenta o rate limit. Deixe em branco pra usar o tier gratuito.',
        required: false,
        link: 'https://context7.com/dashboard',
        placeholder: 'ctx7_...',
      },
    ],
    readme:
      '## O que faz\n\nO Context7 busca documentação versionada de milhares de bibliotecas e injeta os trechos relevantes no prompt. Basta pedir "use context7" ou deixar o agente decidir.\n\n## Ferramentas\n\n- `resolve-library-id` — encontra a lib pelo nome\n- `get-library-docs` — puxa a doc do tópico pedido',
  }),
  mcp({
    slug: 'shadcn',
    name: 'shadcn',
    tagline: 'Blocks e componentes prontos do shadcn (e registries como 21st.dev).',
    longDescription:
      'Dá ao agente o registry do shadcn: buscar, ver e ADICIONAR blocks e componentes JÁ POLIDOS (dashboards, sidebars, login/signup, tabelas, charts) em vez de montar shadcn cru. Suporta registries de terceiros como o 21st.dev. Resultado: UI premium por padrão, sem reinventar do zero.',
    category: 'Developer Tools',
    author: 'shadcn',
    iconKey: 'LayoutDashboard',
    accent: 'accent-purple',
    tags: ['ui', 'design', 'shadcn', 'frontend'],
    pkg: 'shadcn@latest',
    extraArgs: ['mcp'],
    repoUrl: 'https://github.com/shadcn-ui/ui',
    homepageUrl: 'https://ui.shadcn.com/docs/mcp',
    featured: true,
    stars: 70000,
    readme:
      '## O que faz\n\nExpõe o registry do shadcn pro agente: buscar, ver e ADICIONAR blocks e componentes prontos (ui.shadcn.com/blocks) + registries de terceiros (21st.dev). O agente monta telas premium reaproveitando blocks polidos em vez de shadcn cru.\n\n## Quando usar\n\nSempre que for gerar UI do zero (dashboard, auth, app shell). Combina com `npx shadcn add <block>`.',
  }),
  mcp({
    slug: 'sequential-thinking',
    name: 'Sequential Thinking',
    tagline: 'Raciocínio estruturado passo a passo pra problemas complexos.',
    longDescription:
      'Dá ao agente uma ferramenta de pensamento estruturado: ele quebra o problema em passos numerados, revisa hipóteses e ramifica caminhos antes de agir. Melhora muito tarefas de planejamento e debugging.',
    category: 'Productivity & Workflow',
    author: 'Anthropic',
    iconKey: 'Brain',
    accent: 'accent-purple',
    tags: ['reasoning', 'planning'],
    pkg: '@modelcontextprotocol/server-sequential-thinking',
    repoUrl: 'https://github.com/modelcontextprotocol/servers',
    homepageUrl: 'https://modelcontextprotocol.io',
    featured: true,
    stars: 12000,
  }),
  mcp({
    slug: 'memory',
    name: 'Knowledge Graph Memory',
    tagline: 'Memória persistente em grafo de conhecimento entre sessões.',
    longDescription:
      'Memória de longo prazo baseada em grafo: o agente cria entidades, relações e observações que persistem entre conversas. Útil pra lembrar preferências, decisões e contexto do projeto.',
    category: 'Productivity & Workflow',
    author: 'Anthropic',
    iconKey: 'Network',
    accent: 'accent-green',
    tags: ['memory', 'knowledge-graph'],
    pkg: '@modelcontextprotocol/server-memory',
    repoUrl: 'https://github.com/modelcontextprotocol/servers',
    stars: 8000,
  }),
  mcp({
    slug: 'filesystem',
    name: 'Filesystem',
    tagline: 'Leitura/escrita de arquivos com controle de acesso.',
    longDescription:
      'Acesso seguro ao sistema de arquivos do diretório de trabalho: ler, escrever, mover, buscar e listar arquivos. O acesso é restrito ao diretório atual do agente.',
    category: 'Developer Tools',
    author: 'Anthropic',
    iconKey: 'FolderTree',
    accent: 'accent-yellow',
    tags: ['files', 'io'],
    pkg: '@modelcontextprotocol/server-filesystem',
    extraArgs: ['.'],
    repoUrl: 'https://github.com/modelcontextprotocol/servers',
    stars: 9000,
  }),
  mcp({
    slug: 'github',
    name: 'GitHub',
    tagline: 'Issues, PRs, repos e code search via API do GitHub.',
    longDescription:
      'Conecta o agente à API do GitHub: gerenciar issues e pull requests, ler/escrever arquivos, buscar código, revisar PRs e disparar workflows. Indispensável pra fluxos de desenvolvimento.',
    category: 'Developer Tools',
    author: 'GitHub',
    iconKey: 'Github',
    tags: ['git', 'github', 'ci'],
    pkg: '@modelcontextprotocol/server-github',
    repoUrl: 'https://github.com/modelcontextprotocol/servers',
    featured: true,
    stars: 52000,
    requiredEnv: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'GitHub Personal Access Token',
        description: 'Token com escopo `repo` (e `workflow` se for disparar Actions).',
        link: 'https://github.com/settings/tokens',
        placeholder: 'ghp_...',
      },
    ],
  }),
  mcp({
    slug: 'gitlab',
    name: 'GitLab',
    tagline: 'Projetos, MRs e issues via API do GitLab.',
    longDescription:
      'Integração com GitLab: gerenciar merge requests, issues, arquivos e pipelines. Suporta instâncias self-hosted via GITLAB_API_URL.',
    category: 'Developer Tools',
    author: 'Anthropic',
    iconKey: 'Gitlab',
    accent: 'accent-orange',
    tags: ['git', 'gitlab'],
    pkg: '@modelcontextprotocol/server-gitlab',
    repoUrl: 'https://github.com/modelcontextprotocol/servers',
    stars: 4000,
    requiredEnv: [
      {
        key: 'GITLAB_PERSONAL_ACCESS_TOKEN',
        label: 'GitLab Token',
        link: 'https://gitlab.com/-/profile/personal_access_tokens',
        placeholder: 'glpat-...',
      },
      {
        key: 'GITLAB_API_URL',
        label: 'GitLab API URL',
        description: 'Opcional — só pra instâncias self-hosted.',
        required: false,
        secret: false,
        placeholder: 'https://gitlab.com/api/v4',
      },
    ],
  }),
  mcp({
    slug: 'playwright',
    name: 'Playwright',
    tagline: 'Automação de browser confiável via árvore de acessibilidade.',
    longDescription:
      'Controla um browser real com Playwright: navegar, clicar, preencher formulários, tirar screenshots e extrair dados. Usa a árvore de acessibilidade (não pixels), então é rápido e determinístico.',
    category: 'Browser Automation',
    author: 'Microsoft',
    iconKey: 'Globe',
    accent: 'accent-green',
    tags: ['browser', 'e2e', 'scraping'],
    pkg: '@playwright/mcp@latest',
    repoUrl: 'https://github.com/microsoft/playwright-mcp',
    featured: true,
    stars: 18000,
  }),
  mcp({
    slug: 'puppeteer',
    name: 'Puppeteer',
    tagline: 'Automação de browser headless com Chromium.',
    longDescription:
      'Automação de browser via Puppeteer: navegação, screenshots, execução de JS na página e scraping. Boa alternativa quando você já vive no ecossistema Chromium.',
    category: 'Browser Automation',
    author: 'Anthropic',
    iconKey: 'Globe',
    tags: ['browser', 'scraping'],
    pkg: '@modelcontextprotocol/server-puppeteer',
    repoUrl: 'https://github.com/modelcontextprotocol/servers',
    stars: 6000,
  }),
  mcp({
    slug: 'brave-search',
    name: 'Brave Search',
    tagline: 'Busca web e local com a API privada da Brave.',
    longDescription:
      'Dá ao agente busca na web em tempo real via Brave Search API — resultados web e locais, com foco em privacidade. Ótimo pra grounding de respostas em informação atual.',
    category: 'Search & Web',
    author: 'Brave',
    iconKey: 'Search',
    accent: 'accent-orange',
    tags: ['search', 'web'],
    pkg: '@modelcontextprotocol/server-brave-search',
    repoUrl: 'https://github.com/modelcontextprotocol/servers',
    featured: true,
    stars: 7000,
    requiredEnv: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave Search API Key',
        link: 'https://brave.com/search/api/',
        placeholder: 'BSA...',
      },
    ],
  }),
  mcp({
    slug: 'exa',
    name: 'Exa Search',
    tagline: 'Busca neural feita pra agentes de IA.',
    longDescription:
      'Exa é um motor de busca desenhado pra LLMs: busca semântica, leitura de conteúdo de páginas e descoberta de fontes. Retorna conteúdo limpo pronto pro contexto.',
    category: 'Search & Web',
    author: 'Exa',
    iconKey: 'Search',
    accent: 'accent-blue',
    tags: ['search', 'web', 'ai'],
    pkg: 'exa-mcp-server',
    repoUrl: 'https://github.com/exa-labs/exa-mcp-server',
    homepageUrl: 'https://exa.ai',
    stars: 3000,
    requiredEnv: [
      { key: 'EXA_API_KEY', label: 'Exa API Key', link: 'https://dashboard.exa.ai/api-keys' },
    ],
  }),
  mcp({
    slug: 'tavily',
    name: 'Tavily',
    tagline: 'Busca e extração web otimizada pra RAG.',
    longDescription:
      'Tavily entrega busca web e extração de conteúdo otimizadas pra agentes e pipelines RAG — resultados concisos, citáveis e prontos pro contexto.',
    category: 'Search & Web',
    author: 'Tavily',
    iconKey: 'Search',
    tags: ['search', 'rag'],
    pkg: 'tavily-mcp@latest',
    repoUrl: 'https://github.com/tavily-ai/tavily-mcp',
    homepageUrl: 'https://tavily.com',
    stars: 2500,
    requiredEnv: [
      {
        key: 'TAVILY_API_KEY',
        label: 'Tavily API Key',
        link: 'https://app.tavily.com/home',
        placeholder: 'tvly-...',
      },
    ],
  }),
  mcp({
    slug: 'firecrawl',
    name: 'Firecrawl',
    tagline: 'Scraping e crawling de sites em markdown limpo.',
    longDescription:
      'Firecrawl transforma qualquer site em markdown limpo: scraping de páginas, crawling de domínios inteiros e extração estruturada. Lida com JS, paginação e anti-bot.',
    category: 'Search & Web',
    author: 'Mendable',
    iconKey: 'Globe',
    accent: 'accent-orange',
    tags: ['scraping', 'crawler', 'web'],
    pkg: 'firecrawl-mcp',
    repoUrl: 'https://github.com/mendableai/firecrawl-mcp-server',
    homepageUrl: 'https://firecrawl.dev',
    stars: 4000,
    requiredEnv: [
      {
        key: 'FIRECRAWL_API_KEY',
        label: 'Firecrawl API Key',
        link: 'https://firecrawl.dev/app/api-keys',
        placeholder: 'fc-...',
      },
    ],
  }),
  mcp({
    slug: 'postgres',
    name: 'PostgreSQL',
    tagline: 'Consultas read-only e inspeção de schema em Postgres.',
    longDescription:
      'Conecta o agente a um banco PostgreSQL: inspecionar schema, listar tabelas e rodar consultas SQL read-only com segurança. A connection string fica só na config local.',
    category: 'Data & APIs',
    author: 'Anthropic',
    iconKey: 'Database',
    accent: 'accent-blue',
    tags: ['database', 'sql', 'postgres'],
    pkg: '@modelcontextprotocol/server-postgres',
    extraArgs: ['{DATABASE_URL}'],
    repoUrl: 'https://github.com/modelcontextprotocol/servers',
    stars: 5000,
    requiredEnv: [
      {
        key: 'DATABASE_URL',
        label: 'Connection String',
        description: 'String de conexão do Postgres (passada como argumento ao server).',
        secret: true,
        placeholder: 'postgresql://user:pass@host:5432/db',
      },
    ],
  }),
  mcp({
    slug: 'supabase',
    name: 'Supabase',
    tagline: 'Gerencie projetos, tabelas e SQL do Supabase.',
    longDescription:
      'Integração oficial do Supabase: criar/consultar tabelas, rodar SQL, gerenciar branches e ler logs. Funciona com seu Personal Access Token.',
    category: 'Data & APIs',
    author: 'Supabase',
    iconKey: 'Database',
    accent: 'accent-green',
    tags: ['database', 'backend', 'postgres'],
    pkg: '@supabase/mcp-server-supabase@latest',
    repoUrl: 'https://github.com/supabase-community/supabase-mcp',
    homepageUrl: 'https://supabase.com',
    featured: true,
    stars: 11000,
    requiredEnv: [
      {
        key: 'SUPABASE_ACCESS_TOKEN',
        label: 'Supabase Access Token',
        link: 'https://supabase.com/dashboard/account/tokens',
        placeholder: 'sbp_...',
      },
    ],
  }),
  mcp({
    slug: 'stripe',
    name: 'Stripe',
    tagline: 'Pagamentos, clientes e faturas via API do Stripe.',
    longDescription:
      'Toolkit oficial do Stripe: criar produtos e preços, gerenciar clientes, emitir faturas e consultar pagamentos — tudo pela API do Stripe, em modo de teste ou produção.',
    category: 'Payments',
    author: 'Stripe',
    iconKey: 'CreditCard',
    accent: 'accent-purple',
    tags: ['payments', 'billing'],
    pkg: '@stripe/mcp',
    extraArgs: ['--tools=all', '--api-key={STRIPE_SECRET_KEY}'],
    repoUrl: 'https://github.com/stripe/agent-toolkit',
    homepageUrl: 'https://stripe.com',
    stars: 4000,
    requiredEnv: [
      {
        key: 'STRIPE_SECRET_KEY',
        label: 'Stripe Secret Key',
        description: 'Use uma chave de teste (sk_test_...) enquanto valida.',
        link: 'https://dashboard.stripe.com/apikeys',
        placeholder: 'sk_test_...',
      },
    ],
  }),
  mcp({
    slug: 'figma',
    name: 'Figma',
    tagline: 'Layout, componentes e tokens de design do Figma.',
    longDescription:
      'Dá ao agente acesso ao layout do Figma (Framelink): lê frames, componentes, estilos e tokens pra gerar código fiel ao design. Ideal pra design-to-code.',
    category: 'Design',
    author: 'Framelink',
    iconKey: 'Figma',
    accent: 'accent-red',
    tags: ['design', 'figma', 'ui'],
    pkg: 'figma-developer-mcp',
    extraArgs: ['--figma-api-key={FIGMA_API_KEY}', '--stdio'],
    repoUrl: 'https://github.com/GLips/Figma-Context-MCP',
    homepageUrl: 'https://framelink.ai',
    featured: true,
    stars: 9000,
    requiredEnv: [
      {
        key: 'FIGMA_API_KEY',
        label: 'Figma API Token',
        link: 'https://www.figma.com/developers/api#access-tokens',
        placeholder: 'figd_...',
      },
    ],
  }),
  mcp({
    slug: 'slack',
    name: 'Slack',
    tagline: 'Ler e postar em canais do Slack.',
    longDescription:
      'Conecta o agente ao Slack: listar canais, ler histórico, postar mensagens e responder em threads. Bom pra automações de comunicação e notificações.',
    category: 'Collaboration',
    author: 'Anthropic',
    iconKey: 'Slack',
    accent: 'accent-purple',
    tags: ['chat', 'team'],
    pkg: '@modelcontextprotocol/server-slack',
    repoUrl: 'https://github.com/modelcontextprotocol/servers',
    stars: 4000,
    requiredEnv: [
      {
        key: 'SLACK_BOT_TOKEN',
        label: 'Slack Bot Token',
        link: 'https://api.slack.com/apps',
        placeholder: 'xoxb-...',
      },
      { key: 'SLACK_TEAM_ID', label: 'Slack Team ID', secret: false, placeholder: 'T01234567' },
    ],
  }),
  mcp({
    slug: 'google-maps',
    name: 'Google Maps',
    tagline: 'Geocoding, lugares e rotas do Google Maps.',
    longDescription:
      'Acesso ao Google Maps Platform: geocoding, busca de lugares, detalhes, direções e matriz de distâncias. Útil pra apps com contexto geográfico.',
    category: 'Data & APIs',
    author: 'Anthropic',
    iconKey: 'MapPin',
    accent: 'accent-green',
    tags: ['maps', 'geo'],
    pkg: '@modelcontextprotocol/server-google-maps',
    repoUrl: 'https://github.com/modelcontextprotocol/servers',
    stars: 3000,
    requiredEnv: [
      {
        key: 'GOOGLE_MAPS_API_KEY',
        label: 'Google Maps API Key',
        link: 'https://console.cloud.google.com/google/maps-apis/credentials',
      },
    ],
  }),
  mcp({
    slug: 'notion',
    name: 'Notion',
    tagline: 'Páginas, bancos de dados e busca no Notion.',
    longDescription:
      'Integração com o Notion: ler e criar páginas, consultar databases e buscar conteúdo do workspace. Conecte uma integração interna do Notion pra liberar o acesso.',
    category: 'Productivity & Workflow',
    author: 'Notion',
    iconKey: 'FileText',
    tags: ['notes', 'docs', 'wiki'],
    pkg: '@notionhq/notion-mcp-server',
    repoUrl: 'https://github.com/makenotion/notion-mcp-server',
    homepageUrl: 'https://notion.so',
    stars: 3000,
    requiredEnv: [
      {
        key: 'NOTION_TOKEN',
        label: 'Notion Integration Token',
        description: 'Crie uma integração interna e compartilhe as páginas com ela.',
        link: 'https://www.notion.so/my-integrations',
        placeholder: 'ntn_...',
      },
    ],
  }),
  mcp({
    slug: 'e2b',
    name: 'E2B Code Interpreter',
    tagline: 'Execução de código em sandbox isolado na nuvem.',
    longDescription:
      'E2B roda código gerado pelo agente em micro-VMs isoladas — Python, Node e mais — com acesso a arquivos e rede. Ideal pra data analysis e tarefas que precisam executar código com segurança.',
    category: 'Code Execution',
    author: 'E2B',
    iconKey: 'Terminal',
    accent: 'accent-blue',
    tags: ['sandbox', 'code', 'python'],
    pkg: '@e2b/mcp-server',
    repoUrl: 'https://github.com/e2b-dev/mcp-server',
    homepageUrl: 'https://e2b.dev',
    stars: 3500,
    requiredEnv: [
      {
        key: 'E2B_API_KEY',
        label: 'E2B API Key',
        link: 'https://e2b.dev/dashboard',
        placeholder: 'e2b_...',
      },
    ],
  }),
  mcp({
    slug: 'apify',
    name: 'Apify',
    tagline: 'Mais de 5.000 Actors de scraping e automação.',
    longDescription:
      'Apify expõe milhares de Actors prontos (scrapers de redes sociais, e-commerce, SERPs e mais) como ferramentas. O agente roda Actors e recebe os dados estruturados.',
    category: 'Search & Web',
    author: 'Apify',
    iconKey: 'Bot',
    accent: 'accent-orange',
    tags: ['scraping', 'automation'],
    pkg: '@apify/actors-mcp-server',
    repoUrl: 'https://github.com/apify/actors-mcp-server',
    homepageUrl: 'https://apify.com',
    stars: 2000,
    requiredEnv: [
      {
        key: 'APIFY_TOKEN',
        label: 'Apify API Token',
        link: 'https://console.apify.com/account/integrations',
        placeholder: 'apify_api_...',
      },
    ],
  }),
  mcp({
    slug: 'everything',
    name: 'Everything (Reference)',
    tagline: 'Server de referência pra testar tools, prompts e recursos MCP.',
    longDescription:
      'Server de referência do MCP que exercita todas as features do protocolo (tools, prompts, resources, sampling). Use pra validar que a conexão MCP do agente está funcionando.',
    category: 'Developer Tools',
    author: 'Anthropic',
    iconKey: 'Boxes',
    tags: ['reference', 'testing'],
    pkg: '@modelcontextprotocol/server-everything',
    repoUrl: 'https://github.com/modelcontextprotocol/servers',
    stars: 9000,
  }),
];

// ---------------------------------------------------------------------------
// Skills (instruction blocks injetados no prompt)
// ---------------------------------------------------------------------------

const SKILLS: MarketplaceCatalogItem[] = [
  skill({
    slug: 'spec-driven-dev',
    name: 'Spec-Driven Development',
    tagline: 'Especifique antes de codar: escopo claro → plano → implementação.',
    category: 'Productivity & Workflow',
    author: 'Orkestral',
    iconKey: 'ScrollText',
    accent: 'accent-purple',
    tags: ['planning', 'workflow'],
    featured: true,
    content: `# Spec-Driven Development

Antes de escrever qualquer código, você SEMPRE produz uma spec curta e a valida.

## Fluxo
1. **Entender** — reformule o pedido em 2-3 frases. Liste suposições e perguntas em aberto.
2. **Escopo** — defina explicitamente o que está DENTRO e FORA. Nada de scope creep.
3. **Plano** — quebre em passos pequenos e verificáveis (≤ 1 commit cada). Cada passo tem um critério de "pronto".
4. **Implementar** — execute um passo por vez. Não pule adiante.
5. **Validar** — após cada passo, rode testes/typecheck e confirme o critério.

## Regras
- Se um requisito estiver ambíguo, PARE e pergunte antes de codar.
- Prefira a solução mais simples que satisfaz a spec (YAGNI).
- Mantenha a spec atualizada se o escopo mudar — ela é a fonte da verdade.`,
  }),
  skill({
    slug: 'tdd-workflow',
    name: 'Test-Driven Development',
    tagline: 'Red → Green → Refactor. Teste primeiro, sempre.',
    category: 'Productivity & Workflow',
    author: 'Orkestral',
    iconKey: 'FlaskConical',
    accent: 'accent-green',
    tags: ['testing', 'tdd', 'quality'],
    featured: true,
    content: `# Test-Driven Development

Você escreve o teste ANTES da implementação. Sempre.

## Ciclo
1. **Red** — escreva o menor teste que falha e descreve o próximo comportamento.
2. **Green** — escreva o mínimo de código pra passar. Sem floreios.
3. **Refactor** — limpe o código mantendo os testes verdes.

## Regras
- Um comportamento por teste. Nomes descritivos (\`it('rejeita email inválido')\`).
- Nunca escreva código de produção sem um teste falhando que o exija.
- Cubra os casos de borda: vazio, nulo, limites, erros.
- Rode a suíte inteira antes de considerar a tarefa concluída.`,
  }),
  skill({
    slug: 'conventional-commits',
    name: 'Conventional Commits',
    tagline: 'Mensagens de commit padronizadas e semânticas.',
    category: 'Developer Tools',
    author: 'Orkestral',
    iconKey: 'GitCommitHorizontal',
    tags: ['git', 'commits'],
    content: `# Conventional Commits

Toda mensagem de commit segue o padrão Conventional Commits.

## Formato
\`\`\`
<tipo>(<escopo opcional>): <descrição imperativa e curta>

<corpo opcional explicando o porquê>
\`\`\`

## Tipos
- \`feat\` — nova funcionalidade
- \`fix\` — correção de bug
- \`refactor\` — mudança sem alterar comportamento
- \`docs\`, \`test\`, \`chore\`, \`perf\`, \`build\`, \`ci\`

## Regras
- Descrição no imperativo, minúscula, sem ponto final, ≤ 72 chars.
- Um commit = uma mudança lógica coesa.
- Breaking change: adicione \`!\` após o tipo e uma seção \`BREAKING CHANGE:\` no corpo.`,
  }),
  skill({
    slug: 'code-review-checklist',
    name: 'Code Review Checklist',
    tagline: 'Revisão rigorosa: correção, segurança, clareza e testes.',
    category: 'Developer Tools',
    author: 'Orkestral',
    iconKey: 'GitPullRequestArrow',
    accent: 'accent-blue',
    tags: ['review', 'quality'],
    content: `# Code Review Checklist

Ao revisar código, percorra esta checklist e comente apenas o que importa.

## Correção
- A lógica está certa? Casos de borda tratados (vazio, nulo, concorrência)?
- Há regressões ou efeitos colaterais não intencionais?

## Segurança
- Input validado? Riscos de injeção (SQL, XSS, command)?
- Segredos fora do código? Authz/authn corretos?

## Clareza
- Nomes revelam intenção? Funções fazem uma coisa só?
- Complexidade desnecessária? Código morto?

## Testes
- Mudança coberta por testes? Os testes testam comportamento, não implementação?

## Como comentar
- Seja específico e acionável. Diferencie "bloqueante" de "nit".
- Elogie boas decisões. Sugira, não imponha.`,
  }),
  skill({
    slug: 'security-review',
    name: 'Security Review (OWASP)',
    tagline: 'Caça a vulnerabilidades guiada pelo OWASP Top 10.',
    category: 'Developer Tools',
    author: 'Orkestral',
    iconKey: 'ShieldCheck',
    accent: 'accent-red',
    tags: ['security', 'owasp', 'review'],
    featured: true,
    content: `# Security Review (OWASP Top 10)

Você analisa o código procurando vulnerabilidades, priorizando o OWASP Top 10.

## Verifique
1. **Injection** — SQL/NoSQL/command/LDAP. Queries parametrizadas?
2. **Broken Access Control** — checagem de autorização em cada endpoint sensível.
3. **Cryptographic Failures** — segredos expostos, hashing fraco, TLS ausente.
4. **Insecure Design** — falta de rate limiting, lógica de negócio explorável.
5. **Misconfiguration** — defaults inseguros, CORS aberto, headers ausentes.
6. **Vulnerable Components** — dependências desatualizadas/CVEs conhecidos.
7. **Auth Failures** — sessões, brute force, tokens previsíveis.
8. **Integrity Failures** — deserialização insegura, supply chain.
9. **Logging Failures** — eventos de segurança não logados / logs com PII.
10. **SSRF** — requisições a URLs controladas pelo usuário.

## Saída
Pra cada achado: severidade, local exato, exploração e correção recomendada.`,
  }),
  skill({
    slug: 'pr-description',
    name: 'PR Description Writer',
    tagline: 'Descrições de PR claras: o quê, por quê e como testar.',
    category: 'Developer Tools',
    author: 'Orkestral',
    iconKey: 'FileText',
    tags: ['git', 'docs', 'review'],
    content: `# PR Description Writer

Toda PR ganha uma descrição que um revisor entende em 30 segundos.

## Template
\`\`\`
## O que
<resumo de 1-2 frases da mudança>

## Por que
<problema/contexto que motivou>

## Como
<abordagem técnica, decisões e trade-offs>

## Como testar
<passos pra validar manualmente + testes adicionados>

## Riscos
<o que pode quebrar / o que monitorar>
\`\`\`

## Regras
- Linke a issue relacionada. Inclua screenshots/GIFs pra mudanças de UI.
- Liste breaking changes e passos de migração no topo, se houver.`,
  }),
  skill({
    slug: 'systematic-debugging',
    name: 'Systematic Debugging',
    tagline: 'Reproduzir, isolar, hipotetizar, corrigir — sem chutar.',
    category: 'Productivity & Workflow',
    author: 'Orkestral',
    iconKey: 'Bug',
    accent: 'accent-orange',
    tags: ['debugging', 'methodology'],
    content: `# Systematic Debugging

Você nunca corrige "no chute". Segue o método.

## Passos
1. **Reproduzir** — encontre o menor caso reproduzível e confiável.
2. **Observar** — colete evidências reais (logs, stack traces, estado). Não suponha.
3. **Isolar** — bisect: reduza o espaço do problema pela metade a cada passo.
4. **Hipotetizar** — formule UMA hipótese testável da causa raiz.
5. **Testar** — valide/refute a hipótese com um experimento mínimo.
6. **Corrigir** — trate a causa raiz, não o sintoma.
7. **Prevenir** — adicione um teste de regressão que falharia antes do fix.

## Regras
- Se a evidência contradiz a hipótese, descarte a hipótese — não a evidência.
- Mude uma variável por vez.`,
  }),
  skill({
    slug: 'refactoring-playbook',
    name: 'Refactoring Playbook',
    tagline: 'Refatore com segurança: pequenos passos, testes sempre verdes.',
    category: 'Productivity & Workflow',
    author: 'Orkestral',
    iconKey: 'Wrench',
    tags: ['refactor', 'quality'],
    content: `# Refactoring Playbook

Refatorar = melhorar a estrutura SEM mudar o comportamento.

## Antes de começar
- Garanta cobertura de testes na área. Sem rede de segurança, escreva testes primeiro.

## Técnicas
- Extrair função/variável pra nomear intenção.
- Substituir condicional por polimorfismo/lookup quando crescer demais.
- Remover duplicação (DRY) — mas só após ver o padrão 3x.
- Reduzir o escopo de mutabilidade e efeitos colaterais.

## Regras
- Passos minúsculos. Rode os testes após cada passo.
- Commits de refactor são separados de commits de feature/fix.
- Se um teste quebrar, você mudou comportamento — reverta e refaça menor.`,
  }),
  skill({
    slug: 'api-design',
    name: 'API Design Guidelines',
    tagline: 'APIs REST consistentes, previsíveis e versionáveis.',
    category: 'Developer Tools',
    author: 'Orkestral',
    iconKey: 'Network',
    accent: 'accent-blue',
    tags: ['api', 'rest', 'design'],
    content: `# API Design Guidelines

Você projeta APIs consistentes e fáceis de consumir.

## Recursos & verbos
- Substantivos no plural pra recursos (\`/users\`, \`/orders/{id}\`).
- GET (ler, idempotente), POST (criar), PUT/PATCH (atualizar), DELETE (remover).

## Respostas
- Status codes corretos: 200/201/204, 400/401/403/404/409, 422, 500.
- Erros num formato consistente: \`{ error: { code, message, details } }\`.
- Paginação, filtros e ordenação por query params padronizados.

## Robustez
- Versione (\`/v1\`). Mudanças breaking = nova versão.
- Valide input no servidor. Nunca confie no cliente.
- Documente cada endpoint (request, response, exemplos).`,
  }),
  skill({
    slug: 'clean-code',
    name: 'Clean Code Principles',
    tagline: 'Código legível: nomes claros, funções pequenas, sem surpresas.',
    category: 'Productivity & Workflow',
    author: 'Orkestral',
    iconKey: 'Sparkles',
    accent: 'accent-purple',
    tags: ['quality', 'readability'],
    content: `# Clean Code Principles

Código é lido muito mais vezes do que é escrito. Otimize pra leitura.

## Princípios
- **Nomes** revelam intenção. Sem abreviações obscuras nem \`data2\`.
- **Funções** fazem UMA coisa, são curtas e operam num nível de abstração.
- **Sem surpresas** — o código faz o que o nome promete, sem efeitos ocultos.
- **Comentários** explicam o "porquê", não o "o quê" (o código diz o quê).
- **Erros** tratados explicitamente; nunca engula exceções em silêncio.
- **DRY com bom senso** — abstraia duplicação real, não coincidência.

## Cheiros a evitar
Funções gigantes, muitos parâmetros, flags booleanas de comportamento, aninhamento profundo, código morto.`,
  }),
  skill({
    slug: 'tech-docs-writer',
    name: 'Technical Docs Writer',
    tagline: 'Documentação que as pessoas realmente leem e usam.',
    category: 'Productivity & Workflow',
    author: 'Orkestral',
    iconKey: 'BookOpen',
    tags: ['docs', 'writing'],
    content: `# Technical Docs Writer

Você escreve docs orientadas ao leitor, não ao autor.

## Estrutura
1. **O que é** e qual problema resolve (1 parágrafo).
2. **Quickstart** — o caminho feliz em ≤ 5 passos, copy-paste funcional.
3. **Conceitos** — só o necessário pra usar.
4. **Referência** — completa, mas escaneável.
5. **Troubleshooting** — erros comuns e soluções.

## Regras
- Exemplos > prosa. Todo exemplo deve funcionar de fato.
- Voz ativa, frases curtas, segunda pessoa ("você").
- Comece pela tarefa do leitor, não pela arquitetura interna.`,
  }),
  skill({
    slug: 'performance-optimization',
    name: 'Performance Optimization',
    tagline: 'Meça antes de otimizar. Ataque o gargalo real.',
    category: 'Productivity & Workflow',
    author: 'Orkestral',
    iconKey: 'Zap',
    accent: 'accent-yellow',
    tags: ['performance', 'profiling'],
    content: `# Performance Optimization

Você otimiza com base em medição, não em palpite.

## Método
1. **Meça** — defina a métrica (latência p95, throughput, memória) e o baseline.
2. **Profile** — encontre o gargalo real. Não otimize o que não importa.
3. **Hipótese** — entenda a causa (N+1, alocação, IO, algoritmo O(n²)).
4. **Otimize** — uma mudança por vez; re-meça pra confirmar o ganho.
5. **Pare** — quando atingir a meta. Não micro-otimize sem impacto.

## Suspeitos comuns
Queries N+1, falta de índice/cache, serialização excessiva, trabalho síncrono em hot path, re-renders desnecessários no front.

## Regra de ouro
Legibilidade primeiro; só sacrifique clareza por performance com dados que justifiquem.`,
  }),
  skill({
    slug: 'git-workflow',
    name: 'Git Workflow',
    tagline: 'Branches, commits atômicos e PRs pequenos e revisáveis.',
    category: 'Developer Tools',
    author: 'Orkestral',
    iconKey: 'GitCommitHorizontal',
    accent: 'accent-orange',
    tags: ['git', 'workflow'],
    content: `# Git Workflow

Você mantém um histórico git limpo e revisável.

## Regras
- Uma branch por tarefa, nomeada \`tipo/descricao-curta\` (ex: \`fix/login-null\`).
- Commits atômicos: cada commit compila e faz uma coisa só.
- PRs pequenos (< ~400 linhas). Se crescer, quebre.
- Rebase pra atualizar com a base; merge só no final via PR.
- Nunca commite segredos, arquivos gerados ou \`node_modules\`.
- Mensagem no imperativo; descreva o "porquê" no corpo quando útil.`,
  }),
  skill({
    slug: 'accessibility-a11y',
    name: 'Accessibility (a11y)',
    tagline: 'Interfaces acessíveis por padrão — WCAG, teclado e ARIA.',
    category: 'Developer Tools',
    author: 'Orkestral',
    iconKey: 'ShieldCheck',
    accent: 'accent-blue',
    tags: ['a11y', 'frontend', 'ux'],
    content: `# Accessibility (a11y)

Acessibilidade é requisito, não enfeite.

## Checklist
- HTML semântico (\`button\`, \`nav\`, \`main\`, headings em ordem).
- Tudo operável por teclado; foco visível; ordem de tab lógica.
- Contraste mínimo AA (4.5:1 texto normal).
- \`alt\` em imagens; labels em inputs; \`aria-*\` só quando o nativo não basta.
- Estados (loading, erro) anunciados a leitores de tela (\`aria-live\`).
- Respeite \`prefers-reduced-motion\`.`,
  }),
  skill({
    slug: 'sql-optimization',
    name: 'SQL Optimization',
    tagline: 'Queries rápidas: índices, planos e evitar N+1.',
    category: 'Developer Tools',
    author: 'Orkestral',
    iconKey: 'Database',
    accent: 'accent-green',
    tags: ['sql', 'database', 'performance'],
    content: `# SQL Optimization

Você escreve queries que escalam.

## Método
1. Meça com \`EXPLAIN ANALYZE\` — leia o plano, não adivinhe.
2. Índices nas colunas de filtro/junção/ordenção mais seletivas.
3. Evite \`SELECT *\`; traga só o necessário.
4. Mate o N+1 (eager load / join em vez de query por item).
5. Paginação por keyset quando offset ficar caro.
6. Cuidado com funções em colunas indexadas (quebram o índice).`,
  }),
  skill({
    slug: 'prompt-engineering',
    name: 'Prompt Engineering',
    tagline: 'Prompts claros, com contexto, exemplos e formato de saída.',
    category: 'Productivity & Workflow',
    author: 'Orkestral',
    iconKey: 'Sparkles',
    accent: 'accent-purple',
    tags: ['ai', 'prompting'],
    content: `# Prompt Engineering

Você escreve prompts que produzem resultados consistentes.

## Princípios
- Diga o papel, a tarefa e o **formato de saída** esperado.
- Dê contexto relevante; remova ruído.
- Mostre 1–3 exemplos (few-shot) pra padrões não triviais.
- Peça raciocínio passo a passo em problemas complexos.
- Defina restrições e critérios de sucesso explícitos.
- Itere: teste, observe a falha, ajuste uma variável por vez.`,
  }),
  skill({
    slug: 'incident-response',
    name: 'Incident Response',
    tagline: 'Mitigar primeiro, comunicar sempre, post-mortem sem culpa.',
    category: 'Productivity & Workflow',
    author: 'Orkestral',
    iconKey: 'Bug',
    accent: 'accent-red',
    tags: ['ops', 'sre', 'oncall'],
    content: `# Incident Response

Durante um incidente, você prioriza estancar o sangramento.

## Fluxo
1. **Mitigar** — reduza o impacto (rollback, feature flag, escala) antes de investigar a fundo.
2. **Comunicar** — status claro a cada X min, mesmo sem novidade.
3. **Diagnosticar** — use métricas/logs/traces; mude uma coisa por vez.
4. **Resolver** — confirme recuperação com dados, não esperança.
5. **Post-mortem** — sem culpados; foque em causas sistêmicas e ações concretas com dono e prazo.`,
  }),
  skill({
    slug: 'dependency-hygiene',
    name: 'Dependency Hygiene',
    tagline: 'Dependências enxutas, atualizadas e auditadas.',
    category: 'Developer Tools',
    author: 'Orkestral',
    iconKey: 'Boxes',
    accent: 'accent-yellow',
    tags: ['dependencies', 'security'],
    content: `# Dependency Hygiene

Cada dependência é dívida — adote com critério.

## Regras
- Antes de adicionar: dá pra fazer com a stdlib/algo já presente?
- Avalie manutenção (releases recentes, issues, contribuidores) e tamanho.
- Trave versões (lockfile commitado); atualize em PRs pequenos e isolados.
- Rode auditoria de vulnerabilidades no CI; trate CVEs altos rápido.
- Remova o que não usa; evite libs gigantes pra uma função.`,
  }),
];

/** Catálogo completo (MCPs + skills). */
export const MARKETPLACE_CATALOG: MarketplaceCatalogItem[] = [...MCPS, ...SKILLS];

/** Itens de um tipo específico. */
export function catalogByKind(kind: 'skill' | 'mcp'): MarketplaceCatalogItem[] {
  return MARKETPLACE_CATALOG.filter((i) => i.kind === kind);
}

/** Categorias distintas (ordem de primeira aparição) pra um tipo. */
export function catalogCategories(kind: 'skill' | 'mcp'): string[] {
  const seen: string[] = [];
  for (const item of catalogByKind(kind)) {
    const c = item.category ?? 'Outros';
    if (!seen.includes(c)) seen.push(c);
  }
  return seen;
}
