/**
 * Tipos compartilhados entre main e renderer.
 * Expandido fase por fase conforme doc 21.
 */
import type { PerformancePreset } from '../performance-presets';

export type { PerformancePreset } from '../performance-presets';

export type Workspace = {
  id: string;
  name: string;
  companyName?: string | null;
  mission?: string | null;
  objectives: string[];
  /** Pasta local OU clone de repo remoto — o workspace É o projeto. */
  path?: string | null;
  gitRemote?: string | null;
  provider?: 'local' | 'github' | 'azure' | null;
  icon?: string | null;
  color?: string | null;
  planMode: 'local' | 'team';
  activeProjectId?: string | null;
  /** ISO timestamp do arquivamento. Null = workspace ativo. */
  archivedAt?: string | null;
  /** Modelo persistente de QUEM é o usuário neste projeto (estilo USER.md do
   *  Hermes): nome, papel, preferências, estilo. Injetado no prompt do chat e
   *  atualizado pelos agentes via MCP quando o usuário revela algo sobre si. */
  userProfile?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Project = {
  id: string;
  workspaceId: string;
  name: string;
  path?: string | null;
  gitRemote?: string | null;
  provider?: 'local' | 'github' | 'azure' | null;
  description?: string | null;
  knowledgeBaseStatus: 'not_started' | 'indexing' | 'ready' | 'error';
  createdAt: string;
  updatedAt: string;
};

export type UserProfile = {
  id: string;
  name: string;
  aliases: string[];
  email?: string | null;
  timezone: string;
  useDeviceTimezone: boolean;
  language: 'pt-BR' | 'en' | 'es';
  aiStyle: 'concise' | 'detailed' | 'formal' | 'casual';
  createdAt: string;
  updatedAt: string;
};

/** Plano comercial. 'free-local' é offline-first. 'team-cloud' é pago. */
export type Plan = 'free-local' | 'team-cloud';

/** Mantido por retrocompat (alguns componentes legados ainda referenciam). */
export type LlmProviderId =
  | 'claude-code-cli'
  | 'claude-api'
  | 'codex-cli'
  | 'openai-api'
  | 'gemini-cli'
  | 'gemini-api';

/** Tipos de tarefa que o usuário pode marcar querer fazer com o Orkestral. */
export type OnboardingObjective =
  | 'code-review'
  | 'code-build'
  | 'bugfix'
  | 'architecture'
  | 'performance'
  | 'docs'
  | 'tests'
  | 'security'
  | 'ci-cd'
  | 'refactor';

/** Adapters CLI suportados (ver src/main/adapters/registry.ts). */
export type AdapterType =
  | 'claude_local'
  | 'codex_local'
  | 'cursor_local'
  | 'cursor_cloud'
  | 'gemini_local'
  | 'grok_local'
  | 'hermes_local'
  | 'opencode_local'
  | 'pi_local'
  | 'openclaw_gateway'
  /** Modelo local do Orkestral (abstração do llama.cpp) — executor de patches. */
  | 'orkestral_local';

/** Modelo retornado pelo discovery do adapter. */
export interface AdapterModel {
  id: string;
  label: string;
  description?: string;
}

/** Tipo de campo de configuração de um adapter (driva a UI dinâmica). */
export type AdapterConfigFieldType =
  | 'text'
  | 'password'
  | 'select'
  | 'toggle'
  | 'number'
  | 'textarea'
  // Caminho de arquivo: input editável + botão que abre o seletor nativo
  // (Finder). O valor persiste como string (path absoluto).
  | 'file';

/**
 * Um campo do schema de configuração de um adapter. Espelha o
 * ConfigFieldSchema do paperclip. Só driva a UI — o valor persiste em
 * Agent.adapterConfig (Record<string, unknown>) e é lido em runtime por
 * cada adapter na hora de montar os args do CLI.
 */
export interface AdapterConfigField {
  key: string;
  label: string;
  type: AdapterConfigFieldType;
  /** Opções para type 'select'. */
  options?: { value: string; label: string }[];
  /** Valor default exibido quando adapterConfig[key] está vazio. */
  default?: unknown;
  hint?: string;
  required?: boolean;
  placeholder?: string;
  /** Agrupamento visual opcional. */
  group?: string;
}

/** Schema de configuração de um adapter — lista de campos dinâmicos. */
export interface AdapterConfigSchema {
  fields: AdapterConfigField[];
}

/** Descritor de um adapter exibido na grade de seleção. */
export interface AdapterDescriptor {
  type: AdapterType;
  name: string;
  description: string;
  icon: string; // nome do ícone lucide (Sparkles, Code, etc.) ou emoji
  recommended?: boolean;
  comingSoon?: boolean;
  /**
   * Só pode ser usado por agentes executores (não pode ser o agente principal /
   * orquestrador). Ex: o modelo local Orkestral — sem poder de planejamento.
   */
  executorOnly?: boolean;
  /**
   * Schema dos campos de configuração específicos do adapter. Renderizado
   * dinamicamente nas UIs de criação de agente — os campos mudam quando o
   * provedor muda. Undefined/vazio = sem config (ex: Orkestral Forge).
   */
  configSchema?: AdapterConfigSchema;
}

/** Resultado da probe do adapter (Test now). */
export interface AdapterTestResult {
  status: 'pass' | 'warn' | 'fail';
  message: string;
  checks: Array<{
    label: string;
    status: 'pass' | 'warn' | 'fail';
    detail?: string;
  }>;
  durationMs: number;
}

export type OnboardingState = {
  completed: boolean;
  step: number;
  plan: Plan | null;
  llmProvider: LlmProviderId | null;
  objectives: OnboardingObjective[];
  completedAt: string | null;
  updatedAt: string;
};

export type OnboardingSubmission = {
  /** Dados pessoais do usuário (Step 1). */
  user: {
    name: string;
    email?: string;
  };
  /**
   * Workspace É o projeto. Nome + onde fica (path local OU git remote).
   * Mission opcional. Path/provider podem ser deixados em branco se o user
   * pular esta etapa (mas então o agente trabalha sem contexto de pasta).
   */
  company: {
    name: string;
    mission?: string;
    icon?: string;
    color?: string;
    provider?: 'local' | 'github' | 'azure';
    path?: string;
    gitRemote?: string;
    sources?: Array<{
      kind: WorkspaceSourceKind;
      label: string;
      path?: string | null;
      repoFullName?: string | null;
      branch?: string | null;
      githubAccountLogin?: string | null;
    }>;
  };
  /** Primeiro agente da company — adapter CLI + model (Step 2). */
  agent: {
    name: string;
    adapterType: AdapterType;
    model?: string;
    /** Config extra do adapter (ex: fastMode, sandbox, instructions path). */
    adapterConfig?: Record<string, unknown>;
    /** Nível de autonomia do time (slider no onboarding). Default 'medium'. */
    autonomyLevel?: 'low' | 'medium' | 'high';
  };
  /** Objetivos selecionados pelo usuário (Step 3). */
  objectives: OnboardingObjective[];
  /** Plano selecionado (Step 4). */
  plan: Plan;
  /** Se true, executa a contratação inicial automática após onboarding. */
  runInitialHiringPlan?: boolean;
  /** Preset de desempenho/memória escolhido no slider — decide a variante do Forge. */
  performancePreset?: PerformancePreset;
};

/**
 * Tipos do sistema de chat — espelham o schema mas com nomes públicos
 * pra consumo no renderer.
 */

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';
export type MessageStatus = 'streaming' | 'done' | 'error' | 'cancelled';
export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

/** Anexo de mensagem — imagem ou arquivo enviado pelo user. */
export interface ChatAttachment {
  /** UUID gerado no client. */
  id: string;
  /** Nome original do arquivo. */
  name: string;
  /** MIME type (image/png, image/jpeg, application/pdf, text/plain, etc.). */
  mime: string;
  /** Tamanho em bytes. */
  size: number;
  /** Conteúdo em base64 (sem o prefixo `data:...,`). */
  data: string;
}

/**
 * Item da fila de mensagens persistida no MAIN (tabela `chat_queue`). Quando o
 * usuário envia uma mensagem com um run ativo na sessão, ela é enfileirada aqui
 * e despachada automaticamente ao terminar o run — sobrevive a reload/navegação.
 */
export interface ChatQueueItem {
  id: string;
  sessionId: string;
  content: string;
  attachments?: ChatAttachment[];
  /** Escopo de sources do turno ('all' | sourceIds). Ausente = 'all'. */
  scope?: 'all' | string[];
  /** 'queue' = FIFO normal · 'steer' = prioridade (despachada antes das normais). */
  kind: 'queue' | 'steer';
  status: 'pending' | 'sent';
  /** Origem ('renderer' | 'channel' | 'cli') — preserva o fluxo da origem ao despachar. */
  origin?: 'renderer' | 'channel' | 'cli';
  createdAt: string;
}

/** Parts no estilo opencode/anthropic — extensível pra futuras part types. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'context-compact';
      status?: 'running' | 'done' | 'error';
      summary: string;
      messagesCompacted: number;
      tokensPreservedEstimate: number;
      createdAt: string;
    }
  | {
      type: 'tool-call';
      /** Id estável p/ atualizar a mesma linha quando os args chegam depois. */
      id?: string;
      toolName: string;
      args?: Record<string, unknown>;
      output?: string;
      status?: 'pending' | 'done' | 'error';
    }
  | { type: 'attachment'; attachment: ChatAttachment }
  | { type: 'error'; message: string };

export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  role: string;
  title?: string | null;
  adapterType: AdapterType | null;
  adapterConfig: Record<string, unknown>;
  model?: string | null;
  status: 'idle' | 'live' | 'paused' | 'error';
  isOrchestrator: boolean;
  canCreateAgents: boolean;
  canAssignTasks: boolean;
  canEditFiles: boolean;
  canRunCommands: boolean;
  systemPrompt?: string | null;
  /** FK pra outro agent.id — quem esse agente reporta. Null = raiz. */
  reportsTo?: string | null;
  /** Descrição livre do que o agente faz. */
  capabilities?: string | null;
  /** Seed do avatar DiceBear (estilo bottts). Null = derivado do nome. */
  avatarSeed?: string | null;
  /** Runtime config livre: cheap model, thinking effort, etc. */
  runtimeConfig: Record<string, unknown>;
  pauseReason?: string | null;
  pausedAt?: string | null;
  lastHeartbeatAt?: string | null;
  heartbeatEnabled: boolean;
  heartbeatIntervalMinutes: number;
  createdAt: string;
  updatedAt: string;
}

/** Atividade unificada do agente (chat + heartbeat + code-review). */
export type AgentActivityKind = 'chat' | 'heartbeat' | 'code-review' | 'issue';
export type AgentActivityStatus = 'running' | 'queued' | 'done' | 'error' | 'cancelled';

export interface AgentActivityItem {
  kind: AgentActivityKind;
  id: string;
  status: AgentActivityStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  title: string;
  subtitle?: string | null;
  errorMessage?: string | null;
  link?: string | null;
  meta?: Record<string, unknown>;
}

export interface AgentActivityStats {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  byKind: Record<AgentActivityKind, number>;
  avgDurationMs: number | null;
  successRate: number | null;
}

/** Run de heartbeat (manual ou scheduler). */
export interface HeartbeatRun {
  id: string;
  agentId: string;
  workspaceId: string;
  source: 'manual' | 'scheduler';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  output: string | null;
  errorMessage: string | null;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: string;
}

/**
 * Estrutura recomendada do runtimeConfig do agente. Persistido como JSON
 * livre — TODOS os campos são opcionais pra não quebrar agentes antigos.
 */
export interface AgentRuntimeConfig {
  /**
   * Nível de autonomia do time (lido do ORQUESTRADOR/CEO — 1 por workspace):
   * quanto o time executa sozinho até o fim vs. pede aprovação humana.
   *   - 'low'    cauteloso: revisão completa, escala pro humano.
   *   - 'medium' balanceado (default): cadeia de revisão entre agentes.
   *   - 'high'   autônomo ("manda e dorme"): finaliza direto sem subir pra
   *              revisão; não enche o inbox de aprovações.
   */
  autonomyLevel?: 'low' | 'medium' | 'high';
  /** Esforço de raciocínio (model thinking effort). */
  thinkingEffort?: 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  bypassSandbox?: boolean;
  enableSearch?: boolean;
  fastMode?: boolean;
  /** Args extras passados ao CLI (ex: --verbose). */
  extraArgs?: string[];
  /** Variáveis de ambiente — value pode ser plain ou secret (resolvido em runtime). */
  envVars?: Array<{ key: string; value: string; secret?: boolean }>;
  /** Timeout do processo em segundos. 0 = sem limite. */
  timeoutSec?: number;
  /** Tempo de espera após SIGTERM antes do SIGKILL. */
  graceSec?: number;
  /** Advanced run policy. */
  advanced?: {
    wakeOnDemand?: boolean;
    cooldownSec?: number;
    maxConcurrent?: number;
    continueAfterMaxTurn?: boolean;
    continuationAttempts?: number;
    continuationDelaySec?: number;
  };
}

export interface AgentApiKey {
  id: string;
  agentId: string;
  name: string;
  tokenPreview: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Skills & Issues
// ---------------------------------------------------------------------------

export type SkillKind = 'instruction' | 'mcp' | 'tool';

export interface Skill {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  kind: SkillKind;
  description: string | null;
  content: string;
  config: Record<string, unknown>;
  /** 'user'/marketplace (protegida) vs 'agent' (auto-curada pela experiência). */
  createdBy: 'user' | 'agent';
  useCount: number;
  lastUsedAt: string | null;
  state: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export type MarketplaceItemKind = 'skill' | 'mcp';

/** Transporte do servidor MCP — define como o adapter conecta. */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * Variável de ambiente exigida por um item do marketplace (ex: API key).
 * Coletada no diálogo de instalação e persistida em config.mcpServer.env
 * (ou enviada como header pra servers HTTP que usam Authorization).
 */
export interface MarketplaceRequiredEnv {
  key: string;
  label: string;
  description?: string;
  /** Default true — se false, o usuário pode instalar sem preencher. */
  required?: boolean;
  placeholder?: string;
  /** URL onde obter a credencial (ex: página de tokens do provider). */
  link?: string;
  /** Default true — mascara o valor na UI. */
  secret?: boolean;
  /**
   * Quando definido, o valor vira um HTTP header com esse nome (servers http).
   * Ex: header 'Authorization' com template 'Bearer {value}'.
   */
  asHeader?: string;
  /** Template do valor do header. `{value}` é substituído. Default `{value}`. */
  headerTemplate?: string;
}

/**
 * Metadados de supply-chain de um MCP de comunidade (não-curado). Carrega o
 * comando exato (com versão pinada) e o aviso de execução pra UI confirmar
 * antes de rodar pela primeira vez. Persistido em `config.marketplace.security`
 * na instalação.
 */
export interface MarketplaceMcpSecurity {
  /** Registro de origem do pacote. */
  registry: 'npm' | 'pypi';
  /** Nome do pacote (sem versão). */
  pkg: string;
  /** Versão RESOLVIDA e pinada (nunca `latest`/intervalo). */
  version: string;
  /** Comando exato que será executado (ex: `npx -y foo@1.2.3`). */
  command: string;
  /** Aviso (EN) pra UI mostrar antes da primeira execução. */
  warning: string;
}

/**
 * Item do catálogo do marketplace (skills + MCP servers). Os campos extras
 * (category, readme, icon, etc.) alimentam os cards e o painel de detalhe.
 * Mantém retrocompatibilidade: só `id/kind/name/slug/description/sourceUrl/
 * provider/install` são obrigatórios.
 */
export interface MarketplaceCatalogItem {
  id: string;
  kind: MarketplaceItemKind;
  name: string;
  slug: string;
  /** Tagline curta exibida no card. */
  description: string;
  /** 1–3 parágrafos exibidos no topo do detalhe. */
  longDescription?: string;
  /** Markdown renderizado na aba "Sobre" do detalhe. */
  readme?: string;
  /** Categoria principal (ex: "Developer Tools"). */
  category?: string;
  tags?: string[];
  author?: string;
  /** Nome de um ícone lucide (ex: "Server", "Github") pro avatar do card. */
  iconKey?: string;
  /** URL de logo remoto (ex: avatar do owner no GitHub). Prefere sobre iconKey. */
  iconUrl?: string;
  /** Cor de acento opcional (token CSS sem o prefixo, ex: "accent-blue"). */
  accent?: string;
  homepageUrl?: string;
  repoUrl?: string;
  sourceUrl: string;
  provider: string;
  /** Destaca o item na seção "Em destaque". */
  featured?: boolean;
  /** Hint de popularidade (apenas display). */
  stars?: number;
  /**
   * Modelo de cobrança do serviço por trás do MCP (display/badge):
   *  - 'free'     → open-source/sem custo
   *  - 'freemium' → tem tier grátis, mas exige conta/API key e pode cobrar
   *  - 'paid'     → exige licença/assinatura paga
   */
  pricing?: 'free' | 'freemium' | 'paid';
  /** Transporte do MCP (ignorado pra skills). */
  transport?: McpTransport;
  /** Credenciais/config exigidas na instalação. */
  requiredEnv?: MarketplaceRequiredEnv[];
  /**
   * Gating de supply-chain pra MCPs de comunidade (registro vivo): expõe o
   * comando EXATO que vai rodar (versão pinada, sem `@latest` implícito) e um
   * aviso de que isso baixa e executa código na máquina do usuário. A UI usa
   * isso pra pedir confirmação antes da primeira execução. Ausente em itens
   * curados/verificados (não precisam do gate).
   */
  security?: MarketplaceMcpSecurity;
  install: {
    skillKind: SkillKind;
    contentTemplate: string;
    config: Record<string, unknown>;
  };
}

/** Scope especial que habilita um item em TODOS os modelos. */
export const ALL_MODELS_SCOPE = '*';

/**
 * Título default de uma sessão recém-criada (também é o default da coluna no
 * schema/migrations). Comparar contra esta constante — nunca contra a string
 * crua — pra detectar se o título ainda não foi renomeado pelo 1º turno.
 */
export const DEFAULT_SESSION_TITLE = 'Nova conversa';

export interface MarketplaceModelInstall {
  modelScope: string;
  installedAt: string;
}

/** Origem do MCP detectado num CLI externo. */
export type CliSource = 'claude' | 'codex' | 'gemini' | 'cursor';

/** MCP já configurado num CLI do usuário (detectado lendo o config do CLI). */
export interface DetectedCliMcp {
  source: CliSource;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Escopo de origem (ex: "global" ou nome do projeto). */
  scope?: string;
}

/**
 * Metadata de marketplace persistida em skill.config.marketplace.
 * Reflete o que foi instalado e em quais model-scopes está habilitado.
 */
export interface MarketplaceInstallMeta {
  id: string;
  kind: MarketplaceItemKind;
  sourceUrl?: string;
  category?: string;
  iconKey?: string;
  transport?: McpTransport;
  modelInstalls: MarketplaceModelInstall[];
}

export type IssueStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

export type IssuePriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * Metadata da issue — usado pra carregar contexto da execução automatizada.
 *
 * `done`: CRITÉRIO DE PRONTO verificável (≤140 chars), definido pelo orquestrador
 * premium ao criar a issue. NÃO é uma seção da descrição — é o teste objetivo de
 * "a mudança está completa quando ___". O executor (Forge) recebe isso como
 * instrução absoluta; o reviewer confere a issue contra ele. Ex.: "o botão 'Ligar'
 * dispara navigator.mediaDevices e abre a chamada".
 */
/** Um passo da construção: uma tarefa verificável que vira um checkbox na issue. */
export interface ExecutionCheckbox {
  id: string;
  instruction: string;
  targetFile: string;
  status: 'pending' | 'done' | 'blocked';
  completedAt?: string;
  /** Agente responsável por esta task (mostra o avatar dele no checkbox). */
  assigneeAgentId?: string | null;
}

export type IssueMetadata =
  | { kind: 'kb-analysis'; sourceId: string; autoExec?: boolean; done?: string }
  | { kind: 'generic'; done?: string }
  /** Issue gerada por uma construção: carrega os checkboxes que marcam ao vivo. */
  | { kind: 'execution-plan'; checkboxes: ExecutionCheckbox[]; done?: string }
  | ({ done?: string } & Record<string, unknown>);

export interface Issue {
  id: string;
  workspaceId: string;
  issueKey: number;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  labels: string[];
  assigneeAgentId: string | null;
  reporterAgentId: string | null;
  parentIssueId: string | null;
  /** Objetivo ao qual essa issue contribui (null = sem objetivo). */
  goalId: string | null;
  /**
   * Numeração HUMANA (display), desacoplada do issueKey interno.
   *  - top-level: displayKey sequencial entre raízes → PREFIX-{displayKey}.
   *  - sub-issue: displayKey NULL, childOrdinal = posição entre irmãos →
   *    {display do pai}.{childOrdinal}.
   * Veja buildDisplayIds() no IssuesPage. Pode ser null em dados pré-migração.
   */
  displayKey: number | null;
  childOrdinal: number | null;
  dueDate: string | null;
  completedAt: string | null;
  metadata: IssueMetadata | null;
  createdAt: string;
  updatedAt: string;
}

/** Tipo de reviewer numa issue (Paperclip). */
export type IssueReviewerRole = 'reviewer' | 'approver';
export type IssueReviewerDecision = 'approved' | 'rejected' | null;

export interface IssueReviewer {
  id: string;
  issueId: string;
  agentId: string;
  role: IssueReviewerRole;
  decision: IssueReviewerDecision;
  decidedAt: string | null;
  createdAt: string;
}

/** Uma issue referenciada numa relação (resumo leve pra UI). */
export interface IssueRef {
  id: string;
  issueKey: number;
  title: string;
  status: IssueStatus;
  /** Id da linha de dependência (pra remover). Só em blockedBy/blocking. */
  linkId?: string;
}

/** Relações de uma issue — sidebar de propriedades estilo Paperclip. */
export interface IssueRelations {
  parent: IssueRef | null;
  children: IssueRef[];
  blockedBy: IssueRef[];
  blocking: IssueRef[];
  reviewers: IssueReviewer[];
  approvers: IssueReviewer[];
  monitorSchedule: string | null;
}

/** Run de execução de uma issue por agente. */
export interface IssueRun {
  id: string;
  issueId: string;
  agentId: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  outputSummary: string | null;
  exitCode: number | null;
  /** Tokens de entrada consumidos (parsed do stream-json `result.usage`). */
  tokensIn: number | null;
  /** Tokens de saída gerados. */
  tokensOut: number | null;
  /** Custo estimado em USD (vem do stream-json `result.total_cost_usd`). */
  costUsd: number | null;
  /** Quantas tool calls o agente fez nesse run. */
  toolCallCount: number | null;
  /** Executor real ('orkestral_local' = Forge) — economia/observabilidade. */
  adapterType: string | null;
  /** 'local_resolved' (Forge resolveu) | 'escalated_to_premium' | null. */
  exitReason: string | null;
}

export type IssueExecutionEventType =
  | 'queued'
  | 'started'
  | 'phase'
  | 'tool-use'
  | 'file-change'
  | 'model-route'
  | 'finished'
  | 'error';

/**
 * Evento vivo de execução de issue. Esse é o contrato único entre o executor
 * (main process) e a UI: tudo que aparece como "Working...", ferramentas,
 * arquivos editados e troca Forge⇄CLI passa por aqui.
 */
export interface IssueExecutionEvent {
  type: IssueExecutionEventType;
  workspaceId: string;
  issueId: string;
  issueKey: number;
  issueTitle: string;
  issueStatus?: IssueStatus;
  parentIssueId?: string | null;
  runId?: string;
  agentId?: string | null;
  agentName?: string | null;
  sourceId?: string | null;
  sourceLabel?: string | null;
  message?: string;
  phase?: string;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: 'pending' | 'done' | 'error';
  toolArgs?: Record<string, unknown>;
  toolCallCount?: number;
  filePath?: string;
  additions?: number;
  deletions?: number;
  modelRoute?: {
    from?: string | null;
    to?: string | null;
    reason?: string | null;
    localUsed?: boolean;
    premiumUsed?: boolean;
  };
  error?: string;
  createdAt: string;
}

export type QaValidationStatus = 'planned' | 'running' | 'passed' | 'failed' | 'needs_human';
export type QaValidationCheckStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface QaValidationCheck {
  id: string;
  validationId: string;
  ordinal: number;
  kind: string;
  title: string;
  description: string;
  commandHint: string | null;
  status: QaValidationCheckStatus;
  evidence: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QaValidation {
  id: string;
  workspaceId: string;
  issueId: string;
  executorAgentId: string | null;
  qaAgentId: string | null;
  status: QaValidationStatus;
  summary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  checks: QaValidationCheck[];
}

export interface Routine {
  id: string;
  workspaceId: string;
  agentId: string;
  name: string;
  description: string | null;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Diagnóstico de saúde de execução (heurístico, inspirado no kanban_diagnostics
 *  do Hermes). Sinaliza runs suspeitas/travadas/falhas pra o usuário/CEO agir. */
export interface DiagnosticFinding {
  kind: 'suspicious-success' | 'repeated-failure' | 'escalation-heavy' | 'stuck' | 'blocked';
  severity: 'high' | 'medium' | 'low';
  issueId: string;
  issueKey: string;
  issueTitle: string;
  detail: string;
}

/** Métricas agregadas de execução do workspace (observabilidade). */
export interface RunMetrics {
  totalRuns: number;
  done: number;
  failed: number;
  cancelled: number;
  running: number;
  localResolved: number;
  escalatedToPremium: number;
  localResolveRate: number; // 0..1 dos runs orquestrados (Forge)
  avgToolCalls: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

export interface WorkspaceDiagnostics {
  findings: DiagnosticFinding[];
  metrics: RunMetrics;
}

export type CodeReviewStatus = 'queued' | 'analyzing' | 'completed' | 'failed' | 'cancelled';
export type CodeReviewCommentKind =
  | 'bug'
  | 'suggestion'
  | 'security'
  | 'style'
  | 'performance'
  | 'question';
export type CodeReviewSeverity = 'critical' | 'warning' | 'info';

export type WorkspaceSourceKind = 'local_folder' | 'github_repo' | 'azure_repo';
export type WorkspaceSourceRole = 'frontend' | 'backend' | 'mobile' | 'infra' | 'docs' | 'other';
export type WorkspaceSourceFreshnessStatus =
  | 'unknown'
  | 'fresh'
  | 'stale'
  | 'syncing'
  | 'dirty'
  | 'error';

export interface WorkspaceSource {
  id: string;
  workspaceId: string;
  kind: WorkspaceSourceKind;
  /** Caminho local (folder OU clone do repo). */
  path: string | null;
  /** "owner/repo" pra github_repo; URL ou identificador remoto pra azure_repo. */
  repoFullName: string | null;
  label: string;
  role: WorkspaceSourceRole | null;
  isPrimary: boolean;
  displayOrder: number;
  lastIndexedFingerprint: string | null;
  lastSyncedFingerprint: string | null;
  freshnessStatus: WorkspaceSourceFreshnessStatus | null;
  lastSyncAt: string | null;
  syncDetails: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceAgentAssignment {
  sourceId: string;
  sourceLabel: string;
  sourceRole: WorkspaceSourceRole | null;
  assignedAgentIds: string[];
  assignedAgentNames: string[];
  supportAgentIds: string[];
  supportAgentNames: string[];
  needsNewAgent: boolean;
  recommendedAgentRole: WorkspaceSourceRole | null;
  recommendedAgentName: string | null;
  reason: string;
}

export interface KbSourceCoverageSummary {
  sourceId: string;
  sourceLabel: string;
  sourceKind: WorkspaceSourceKind;
  sourceRole: WorkspaceSourceRole | null;
  location: string | null;
  pageCount: number;
  autoPageCount: number;
  filesScanned: number;
  coveragePages: number;
  latestAnalysis: KbAnalysisJobSummary | null;
  latestEmbedding: KbEmbeddingJobSummary | null;
  assignment: SourceAgentAssignment | null;
  health: 'empty' | 'indexing' | 'ready' | 'failed' | 'stale';
  updatedAt: string | null;
}

/** PR linkado a uma code review pra análise conjunta. */
export interface CodeReviewLinkedPr {
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  role?: WorkspaceSourceRole | null;
}

export type CodeReviewEffort = 'small' | 'medium' | 'large';
export type CodeReviewRecommendation = 'approve' | 'request_changes' | 'comment';
export type CodeReviewChangeKind =
  | 'feature'
  | 'fix'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'chore'
  | 'style';

export interface CodeReviewWalkthroughItem {
  filePath: string;
  summary: string;
  changeKind: CodeReviewChangeKind;
}

export interface CodeReviewFileChange {
  filePath: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface CodeReview {
  id: string;
  workspaceId: string;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prAuthor: string | null;
  headRef: string | null;
  baseRef: string | null;
  headSha: string | null;
  htmlUrl: string;
  reviewerAgentId: string | null;
  status: CodeReviewStatus;
  summary: string | null;
  riskLevel: string | null;
  errorMessage: string | null;
  totalComments: number;
  bugCount: number;
  suggestionCount: number;
  securityCount: number;
  styleCount: number;
  performanceCount: number;
  questionCount: number;
  postedToGithubAt: string | null;
  githubReviewId: string | null;
  /** 0-10 — score geral. */
  rating: number | null;
  effort: CodeReviewEffort | null;
  recommendation: CodeReviewRecommendation | null;
  testsAssessment: string | null;
  walkthrough: CodeReviewWalkthroughItem[];
  filesChanged: CodeReviewFileChange[];
  highlights: string[];
  concerns: string[];
  linkedPrs: CodeReviewLinkedPr[];
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

export interface CodeReviewComment {
  id: string;
  reviewId: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  kind: CodeReviewCommentKind;
  severity: CodeReviewSeverity;
  title: string | null;
  message: string;
  suggestion: string | null;
  diffHunk: string | null;
  codeContext: string | null;
  resolution: 'pending' | 'resolved' | 'ignored';
  githubCommentId: string | null;
  createdAt: string;
}

export interface Goal {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  status: 'active' | 'achieved' | 'archived';
  progress: number;
  ownerAgentId: string | null;
  parentGoalId: string | null;
  /** Sessão de chat do planejamento (dedup por id do objetivo). */
  planSessionId: string | null;
  /** Sessão de chat da verificação de conclusão. */
  verifySessionId: string | null;
  /** HORIZON: teto de tokens (in+out) pros runs vinculados. Null = sem teto. */
  tokenBudget: number | null;
  /** HORIZON: turnos de convergência já rodados pelo CEO (cap anti-loop). */
  convergenceCount: number;
  /** HORIZON: último turno de convergência (rate-limit). */
  lastConvergenceAt: string | null;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityEntry {
  id: string;
  workspaceId: string;
  kind: string;
  actorKind: 'user' | 'agent' | 'system';
  actorId: string | null;
  subjectKind: string | null;
  subjectId: string | null;
  title: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Arquivo anexado a um comentário de issue (ou nota de decisão de plano). */
export interface IssueAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Path absoluto no disco (em ~/.orkestral/.../attachments). */
  path: string;
}

export interface IssueComment {
  id: string;
  issueId: string;
  authorAgentId: string | null;
  authorKind: 'user' | 'agent' | 'system';
  body: string;
  attachments: IssueAttachment[];
  createdAt: string;
}

/** Arquivo de instrução do agente (AGENTS.md, HEARTBEAT.md, etc.) */
export interface AgentInstructionFile {
  /** Nome do arquivo (ex: "AGENTS.md") */
  name: string;
  /** Path absoluto no disco */
  path: string;
  /** Tamanho em bytes */
  size: number;
  /** True se é o arquivo de entrada (default: AGENTS.md) */
  isEntry: boolean;
  /** Última modificação em ISO */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Knowledge Base
// ---------------------------------------------------------------------------

export type KbPageKind = 'doc' | 'index' | 'auto-generated' | 'agent-memory';
export type KbLinkTargetKind = 'page' | 'entity' | 'external';

export interface KbPage {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  slug: string;
  kind: KbPageKind;
  /** BlockNote JSON serializado (preferido). */
  contentJson: string | null;
  /** Fallback markdown plain (auto-generated / migrações). */
  contentMd: string | null;
  icon: string | null;
  sortOrder: number;
  isPinned: boolean;
  isArchived: boolean;
  sourceId: string | null;
  createdByAgentId: string | null;
  /** Quantas vezes a página foi recuperada pelo kb_search (memória "lembrada"). */
  retrievalCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KbPageNode extends KbPage {
  children: KbPageNode[];
  /** Quantidade total de descendentes (recursivo). */
  descendantCount: number;
}

export interface KbLink {
  id: string;
  workspaceId: string;
  sourcePageId: string;
  targetKind: KbLinkTargetKind;
  targetId: string | null;
  targetLabel: string | null;
  targetUrl: string | null;
  strength: number;
  createdAt: string;
}

export interface KbBacklink {
  sourcePageId: string;
  sourcePageTitle: string;
  sourcePageSlug: string;
  label: string | null;
  /** Posição opcional (para preview de contexto futuro). */
  context?: string | null;
}

export type KbEntityKind =
  | 'tech'
  | 'concept'
  | 'person'
  | 'project'
  | 'tool'
  | 'service'
  | 'pattern'
  | 'other';

export interface KbEntity {
  id: string;
  workspaceId: string;
  kind: KbEntityKind;
  name: string;
  slug: string;
  description: string | null;
  mentionCount: number;
  lastMentionedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KbRelation {
  id: string;
  workspaceId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  weight: number;
  createdAt: string;
}

export interface KbSearchHit {
  pageId: string;
  title: string;
  slug: string;
  sourceId: string | null;
  excerpt: string;
  score: number;
  /**
   * Origem do hit: 'kb' = página de conhecimento (prosa escrita pela IA),
   * 'code' = trecho de CÓDIGO-FONTE real indexado. Ausente/undefined = 'kb'
   * (retrocompat). Hits 'code' carregam provenance file:line (`file`, `startLine`,
   * `endLine`) e usam um `pageId` sintético prefixado por `code:`.
   */
  sourceKind?: 'kb' | 'code';
  /** Caminho RELATIVO do arquivo (só em hits `code`). */
  file?: string;
  /** Linha inicial 1-based do trecho (só em hits `code`). */
  startLine?: number;
  /** Linha final 1-based do trecho (só em hits `code`). */
  endLine?: number;
  lexicalScore?: number;
  semanticScore?: number;
  retrievalMode?: 'lexical' | 'semantic' | 'hybrid';
  explanation?: string[];
  bestChunkTitle?: string;
  rerankSignals?: {
    recency?: number;
    usage?: number;
    feedback?: number;
    localRerank?: number;
    queryCoverage?: number;
    titleMatch?: number;
    phraseMatch?: number;
  };
  citation?: {
    pageId: string;
    title: string;
    slug: string;
    chunkTitle?: string;
    snippet: string;
  };
  parentId: string | null;
  kind: KbPageKind;
}

export interface KbSearchFilters {
  kinds?: KbPageKind[];
  sourceId?: string | null;
  includeArchived?: boolean;
  updatedAfter?: string | null;
  requireUsage?: boolean;
  minScore?: number;
}

export interface AiTrainingExample {
  id: string;
  workspaceId: string;
  sourceKind: 'issue_run' | 'chat' | 'rag_feedback' | 'manual';
  sourceId: string | null;
  taskType: 'code' | 'reasoning' | 'retrieval' | 'planning' | 'review';
  inputText: string;
  expectedOutput: string | null;
  actualOutput: string | null;
  label: 'positive' | 'negative' | 'correction' | 'neutral';
  metadataJson: string | null;
  status: 'candidate' | 'approved' | 'exported' | 'ignored';
  createdAt: string;
  updatedAt: string;
}

export interface RagEvaluationRun {
  id: string;
  workspaceId: string;
  query: string;
  expectedPageIdsJson: string[];
  resultPageIdsJson: string[];
  metricsJson: Record<string, unknown>;
  status: 'passed' | 'failed' | 'needs_review';
  createdAt: string;
}

export interface TrainingDatasetExport {
  path: string;
  manifestPath: string;
  format: 'jsonl' | 'chat-jsonl' | 'trajectory-jsonl';
  trainCount: number;
  validationCount: number;
  ignoredCount: number;
}

export interface TrainingPackExport {
  dir: string;
  manifestPath: string;
  trainPath: string;
  validationPath: string;
  rejectedPath: string;
  format: 'trajectory-jsonl';
  trainCount: number;
  validationCount: number;
  rejectedCount: number;
  approvedInputCount: number;
  candidateInputCount: number;
  ignoredInputCount: number;
}

export interface FineTuningReadinessSource {
  sourceId: string | null;
  sourceLabel: string;
  total: number;
  usable: number;
  ignored: number;
  avgLearningScore: number;
  highQuality: number;
}

export interface FineTuningReadiness {
  workspaceId: string;
  totalExamples: number;
  usableExamples: number;
  approvedExamples: number;
  exportedExamples: number;
  candidateExamples: number;
  ignoredExamples: number;
  invalidatedByUndo: number;
  avgLearningScore: number;
  highQualityExamples: number;
  readinessScore: number;
  status: 'empty' | 'collecting' | 'curate' | 'ready_to_export' | 'ready_to_train';
  /** Dataset curado/exportável está pronto para alimentar um treino. */
  datasetReady: boolean;
  /** Treino de pesos/adapters local está disponível nesta build. */
  weightTrainingAvailable: boolean;
  trainingStage:
    | 'memory_learning'
    | 'dataset_curation'
    | 'dataset_ready'
    | 'adapter_training_pending';
  recommendation: string;
  sources: FineTuningReadinessSource[];
}

export interface RagBenchmarkSummary {
  total: number;
  passed: number;
  failed: number;
  needsReview: number;
  avgPrecisionAtK: number;
  avgRecallAtK: number;
  avgMrr: number;
  runIds: string[];
}

export interface MultiAgentPlanRole {
  role: 'researcher' | 'memory' | 'executor' | 'reviewer' | 'safety';
  title: string;
  objective: string;
  requiredEvidence: string[];
}

export interface MultiAgentRunSummary {
  id: string;
  workspaceId: string;
  issueId: string | null;
  runId: string | null;
  status: 'planned' | 'running' | 'completed' | 'failed' | 'cancelled';
  plan: { roles: MultiAgentPlanRole[] };
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeCleanupSuggestion {
  id: string;
  kind: string;
  title: string;
  summary: string;
  reason: string;
  estimatedBytes: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Snapshot do grafo da KB pro visualizador galaxy. */
export interface KbGraphNode {
  id: string;
  kind: 'page' | 'entity';
  label: string;
  /** Tipo refinado (page.kind ou entity.kind). */
  subtype: string;
  /** Conta de conexões — orienta tamanho/posição no layout. */
  degree: number;
  /** Conteúdo curto pra hover. */
  excerpt?: string;
  /** Hierarquia (páginas). null = raiz; entidades sempre null. */
  parentId?: string | null;
  /** Repo de origem (páginas). non-null => página de repo = candidata a planeta. */
  sourceId?: string | null;
  /** Volume de conteúdo indexado em chunks (páginas; 0 pra entidades). */
  chunkCount?: number;
  /** Recuperações via kb_search (páginas) — alimenta o "heat" do corpo. */
  retrievalCount?: number;
  /** Menções acumuladas (entidades) — tamanho/brilho da estrela. */
  mentionCount?: number;
  /** ISO — dispara o shimmer "virando KB" e a aurora <7d. */
  updatedAt?: string;
  createdAt?: string;
  isPinned?: boolean;
}

export interface KbGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: 'wikilink' | 'relation';
  label?: string | null;
  weight: number;
}

/** Hub (nó mais conectado) pro indicador "Top Hubs" do HUD. */
export interface KbGraphHub {
  id: string;
  label: string;
  kind: 'page' | 'entity';
  degree: number;
  /** É um planeta (página raiz/repo) e não uma lua/estrela. */
  isPlanet: boolean;
}

/** Telemetria agregada do grafo — alimenta os indicadores premium do HUD. */
export interface KbGraphStats {
  totalPages: number;
  totalEntities: number;
  /** Total de chunks indexados (≈ volume de conhecimento). */
  totalChunks: number;
  /** Soma de retrievalCount de todas as páginas. */
  totalRetrievals: number;
  /** Páginas criadas nos últimos 7 dias. */
  recentlyAddedCount: number;
  edgeCount: number;
  /** Top 5 nós por grau de conexão. */
  topHubs: KbGraphHub[];
  /** Distribuição por camada/subtype (chave → contagem), ordem estável. */
  layerDistribution: Array<{ key: string; count: number }>;
  /** Componentes conectados de relações entre entidades com >=2 membros. */
  constellationCount: number;
  /** Contagens por dia dos últimos 7 dias (mais antigo → hoje) pro sparkline. */
  weeklyGrowth: number[];
  /** Páginas adicionadas mais recentemente (até 3) pra lista "virando KB". */
  recentPages: Array<{ id: string; title: string }>;
}

export interface KbGraph {
  nodes: KbGraphNode[];
  edges: KbGraphEdge[];
  stats: KbGraphStats;
}

/** Stats vazias — fallback quando ainda não há grafo carregado. */
export const EMPTY_KB_STATS: KbGraphStats = {
  totalPages: 0,
  totalEntities: 0,
  totalChunks: 0,
  totalRetrievals: 0,
  recentlyAddedCount: 0,
  edgeCount: 0,
  topHubs: [],
  layerDistribution: [],
  constellationCount: 0,
  weeklyGrowth: [0, 0, 0, 0, 0, 0, 0],
  recentPages: [],
};

/** Evento durante análise de repositório (gera KB). */
export type KbAnalyzeEvent =
  | {
      type: 'analyze-start';
      jobId: string;
      workspaceId: string;
      sourceId: string;
      sourceLabel?: string;
    }
  | {
      type: 'analyze-phase';
      jobId: string;
      phase: string;
      message: string;
      workspaceId?: string;
      sourceId?: string;
      sourceLabel?: string;
    }
  | {
      type: 'analyze-progress';
      jobId: string;
      current: number;
      total: number;
      file?: string;
      workspaceId?: string;
      sourceId?: string;
      sourceLabel?: string;
    }
  | {
      type: 'analyze-done';
      jobId: string;
      workspaceId?: string;
      sourceId?: string;
      sourceLabel?: string;
      pagesCreated: number;
      entitiesCreated: number;
      relationsCreated: number;
      filesScanned?: number;
      coveragePages?: number;
    }
  | {
      type: 'analyze-error';
      jobId: string;
      error: string;
      workspaceId?: string;
      sourceId?: string;
      sourceLabel?: string;
    };

export type KbEmbeddingJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface KbEmbeddingJobSummary {
  id: string;
  workspaceId: string;
  sourceId?: string | null;
  sourceLabel?: string | null;
  reason: 'page-write' | 'workspace-rebuild' | 'manual';
  status: KbEmbeddingJobStatus;
  current: number;
  total: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type KbEmbeddingEvent =
  | {
      type: 'embedding-queued';
      job: KbEmbeddingJobSummary;
    }
  | {
      type: 'embedding-progress';
      job: KbEmbeddingJobSummary;
      pageId?: string;
      title?: string;
    }
  | {
      type: 'embedding-done';
      job: KbEmbeddingJobSummary;
    }
  | {
      type: 'embedding-error';
      job: KbEmbeddingJobSummary;
      error: string;
    }
  | {
      type: 'embedding-cancelled';
      job: KbEmbeddingJobSummary;
    };

export interface ChatSession {
  id: string;
  workspaceId: string;
  agentId: string;
  title: string;
  lastModel?: string | null;
  lastDirectory?: string | null;
  /** Conversa arquivada — fica fora da lista de Recentes. */
  isArchived?: boolean;
  /** Canal de origem (telegram/whatsapp/…) quando a sessão veio de mensageria. */
  channelType?: ChannelType | null;
  /** Sessão do CLI (claude --resume) do último turno OK — null = próximo turno é fresh. */
  cliSessionId?: string | null;
  /** Fingerprint do contexto estático do 1º turno da sessão CLI (mudou → fresh). */
  cliSessionFingerprint?: string | null;
  /** Última mensagem que a sessão CLI viu — turnos resumidos mandam só o delta. */
  cliLastMessageId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Canais de mensageria suportados. WhatsApp primeiro; os outros são roadmap. */
export type ChannelType = 'whatsapp' | 'telegram' | 'discord' | 'msteams' | 'signal';

/** Estado de conexão observável de uma conta de canal. */
export type ChannelStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

/** Conta de um canal conectada (ou em processo de conexão). */
export interface ChannelAccount {
  id: string;
  channelType: ChannelType;
  workspaceId: string;
  agentId: string;
  status: ChannelStatus;
  selfId?: string | null;
  /** Guard: dígitos normalizados dos números autorizados a conversar. Vazio = ninguém. */
  allowlist: string[];
  lastConnectedAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Snapshot que a UI consome: a conta + dados derivados (QR atual quando em
 * pareamento, contagem de conversas ativas). `qrDataUrl` só vem preenchido
 * enquanto `status === 'qr'`.
 */
export interface ChannelAccountSnapshot extends ChannelAccount {
  qrDataUrl?: string | null;
  sessionCount: number;
  /** Discord/Teams: já tem credencial salva (cifrada)? */
  hasToken?: boolean;
  /** Teams: URL local do messaging endpoint (pra expor via túnel no Azure). */
  endpoint?: string | null;
}

/** Proveniência de uma sessão de chat que veio de um canal (pra UI). */
export interface ChannelSessionMeta {
  chatSessionId: string;
  channelType: ChannelType;
  /** Número de telefone real do interlocutor. */
  phone: string | null;
  /** Nome de exibição (pushName do WhatsApp). */
  displayName: string | null;
  /** URL da foto de perfil (quando pública). */
  photoUrl: string | null;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  parts: MessagePart[];
  status: MessageStatus;
  runId?: string | null;
  createdAt: string;
  /** Mirror de execução de issue em background (não bloqueia o composer do chat). */
  synthetic?: boolean;
}

/** Eventos enviados pelo main durante o streaming de uma response. */
export type ChatStreamEvent =
  | {
      type: 'message-start';
      runId: string;
      messageId: string;
      sessionId: string;
      /** Stream sintético (mirror de execução de issue): não bloqueia o composer. */
      synthetic?: boolean;
    }
  | { type: 'context-compact'; sessionId: string; message: ChatMessage }
  /** Mensagem do usuário inserida fora do renderer (ex.: chegou por um canal/WhatsApp)
   *  — o renderer precisa plantar a bolha ao vivo na sessão aberta. */
  | { type: 'user-message'; sessionId: string; message: ChatMessage }
  | { type: 'text-delta'; runId: string; messageId: string; delta: string }
  /** SUBSTITUI o texto da mensagem (vs text-delta que anexa). Usado pelo build do engine-v2
   *  pra redesenhar a checklist (marcar os checkboxes) ao vivo. */
  | { type: 'text-set'; runId: string; messageId: string; text: string }
  | { type: 'thinking-delta'; runId: string; messageId: string; delta: string }
  | { type: 'tool-call'; runId: string; messageId: string; part: MessagePart }
  | {
      type: 'phase';
      runId: string;
      messageId: string;
      phase: 'starting' | 'thinking' | 'tool' | 'writing';
      label?: string;
    }
  | { type: 'message-end'; runId: string; messageId: string; status: MessageStatus }
  | {
      /**
       * Parts FINAIS canônicas persistidas no DB ao fechar o run. Emitido logo
       * antes do `message-end` quando o finishRun reescreve o texto (refs de
       * issues, restauração do textBuffer, avisos, fallback) — a UI substitui as
       * parts do store por estas pra refletir o DB sem reload.
       */
      type: 'message-final';
      runId: string;
      messageId: string;
      parts: MessagePart[];
    }
  | { type: 'error'; runId: string; messageId: string; error: string };

/** Eventos broadcast durante a clonagem de um source GitHub. */
export interface SourceCloneEvent {
  sourceId?: string;
  workspaceId: string;
  repoFullName: string;
  phase: 'start' | 'progress' | 'done' | 'failed';
  message: string;
}

/** Eventos broadcast durante uma code review. */
export type CodeReviewEvent =
  | {
      type: 'review-started';
      reviewId: string;
      workspaceId: string;
      repoFullName: string;
      prNumber: number;
    }
  | { type: 'review-phase'; reviewId: string; phase: string; message: string }
  | { type: 'review-stdout'; reviewId: string; chunk: string }
  | { type: 'review-stderr'; reviewId: string; chunk: string }
  | { type: 'review-finished'; reviewId: string; status: 'completed' | 'failed' };

// ---------------------------------------------------------------------------
// GitHub integration
// ---------------------------------------------------------------------------

/** Conta GitHub conectada via Device Flow. Não exporta o token em si. */
export interface GithubAccount {
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  scope: string;
  connectedAt: string;
}

/** Resposta do POST /login/device/code do GitHub (campos relevantes pro UI). */
export interface GithubDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** Resultado de um poll do device flow — informa o status corrente. */
export type GithubDeviceFlowStatus =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'authorized'; account: GithubAccount };

export interface GithubPullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  author: string;
  authorAvatarUrl: string | null;
  headRef: string;
  baseRef: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  comments: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
}

export interface GithubRepoSummary {
  fullName: string;
  name: string;
  owner: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
  htmlUrl: string;
  cloneUrl: string;
  updatedAt: string | null;
  pushedAt: string | null;
}

export type CodeThemeId =
  | 'default'
  | 'dracula'
  | 'monokai'
  | 'github'
  | 'oneDark'
  | 'tokyoNight'
  | 'nord'
  | 'solarized';

export interface AzureDevopsAccount {
  displayName: string | null;
  email: string | null;
  tenantId: string | null;
  scope: string;
  connectedAt: string;
  expiresAt: string;
  organizations: string[];
}

export interface AzureDevopsDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  message: string;
  expiresIn: number;
  interval: number;
}

export type AzureDevopsDeviceFlowStatus =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'authorized'; account: AzureDevopsAccount };

export interface AzureDevopsRepoSummary {
  id: string;
  organization: string;
  projectId: string;
  projectName: string;
  name: string;
  fullName: string;
  defaultBranch: string | null;
  remoteUrl: string;
  webUrl: string | null;
  sshUrl: string | null;
  size: number | null;
}

export type SettingsRecord = {
  appearance: {
    theme: 'dark' | 'light' | 'system';
    /** Idioma da UI. 'system' = segue o locale do SO (pt* → pt-BR, senão en). */
    language: 'system' | 'pt-BR' | 'en';
    fontSize: 'sm' | 'md' | 'lg';
    density: 'compact' | 'comfortable';
    accentColor: 'purple' | 'blue' | 'green' | 'yellow' | 'red' | 'orange';
    extraWideChat: boolean;
    codeBlockWrap: boolean;
    /** Tema de código que recolore o app inteiro (chrome). 'default' = tokens base. */
    codeTheme: CodeThemeId;
  };
  system: {
    launchOnStartup: boolean;
    notifications: boolean;
    notificationSound: boolean;
    /** Alerta (visual + som) quando chega tarefa nova no Inbox. */
    inboxNotifications: boolean;
    timeFormat: '12h' | '24h';
    showAppIn: 'dock-and-status' | 'dock' | 'status';
    hardwareAcceleration: boolean;
  };
  privacy: {
    localTelemetry: boolean;
    cloudSync: boolean;
    maskSecrets: boolean;
    blockSensitiveFiles: boolean;
    askBeforeExternalContext: boolean;
    privateMode: boolean;
  };
  audio: {
    /** deviceId do microfone escolhido. null = padrão do sistema. */
    inputDeviceId: string | null;
    /** deviceId da saída de áudio escolhida. null = padrão do sistema. */
    outputDeviceId: string | null;
  };
  aiRouting: AiRoutingSettings;
  knowledge: {
    /** Se ativo, exemplos de aprendizado acima do score mínimo pulam curadoria humana. */
    autoApproveTrainingExamples: boolean;
    /** Score mínimo 0..1 para auto-aprovar um candidato de fine-tuning. */
    autoApprovalMinScore: number;
  };
  /** Preset de desempenho/memória — decide a variante do Forge + footprint local. */
  performance: {
    preset: PerformancePreset;
  };
};

export type KbAnalysisJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface KbAnalysisJobSummary {
  id: string;
  workspaceId: string;
  sourceId: string | null;
  sourceLabel: string;
  status: KbAnalysisJobStatus;
  phase: string | null;
  message: string | null;
  filesScanned: number;
  pagesCreated: number;
  entitiesCreated: number;
  relationsCreated: number;
  coveragePages: number;
  embeddingJobId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type HybridModelRoutingMode = 'off' | 'observe' | 'ask' | 'local_assist' | 'local_first';

export type ModelRoutingPhase =
  | 'source_classification'
  | 'kb_coverage'
  | 'kb_summary'
  | 'rag_search'
  | 'rag_rerank'
  | 'agent_assignment'
  | 'cleanup_suggestion'
  | 'chat_answer'
  | 'architecture_plan'
  | 'code_edit'
  | 'test_fix'
  | 'command_execution';

export interface AiRoutingSettings {
  enabled: boolean;
  mode: HybridModelRoutingMode;
  localModelRequired: boolean;
  preserveCliContext: boolean;
  requireApprovalForLocal: boolean;
  maxLocalRisk: TaskRisk;
  preferLocalPhases: ModelRoutingPhase[];
  /**
   * Quando o agente Forge local NÃO resolve uma issue (ex.: investigação, que
   * não gera edição de arquivo), escalar pro modelo premium pra concluir.
   * Ligado por padrão: o Forge economiza onde dá e o premium garante que o
   * trabalho termina. Desligar = modo economia-máxima (a issue bloqueia e pede
   * ajuda em vez de gastar premium).
   */
  allowPremiumFallback: boolean;
  /**
   * COMPORTAMENTO DO AGENTE: quantas vezes o Forge local tenta resolver a issue
   * (cada tentativa é uma execução local completa) ANTES de cair pro fallback
   * premium. O modelo local tem amostragem, então uma nova tentativa pode acertar
   * onde a anterior falhou. Mín. 1, teto razoável (5). Default 2.
   */
  localAttemptsBeforeFallback: number;
}

export interface ModelRoutingDecision {
  id: string;
  executor: 'cli' | 'local' | 'none';
  phase: ModelRoutingPhase;
  mode: HybridModelRoutingMode;
  risk: TaskRisk;
  requiresApproval: boolean;
  preservesCliContext: boolean;
  contextPolicy: 'cli-native' | 'context-pack' | 'no-context';
  reason: string;
  estimatedInputTokensAvoided: number;
  estimatedOutputTokensAvoided: number;
}

// ---------------------------------------------------------------------------
// Execução inteligente de tasks/issues (camada de economia de tokens)
// ---------------------------------------------------------------------------

export type TaskRisk = 'low' | 'medium' | 'high';
/**
 * Como executar a task:
 *  - no_llm        → lógica determinística do app (sem IA)
 *  - local_patch   → modelo local (llama.cpp) só gera unified diff; app aplica
 *  - premium_model → modelo premium configurável (caminho de execução atual)
 */
export type ExecutionMode =
  | 'no_llm'
  | 'local_patch'
  | 'premium_model'
  | 'local_deliverable'
  // Caminho BARATO: o premium gera um lazy-edit compacto por arquivo (1 call, sem
  // MCP/reler repo) e o app aplica determinístico (morph/fast-apply); escala pro run
  // premium completo em qualquer falha. Economiza vs sempre rodar o agente inteiro.
  | 'premium_edit';

/** Provider premium — `agent` reusa o adapter já configurado no agente. */
export type PremiumProvider = 'agent' | 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'custom';

export interface SmartExecConfig {
  /** Liga a camada inteligente. Off por padrão (mantém comportamento atual). */
  enabled: boolean;
  premium: {
    provider: PremiumProvider;
    /** Modelo premium configurável — nunca hardcoded. Vazio = usa o do agente. */
    model: string;
    apiKeyRef: string;
    baseUrl: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    temperature: number;
    /**
     * Preço de REFERÊNCIA (não cobrado — só pra estimar a economia visível). Quando
     * o Forge resolve local, o premium NÃO roda, então não há custo medido; este
     * preço estima o que o premium TERIA gastado pelo mesmo trabalho (tokens
     * evitados × preço). Default: Claude Sonnet. NUNCA é o preço real cobrado.
     */
    referencePricing: {
      inputUsdPerMTok: number;
      outputUsdPerMTok: number;
      label: string;
    };
  };
  local: {
    runtime: 'llama.cpp';
    binaryPath: string;
    modelPath: string;
    serverHost: string;
    serverPort: number;
    idleUnloadSeconds: number;
    maxPromptTokens: number;
    maxOutputTokens: number;
    allowGpu: boolean;
    timeoutMs: number;
    /**
     * Temperatura de amostragem. 0 = greedy/determinístico (tentativa 1). As
     * tentativas de retry (best-of-N) sobem a temperatura pra gerar candidatos
     * DIVERSOS — num modelo pequeno a variância é alta, então uma amostra diferente
     * acerta onde a gulosa falhou; o verificador determinístico (apply + validação)
     * fica com o primeiro que passa. Opcional (default 0).
     */
    samplingTemperature?: number;
    /** Seed por tentativa pra garantir diversidade entre retries. Opcional. */
    samplingSeed?: number;
  };
  thresholds: {
    maxChangedLines: number;
    maxAffectedFiles: number;
  };
  retry: {
    maxLocalPatchAttempts: number;
    maxLocalFixAttempts: number;
    /** Rodadas de validação→correção LOCAL antes de desistir (nunca premium). */
    maxLocalValidationRounds: number;
    fallbackAfterLocalFailure: boolean;
  };
  /** Globs de arquivos/áreas críticas → forçam premium_model. */
  criticalGlobs: string[];
  /** Se true, permite local_patch em áreas críticas (exige opt-in explícito). */
  allowLocalOnCritical: boolean;
}

export interface FallbackPolicy {
  onPatchFailure: 'retry_local_once' | 'premium_model';
  onValidationFailure: 'retry_local_once_then_premium' | 'premium_model';
  onHighRiskDetected: 'premium_model';
  onLargeDiff: 'premium_model';
}

export interface TaskClassification {
  risk: TaskRisk;
  executionMode: ExecutionMode;
  reason: string;
  affectedFiles: string[];
  /**
   * Arquivos a CRIAR (intenção de "criar migration/model/component/..."). São
   * caminhos NOVOS que ainda não existem no repo, separados de affectedFiles
   * (edições de arquivos existentes) pra que a task de criação gere um arquivo
   * novo em vez de editar um existente que a busca encontrou — o bug das migrations
   * core sendo sobrescritas. Vazio quando não há intenção de criação.
   */
  createFiles: string[];
  validationCommands: string[];
  fallbackPolicy: FallbackPolicy;
  /** Issue non-code (Design/QA): o deliverable é um TEXTO (spec/relatório), não um
   *  diff. Definido só quando executionMode === 'local_deliverable'. */
  deliverableKind?: 'design' | 'qa';
}

export interface ExecutionPlanTask {
  id: string;
  file: string;
  instruction: string;
  allowedActions: string[];
  forbiddenActions: string[];
  outputFormat: 'unified_diff';
  maxChangedLines: number;
  validationCommands: string[];
  /**
   * Task de CRIAÇÃO de arquivo novo (não edição). O executor gera o arquivo
   * inteiro do zero (generateLocalWholeFile, sem conteúdo existente) e RECUSA se o
   * caminho já existir (nunca sobrescreve um arquivo existente).
   */
  createNew?: boolean;
}

export interface ExecutionPlan {
  goal: string;
  risk: TaskRisk;
  executionMode: ExecutionMode;
  tasks: ExecutionPlanTask[];
  fallbackPolicy: FallbackPolicy;
}

export interface ExecutionMetrics {
  premiumAvoided: boolean;
  estimatedPremiumInputTokensAvoided: number;
  estimatedPremiumOutputTokensAvoided: number;
  localExecutionUsed: boolean;
  localRuntime: string | null;
}

/**
 * Veredito de verificação de uma issue concluída. 'verified' = mudança de código
 * passou na validação; 'unverified' = mudança de código existiu mas a validação
 * foi pulada/falhou/não rodou; 'not_applicable' = nenhuma mudança de código (ex.:
 * investigação/KB). Persistido em `issue.metadata.verification`, NÃO em IssueStatus.
 */
export type IssueVerificationState = 'verified' | 'unverified' | 'not_applicable';

/** Registro persistido de uma execução inteligente. */
export interface TaskExecutionRecord {
  id: string;
  issueId: string | null;
  runId: string | null;
  workspaceId: string | null;
  executionMode: ExecutionMode;
  modelUsed: 'local' | 'premium' | 'none';
  risk: TaskRisk;
  filesChanged: string[];
  diffSummary: string;
  validationResult: 'passed' | 'failed' | 'skipped';
  fallbackUsed: boolean;
  failureReason: string | null;
  attempts: number;
  durationMs: number | null;
  metrics: ExecutionMetrics;
  createdAt: string;
}

export interface SmartExecMetricsSummary {
  totalExecutions: number;
  localExecutions: number;
  premiumEscalations: number;
  premiumAvoidedCount: number;
  estimatedInputTokensAvoided: number;
  estimatedOutputTokensAvoided: number;
}

/** Severidade de uma linha de trace (define a cor no terminal de logs). */
export type TraceLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

/** Origem de uma linha de trace (badge colorido no terminal de logs). */
export type TraceSource =
  | 'forge'
  | 'embedding'
  | 'issue'
  | 'chat'
  | 'review'
  | 'learning'
  | 'system'
  | 'model-routing';

/**
 * Uma linha do trace de execução unificado (página Logs). Emitida pelo LogBus
 * no main e transmitida ao vivo pro renderer via evento `logs:entry`.
 */
export interface TraceEntry {
  id: string;
  /** epoch ms */
  ts: number;
  level: TraceLevel;
  source: TraceSource;
  /** Subsistema fino (ex: 'inference', 'classify', 'run'). */
  scope?: string | null;
  message: string;
  workspaceId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  /** Chave numérica da issue (ex: 12) quando a linha vem de uma execução. */
  issueKey?: string | number | null;
  /** ms de duração, quando a linha representa o fim de uma operação. */
  durationMs?: number | null;
}

export type AgentTraceEventKind =
  | 'run'
  | 'plan'
  | 'retrieve'
  | 'read'
  | 'generate'
  | 'tool'
  | 'patch'
  | 'validate'
  | 'learn'
  | 'fallback'
  | 'error';

export type AgentTraceEventStatus = 'started' | 'completed' | 'failed' | 'skipped';

/**
 * Evento estruturado da timeline local do agente. Diferente de TraceEntry, que e
 * uma linha de log curta, este registro guarda payload e relacoes entre passos
 * para a UI explicar exatamente o que a IA consultou, decidiu e executou.
 */
export interface AgentTraceEvent {
  id: string;
  workspaceId: string;
  runId?: string | null;
  issueId?: string | null;
  issueKey?: string | number | null;
  agentId?: string | null;
  agentName?: string | null;
  parentId?: string | null;
  kind: AgentTraceEventKind;
  status: AgentTraceEventStatus;
  title: string;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
  startedAt: string;
  completedAt?: string | null;
  durationMs?: number | null;
}

// ===== Voice Mode (STT infra instalável) =====

/** Um arquivo baixável do Voice Pack. */
export interface VoicePackComponent {
  id: string;
  /** Rótulo legível pra UI de progresso (já em pt/en via i18n no front). */
  label: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  /** Caminho relativo dentro de ~/.orkestral/.../voice (ex: 'models/stt/x.bin'). */
  dest: string;
  /** Se setado, só baixa nessa plataforma. Formato `${platform}-${arch}` (ex: 'darwin-arm64'). Ausente = todas. */
  platform?: string;
  /** chmod +x após baixar (binários). */
  executable?: boolean;
  /**
   * Se setado, o arquivo baixado é um pacote a ser extraído em `dest` (que vira
   * um diretório). Só `'tar.gz'` e `'tar.bz2'` por enquanto. A validação de
   * sha256 roda no pacote baixado ANTES da extração.
   */
  extract?: 'tar.gz' | 'tar.bz2';
  /**
   * Caminho relativo (dentro de `dest` quando `extract`, senão ignorado) do
   * arquivo-sentinela que prova a presença do componente — ex: o `.onnx` de um
   * pacote tar.gz. Quando ausente em componente normal, a presença é o próprio
   * `dest`.
   */
  sentinel?: string;
}

export interface VoicePack {
  id: 'local-voice';
  version: string;
  components: VoicePackComponent[];
}

export type VoiceInstallEvent =
  | { type: 'start'; packId: string; totalBytes: number }
  | { type: 'component-start'; packId: string; componentId: string; label: string }
  | { type: 'progress'; packId: string; receivedBytes: number; totalBytes: number; percent: number }
  | { type: 'component-done'; packId: string; componentId: string }
  | { type: 'done'; packId: string }
  | { type: 'error'; packId: string; error: string };

export interface VoicePackStatus {
  packId: string;
  installed: boolean;
  installing: boolean;
  version: string | null;
  /** ids dos componentes (da plataforma atual) que faltam. */
  missingComponents: string[];
}

/** Resumo serializavel de um run do motor v2 (resposta do canal engine-v2:run-slice). */
export interface EngineV2IssueSummary {
  issueId: string;
  title: string;
  isWalkingSkeleton: boolean;
  doneCount: number;
  blockedCount: number;
}
export interface EngineV2RunSummary {
  /** False quando o plano foi rejeitado na validacao (nao rodou nada). */
  planned: boolean;
  /** Resposta conversacional quando a mensagem NAO era um build (pergunta/conversa). */
  reply?: string;
  planViolations: string[];
  issues: EngineV2IssueSummary[];
  totalDone: number;
  totalBlocked: number;
  /** Linha de economia LIQUIDA honesta (avisa prejuizo). */
  economyLine: string;
  premiumTokens: number;
  localTokens: number;
  /** Preview contextual liberado apos o esqueleto; null se nao. */
  preview: {
    kind: string;
    mode: string;
    url: string | null;
    needsBackendUp: boolean;
    reason: string;
  } | null;
  /** True se o dev server do preview foi ligado de fato. */
  previewLaunched: boolean;
  /** True se o run foi cancelado no meio. */
  cancelled: boolean;
}
