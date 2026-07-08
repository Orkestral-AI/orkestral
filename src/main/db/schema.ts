import { sqliteTable, text, integer, real, blob } from 'drizzle-orm/sqlite-core';

/**
 * Schema SQLite — fase 1 (Fundação).
 * Apenas as tabelas core para boot e settings. Tabelas de issues, agentes,
 * chat, knowledge, code review, integrations etc. serão adicionadas nas
 * fases seguintes conforme o doc 21.
 */

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  aliases: text('aliases', { mode: 'json' }).$type<string[]>().notNull().default([]),
  email: text('email'),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  useDeviceTimezone: integer('use_device_timezone', { mode: 'boolean' }).notNull().default(true),
  language: text('language', { enum: ['pt-BR', 'en', 'es'] })
    .notNull()
    .default('pt-BR'),
  aiStyle: text('ai_style', { enum: ['concise', 'detailed', 'formal', 'casual'] })
    .notNull()
    .default('concise'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  companyName: text('company_name'),
  mission: text('mission'),
  objectives: text('objectives', { mode: 'json' }).$type<string[]>().notNull().default([]),
  // O workspace É um projeto — guarda direto path local + git remote.
  // Modelo novo (v6+): tudo que os agentes fazem é referenciado a este path.
  path: text('path'),
  gitRemote: text('git_remote'),
  provider: text('provider', { enum: ['local', 'github', 'azure'] }),
  icon: text('icon'),
  color: text('color'),
  planMode: text('plan_mode', { enum: ['local', 'team'] })
    .notNull()
    .default('local'),
  activeProjectId: text('active_project_id'),
  /** ISO timestamp do arquivamento. Null = ativo. */
  archivedAt: text('archived_at'),
  /** Modelo persistente do usuário neste workspace (estilo USER.md do Hermes). */
  userProfile: text('user_profile'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  path: text('path'),
  gitRemote: text('git_remote'),
  provider: text('provider', { enum: ['local', 'github', 'azure'] }),
  description: text('description'),
  knowledgeBaseStatus: text('knowledge_base_status', {
    enum: ['not_started', 'indexing', 'ready', 'error'],
  })
    .notNull()
    .default('not_started'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Secret store das Ferramentas (key-value cifrado via host.secrets). */
export const toolSecrets = sqliteTable('tool_secrets', {
  key: text('key').primaryKey(),
  valueEncrypted: blob('value_encrypted', { mode: 'buffer' }).notNull(),
  updatedAt: text('updated_at').notNull(),
});
export type ToolSecretRow = typeof toolSecrets.$inferSelect;

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  role: text('role').notNull(),
  title: text('title'),
  // Adapter CLI utilizado (claude_local, codex_local, gemini_local, ...).
  // Substitui o campo "provider" no fluxo novo, mas mantemos provider por
  // retrocompat até migrar tudo.
  adapterType: text('adapter_type'),
  adapterConfig: text('adapter_config', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  provider: text('provider').notNull(),
  model: text('model'),
  effort: text('effort').notNull().default('medium'),
  systemPrompt: text('system_prompt').notNull().default(''),
  status: text('status', { enum: ['idle', 'live', 'paused', 'error'] })
    .notNull()
    .default('idle'),
  isOrchestrator: integer('is_orchestrator', { mode: 'boolean' }).notNull().default(false),
  canCreateAgents: integer('can_create_agents', { mode: 'boolean' }).notNull().default(false),
  canAssignTasks: integer('can_assign_tasks', { mode: 'boolean' }).notNull().default(false),
  canEditFiles: integer('can_edit_files', { mode: 'boolean' }).notNull().default(false),
  canRunCommands: integer('can_run_commands', { mode: 'boolean' }).notNull().default(false),
  // Hierarquia: manager (FK self). Null = raiz da árvore (geralmente CEO).
  reportsTo: text('reports_to'),
  // Seed do avatar DiceBear (estilo bottts). Null = derivado do nome.
  avatarSeed: text('avatar_seed'),
  // Descrição livre do que o agente faz — exibido na config UI.
  capabilities: text('capabilities'),
  // Runtime config: cheap model, thinking effort, bypass sandbox, etc.
  runtimeConfig: text('runtime_config', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  // Pause state — quando status='paused', pauseReason explica por que.
  pauseReason: text('pause_reason'),
  pausedAt: text('paused_at'),
  // Tracking de heartbeat (preparação Fase 2)
  lastHeartbeatAt: text('last_heartbeat_at'),
  // Heartbeat config
  heartbeatEnabled: integer('heartbeat_enabled', { mode: 'boolean' }).notNull().default(false),
  heartbeatIntervalMinutes: integer('heartbeat_interval_minutes').notNull().default(30),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Runs de heartbeat (manual ou scheduler). Cada run é uma execução
 * isolada do CLI com o prompt do HEARTBEAT.md.
 */
export const heartbeatRuns = sqliteTable('heartbeat_runs', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  source: text('source', { enum: ['manual', 'scheduler'] }).notNull(),
  status: text('status', {
    enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
  })
    .notNull()
    .default('queued'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  output: text('output'),
  errorMessage: text('error_message'),
  exitCode: integer('exit_code'),
  durationMs: integer('duration_ms'),
  createdAt: text('created_at').notNull(),
});

export type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;

/** Tokens de API por agente — pra futura comunicação programática. */
export const agentApiKeys = sqliteTable('agent_api_keys', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** SHA-256 do token completo. */
  tokenHash: text('token_hash').notNull(),
  /** Primeiros 8 chars do token, pra mostrar na UI. */
  tokenPreview: text('token_preview').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
});

export type AgentApiKeyRow = typeof agentApiKeys.$inferSelect;

// ---------------------------------------------------------------------------
// Skills + Issues (Fase 3)
// ---------------------------------------------------------------------------

export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['instruction', 'mcp', 'tool'] })
    .notNull()
    .default('instruction'),
  description: text('description'),
  /** Conteúdo principal — markdown pra instruction, JSON config pra mcp/tool. */
  content: text('content').notNull().default(''),
  /** Config extra estruturada. */
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  /** Procedência: 'user'/marketplace (protegida) vs 'agent' (auto-curada). */
  createdBy: text('created_by', { enum: ['user', 'agent'] })
    .notNull()
    .default('user'),
  /** Telemetria + ciclo de vida (estilo Hermes skill_usage). */
  useCount: integer('use_count').notNull().default(0),
  lastUsedAt: text('last_used_at'),
  state: text('state', { enum: ['active', 'archived'] })
    .notNull()
    .default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const agentSkills = sqliteTable('agent_skills', {
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  skillId: text('skill_id')
    .notNull()
    .references(() => skills.id, { onDelete: 'cascade' }),
  addedAt: text('added_at').notNull(),
});

export const issues = sqliteTable('issues', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  issueKey: integer('issue_key').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', {
    enum: ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'],
  })
    .notNull()
    .default('backlog'),
  priority: text('priority', {
    enum: ['low', 'medium', 'high', 'critical'],
  })
    .notNull()
    .default('medium'),
  labels: text('labels', { mode: 'json' }).$type<string[]>().notNull().default([]),
  assigneeAgentId: text('assignee_agent_id'),
  reporterAgentId: text('reporter_agent_id'),
  parentIssueId: text('parent_issue_id'),
  /** Objetivo ao qual essa issue contribui (null = sem objetivo). */
  goalId: text('goal_id'),
  /**
   * Numeração HUMANA (display), desacoplada do issue_key interno:
   *  - top-level (parent_issue_id NULL): displayKey sequencial entre as raízes
   *    do workspace → exibido como PREFIX-{displayKey} (ex.: EZC-4).
   *  - sub-issue: displayKey NULL; usa childOrdinal (posição entre irmãos),
   *    exibido como {display do pai}.{childOrdinal} (ex.: EZC-4.1).
   * Sub-issue NÃO consome o contador de displayKey → raízes ficam contíguas.
   * Ordinais persistidos (estável estilo Linear): apagar deixa buraco, não
   * renumera. issue_key interno permanece intacto (rota/URL/uniqueness).
   */
  displayKey: integer('display_key'),
  childOrdinal: integer('child_ordinal'),
  dueDate: text('due_date'),
  completedAt: text('completed_at'),
  /** Metadata livre — usado pra carregar contexto da execução (kind='kb-analysis', sourceId, etc.). */
  metadataJson: text('metadata_json'),
  /** Monitor agendado (Paperclip): null | 'hourly' | 'daily' | 'weekly'. */
  monitorSchedule: text('monitor_schedule'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Run de execução de uma issue por um agente (single agent ativa por vez). */
export const issueRuns = sqliteTable('issue_runs', {
  id: text('id').primaryKey(),
  issueId: text('issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  agentId: text('agent_id'),
  status: text('status', {
    enum: ['queued', 'running', 'done', 'failed', 'cancelled'],
  })
    .notNull()
    .default('queued'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  errorMessage: text('error_message'),
  outputSummary: text('output_summary'),
  exitCode: integer('exit_code'),
  /** Cost summary — populado quando o stream-json emite `result` com usage. */
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  costUsd: real('cost_usd'),
  toolCallCount: integer('tool_call_count'),
  /**
   * Camada de orquestração (economia de execução). Registrado pelo
   * issue-execution-service quando o Forge resolve localmente ou escala.
   * adapterType: 'orkestral_local' quando o executor foi o Forge local.
   * exitReason: 'local_resolved' (Forge resolveu) | 'escalated_to_premium'
   * (caiu no fallback premium). NULL em runs antigos / não-orquestrados.
   * verified: 1 quando o run atingiu 'done' VERIFICADO (passou no gate de
   * aprovação); 0 quando o trabalho local foi produzido mas reprovado/terminou
   * sem verificação; NULL = sem veredito (run antigo, em andamento, ou ainda
   * aguardando).
   */
  adapterType: text('adapter_type'),
  exitReason: text('exit_reason'),
  verified: integer('verified'),
  /**
   * Counterfactual da economia visível: tokens que o premium TERIA processado
   * (entrada/saída estimadas) pelo trabalho que o Forge resolveu local. Distinto
   * de tokensIn/tokensOut (uso REAL premium): aqui o premium não rodou. NULL em
   * runs não-locais ou antigos. Base do savedUsd estimado por preço de referência.
   */
  cfInTokens: integer('cf_in_tokens'),
  cfOutTokens: integer('cf_out_tokens'),
});

export type IssueRunRow = typeof issueRuns.$inferSelect;

/**
 * Replay persistente do stream fino de execução. Diferente de `issue_runs`
 * (resumo do run) e `agent_trace_events` (observabilidade profunda), esta tabela
 * guarda exatamente os eventos que a UI consome para reconstruir "Working...",
 * ferramentas, troca Forge⇄CLI e arquivos editados após reload/restart.
 */
export const issueExecutionEvents = sqliteTable('issue_execution_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  issueId: text('issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  runId: text('run_id'),
  type: text('type').notNull(),
  payloadJson: text('payload_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export type IssueExecutionEventRow = typeof issueExecutionEvents.$inferSelect;

export const qaValidations = sqliteTable('qa_validations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  issueId: text('issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  executorAgentId: text('executor_agent_id'),
  qaAgentId: text('qa_agent_id'),
  status: text('status', { enum: ['planned', 'running', 'passed', 'failed', 'needs_human'] })
    .notNull()
    .default('planned'),
  summary: text('summary'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export type QaValidationRow = typeof qaValidations.$inferSelect;

export const qaValidationChecks = sqliteTable('qa_validation_checks', {
  id: text('id').primaryKey(),
  validationId: text('validation_id')
    .notNull()
    .references(() => qaValidations.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  commandHint: text('command_hint'),
  status: text('status', { enum: ['pending', 'running', 'passed', 'failed', 'skipped'] })
    .notNull()
    .default('pending'),
  evidence: text('evidence'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export type QaValidationCheckRow = typeof qaValidationChecks.$inferSelect;

export const issueCounters = sqliteTable('issue_counters', {
  workspaceId: text('workspace_id').primaryKey(),
  lastValue: integer('last_value').notNull().default(0),
});

export const issueComments = sqliteTable('issue_comments', {
  id: text('id').primaryKey(),
  issueId: text('issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  authorAgentId: text('author_agent_id'),
  authorKind: text('author_kind', { enum: ['user', 'agent', 'system'] })
    .notNull()
    .default('user'),
  body: text('body').notNull(),
  /** Anexos do comentário — JSON array de IssueAttachment. */
  attachments: text('attachments', { mode: 'json' })
    .$type<import('../../shared/types').IssueAttachment[]>()
    .notNull()
    .default([]),
  createdAt: text('created_at').notNull(),
});

export type SkillRow = typeof skills.$inferSelect;
export type AgentSkillRow = typeof agentSkills.$inferSelect;
export type IssueRow = typeof issues.$inferSelect;
export type IssueCommentRow = typeof issueComments.$inferSelect;

/** Activity log — eventos relevantes do workspace pra audit/inbox. */
export const activityLog = sqliteTable('activity_log', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Tipo de evento: issue.created, agent.paused, skill.attached, etc. */
  kind: text('kind').notNull(),
  /** Quem fez: 'user' | 'agent' | 'system'. */
  actorKind: text('actor_kind', { enum: ['user', 'agent', 'system'] })
    .notNull()
    .default('user'),
  actorId: text('actor_id'),
  /** Sobre o quê: 'issue' | 'agent' | 'skill' | 'session' etc. */
  subjectKind: text('subject_kind'),
  subjectId: text('subject_id'),
  title: text('title').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: text('created_at').notNull(),
});

export type ActivityLogRow = typeof activityLog.$inferSelect;

/** Routines: tarefas agendadas que rodam um agente com um prompt custom. */
export const routines = sqliteTable('routines', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  prompt: text('prompt').notNull(),
  intervalMinutes: integer('interval_minutes').notNull().default(60),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', { enum: ['active', 'achieved', 'archived'] })
    .notNull()
    .default('active'),
  progress: integer('progress').notNull().default(0),
  ownerAgentId: text('owner_agent_id'),
  /** Objetivo pai (hierarquia objetivo → sub-objetivos). Null = raiz. */
  parentGoalId: text('parent_goal_id'),
  /** Sessão de chat do planejamento (dedup por goal.id, não por título). */
  planSessionId: text('plan_session_id'),
  /** Sessão de chat da verificação de conclusão. */
  verifySessionId: text('verify_session_id'),
  /** HORIZON: teto de tokens (in+out) pros runs vinculados. Null = sem teto. */
  tokenBudget: integer('token_budget'),
  /** HORIZON: quantos turnos de convergência o CEO já rodou (cap anti-loop). */
  convergenceCount: integer('convergence_count').notNull().default(0),
  /** HORIZON: último turno de convergência (rate-limit). */
  lastConvergenceAt: text('last_convergence_at'),
  dueDate: text('due_date'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * RAG-DE-EDITS (HORIZON Fase 4): exemplos de lazy-edits que o time JÁ aplicou
 * neste workspace. `candidate` ao aplicar → `accepted` quando a issue fecha
 * VERIFICADA (vira few-shot do fast-apply local) | `rejected` quando não.
 * Tabela criada na migration v66; o código fica LOCAL (nunca sai do SQLite).
 */
export const forgeEditExamples = sqliteTable('forge_edit_examples', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  runId: text('run_id'),
  issueId: text('issue_id'),
  file: text('file').notNull(),
  symbol: text('symbol'),
  instruction: text('instruction').notNull(),
  anchorExcerpt: text('anchor_excerpt'),
  acceptedEdit: text('accepted_edit').notNull(),
  editFormat: text('edit_format').notNull().default('lazy'),
  status: text('status', { enum: ['candidate', 'accepted', 'rejected'] })
    .notNull()
    .default('candidate'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type RoutineRow = typeof routines.$inferSelect;
export type GoalRow = typeof goals.$inferSelect;

/** Sources do workspace — múltiplas pastas locais ou repos GitHub. */
export const workspaceSources = sqliteTable('workspace_sources', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['local_folder', 'github_repo', 'azure_repo'] }).notNull(),
  path: text('path'),
  repoFullName: text('repo_full_name'),
  label: text('label').notNull(),
  role: text('role'),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  displayOrder: integer('display_order').notNull().default(0),
  lastIndexedFingerprint: text('last_indexed_fingerprint'),
  lastSyncedFingerprint: text('last_synced_fingerprint'),
  freshnessStatus: text('freshness_status'),
  lastSyncAt: text('last_sync_at'),
  syncDetailsJson: text('sync_details_json', { mode: 'json' }).$type<Record<
    string,
    unknown
  > | null>(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export type WorkspaceSourceRow = typeof workspaceSources.$inferSelect;

/** Code reviews — análise de PRs feita por um agente. */
export const codeReviews = sqliteTable('code_reviews', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  repoFullName: text('repo_full_name').notNull(),
  prNumber: integer('pr_number').notNull(),
  prTitle: text('pr_title').notNull(),
  prAuthor: text('pr_author'),
  headRef: text('head_ref'),
  baseRef: text('base_ref'),
  headSha: text('head_sha'),
  htmlUrl: text('html_url').notNull(),
  reviewerAgentId: text('reviewer_agent_id'),
  status: text('status', {
    enum: ['queued', 'analyzing', 'completed', 'failed', 'cancelled'],
  })
    .notNull()
    .default('queued'),
  summary: text('summary'),
  riskLevel: text('risk_level'),
  errorMessage: text('error_message'),
  totalComments: integer('total_comments').notNull().default(0),
  bugCount: integer('bug_count').notNull().default(0),
  suggestionCount: integer('suggestion_count').notNull().default(0),
  securityCount: integer('security_count').notNull().default(0),
  styleCount: integer('style_count').notNull().default(0),
  performanceCount: integer('performance_count').notNull().default(0),
  questionCount: integer('question_count').notNull().default(0),
  postedToGithubAt: text('posted_to_github_at'),
  githubReviewId: text('github_review_id'),
  /** 0-10 — quanto o reviewer aprova/recomenda esse PR. */
  rating: real('rating'),
  /** "small" | "medium" | "large" — effort estimado pra revisar. */
  effort: text('effort'),
  /** "approve" | "request_changes" | "comment". */
  recommendation: text('recommendation'),
  /** Texto curto sobre cobertura de testes / qualidade. */
  testsAssessment: text('tests_assessment'),
  /** JSON: [{ filePath, summary, changeKind }]. */
  walkthroughJson: text('walkthrough_json'),
  /** JSON: [{ filePath, additions, deletions, status }]. */
  filesChangedJson: text('files_changed_json'),
  /** JSON: string[] — pontos positivos. */
  highlightsJson: text('highlights_json'),
  /** JSON: string[] — preocupações / pontos a reforçar. */
  concernsJson: text('concerns_json'),
  /** JSON: [{ repoFullName, prNumber, prTitle, role }] — PRs linkados pra
   * análise conjunta (back+front, etc). */
  linkedPrsJson: text('linked_prs_json'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  createdAt: text('created_at').notNull(),
});

export const codeReviewComments = sqliteTable('code_review_comments', {
  id: text('id').primaryKey(),
  reviewId: text('review_id')
    .notNull()
    .references(() => codeReviews.id, { onDelete: 'cascade' }),
  filePath: text('file_path').notNull(),
  lineStart: integer('line_start'),
  lineEnd: integer('line_end'),
  kind: text('kind', {
    enum: ['bug', 'suggestion', 'security', 'style', 'performance', 'question'],
  })
    .notNull()
    .default('suggestion'),
  severity: text('severity', { enum: ['critical', 'warning', 'info'] })
    .notNull()
    .default('info'),
  message: text('message').notNull(),
  suggestion: text('suggestion'),
  /** Título curto do comentário (1 linha) — pra mostrar em headers de cards. */
  title: text('title'),
  /** Hunk do diff em volta dessa linha — pra UI mostrar contexto. */
  diffHunk: text('diff_hunk'),
  /** Pequeno trecho de código (3-5 linhas) ao redor da linha. */
  codeContext: text('code_context'),
  resolution: text('resolution', { enum: ['pending', 'resolved', 'ignored'] })
    .notNull()
    .default('pending'),
  githubCommentId: text('github_comment_id'),
  createdAt: text('created_at').notNull(),
});

export type CodeReviewRow = typeof codeReviews.$inferSelect;
export type CodeReviewCommentRow = typeof codeReviewComments.$inferSelect;

export const onboardingState = sqliteTable('onboarding_state', {
  id: text('id').primaryKey().default('singleton'),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  step: integer('step').notNull().default(0),
  // Plano selecionado no Step 4 do onboarding novo (free-local | team-cloud).
  plan: text('plan', { enum: ['free-local', 'team-cloud'] }),
  // Mantido por retrocompat — não preenchemos mais nesse fluxo (adapter type
  // agora vive em agents.adapter_type).
  llmProvider: text('llm_provider'),
  objectives: text('objectives', { mode: 'json' }).$type<string[]>().notNull().default([]),
  completedAt: text('completed_at'),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Sessão de chat — uma conversa contínua com um agente dentro de um workspace.
 * Inspirado no padrão do opencode (uma session contém uma timeline de messages).
 */
export const chatSessions = sqliteTable('chat_sessions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  // Título humano da sessão — primeiro prompt do user truncado por padrão.
  title: text('title').notNull().default('Nova conversa'),
  // Último model/effort usados na sessão (pode mudar entre turnos).
  lastModel: text('last_model'),
  // Snapshot do diretório do projeto associado ao turno mais recente.
  lastDirectory: text('last_directory'),
  // Conversa arquivada (1) — fica fora da lista de Recentes.
  isArchived: integer('is_archived').notNull().default(0),
  // Reuso de sessão do CLI (claude --resume): id da sessão CLI do último turno
  // bem-sucedido + fingerprint do contexto estático do 1º turno (mudou → sessão
  // nova) + última mensagem que o CLI viu (delta de histórico nos resumes).
  cliSessionId: text('cli_session_id'),
  cliSessionFingerprint: text('cli_session_fingerprint'),
  cliLastMessageId: text('cli_last_message_id'),
  // Canal de origem da sessão (telegram/whatsapp/…) quando veio de um canal de
  // mensageria. Persiste na sessão pra o ícone do canal sobreviver mesmo quando o
  // link (1 por contato) é re-apontado pra uma conversa nova (/new).
  channelType: text('channel_type', {
    enum: ['whatsapp', 'telegram', 'discord', 'msteams', 'signal'],
  }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Mensagem individual dentro de uma session.
 * Parts é um array JSON estilo opencode/anthropic:
 *   [{ type: 'text', text: '...' }, { type: 'tool-call', toolName, args, output }, ...]
 * Status:
 *   - streaming: assistant message sendo construída (tokens chegando)
 *   - done: finalizada
 *   - error: falhou (erro fica em parts[0].text)
 */
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'tool', 'system'] }).notNull(),
  parts: text('parts', { mode: 'json' })
    .$type<Array<Record<string, unknown>>>()
    .notNull()
    .default([]),
  status: text('status', { enum: ['streaming', 'done', 'error', 'cancelled'] })
    .notNull()
    .default('done'),
  // Vincula à run que produziu essa mensagem (somente assistant/tool)
  runId: text('run_id'),
  createdAt: text('created_at').notNull(),
});

/**
 * Fila de mensagens persistida no MAIN. Quando o usuário envia outra mensagem
 * enquanto um run está ativo na sessão, ela é enfileirada aqui (em vez de só na
 * memória do renderer) — sobrevive a reload/navegação. Ao terminar o run, o
 * chat-service despacha automaticamente a próxima `pending` desta sessão.
 *
 * status: 'pending' (aguardando) | 'sent' (já despachada — mantida por histórico).
 * kind:   'queue' (FIFO normal) | 'steer' (prioridade — despachada antes das normais).
 */
export const chatQueue = sqliteTable('chat_queue', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => chatSessions.id, { onDelete: 'cascade' }),
  content: text('content').notNull().default(''),
  // Anexos serializados (ChatAttachment[]) — base64 incluso.
  attachments: text('attachments', { mode: 'json' }).$type<Array<Record<string, unknown>>>(),
  // Escopo de sources do turno enfileirado ('all' | string[] de sourceIds),
  // serializado em JSON. Null/ausente = 'all' (despacha em todos os sources).
  scope: text('scope', { mode: 'json' }).$type<'all' | string[]>(),
  kind: text('kind', { enum: ['queue', 'steer'] })
    .notNull()
    .default('queue'),
  status: text('status', { enum: ['pending', 'sent'] })
    .notNull()
    .default('pending'),
  // Origem da mensagem ('renderer' | 'channel' | 'cli') — preserva o comportamento
  // da origem (evento user-message do canal, prompting interativo da CLI) quando a
  // msg passou pela fila.
  origin: text('origin', { enum: ['renderer', 'channel', 'cli'] }),
  createdAt: text('created_at').notNull(),
});

/**
 * Conta de um canal de mensageria (WhatsApp, e futuramente Telegram/Discord).
 * Uma linha por conta conectada. As credenciais do Baileys NÃO ficam aqui — vivem
 * em arquivos no userData (`authDir`, multi-file auth state, igual ao padrão nativo
 * do Baileys). Aqui guardamos só o vínculo de roteamento (workspace + agente que
 * responde) e o status de conexão observável pela UI.
 */
export const channelAccounts = sqliteTable('channel_accounts', {
  id: text('id').primaryKey(),
  channelType: text('channel_type', {
    enum: ['whatsapp', 'telegram', 'discord', 'msteams', 'signal'],
  }).notNull(),
  // Workspace + agente que atendem as mensagens recebidas por esta conta.
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  // Status de conexão observável: 'disconnected' | 'connecting' | 'qr' | 'connected'.
  status: text('status', {
    enum: ['disconnected', 'connecting', 'qr', 'connected'],
  })
    .notNull()
    .default('disconnected'),
  // Número/identidade verificada na última conexão (ex.: '5511999...@s.whatsapp.net').
  selfId: text('self_id'),
  // Allowlist (guard): só números nesta lista são respondidos. Array de dígitos
  // normalizados (sem +, espaços ou máscara), serializado em JSON. Vazio = ninguém
  // é respondido (precisa liberar ao menos um número).
  allowlist: text('allowlist', { mode: 'json' }).$type<string[]>().notNull().default([]),
  lastConnectedAt: text('last_connected_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Vínculo entre um interlocutor de um canal (ex.: um número de WhatsApp) e a
 * sessão de chat do Orkestral que mantém aquela conversa. Uma DM = uma sessão
 * persistente, então o histórico continua entre mensagens.
 */
export const channelSessions = sqliteTable('channel_sessions', {
  id: text('id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => channelAccounts.id, { onDelete: 'cascade' }),
  // ID do interlocutor no canal (ex.: JID do WhatsApp — pode ser '@lid').
  channelUserId: text('channel_user_id').notNull(),
  // Nome de exibição (pushName do WhatsApp), pra rotular a conversa.
  displayName: text('display_name'),
  // Número de telefone real (resolvido do @lid) — pra mostrar de quem veio.
  phone: text('phone'),
  // URL da foto de perfil do WhatsApp (quando disponível/pública).
  photoUrl: text('photo_url'),
  chatSessionId: text('chat_session_id')
    .notNull()
    .references(() => chatSessions.id, { onDelete: 'cascade' }),
  lastMessageAt: text('last_message_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const sessionContextSnapshots = sqliteTable('session_context_snapshots', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => chatSessions.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull(),
  messageCount: integer('message_count').notNull().default(0),
  charCount: integer('char_count').notNull().default(0),
  tokenEstimate: integer('token_estimate').notNull().default(0),
  lastMessageId: text('last_message_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Execução de um agente pra responder uma mensagem.
 * Tracking de processo + tempo + custo (pra mostrar em UI futura).
 */
export const agentRuns = sqliteTable('agent_runs', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => chatSessions.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  adapterType: text('adapter_type').notNull(),
  model: text('model'),
  status: text('status', { enum: ['running', 'done', 'error', 'cancelled'] })
    .notNull()
    .default('running'),
  exitCode: integer('exit_code'),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  // Custo do turno: usage/total_cost_usd do evento `result` do claude stream-json.
  // NULL em adapters sem stream-json (forge/codex/rede) e em runs cancelados.
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  costUsd: real('cost_usd'),
});

/**
 * Conta GitHub conectada via Device Flow.
 * Token vem criptografado via host.secrets (safeStorage ou fallback crypto).
 * Multi-conta por instalação — id/login identificam qual token usar.
 */
export const githubAccounts = sqliteTable('github_accounts', {
  id: text('id').primaryKey(),
  login: text('login').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  tokenEncrypted: blob('token_encrypted', { mode: 'buffer' }).notNull(),
  scope: text('scope').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const sentryAccounts = sqliteTable('sentry_accounts', {
  id: text('id').primaryKey(),
  /** Workspace dono da conexão. Null só existe em bancos antigos antes do v50. */
  workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Slug da organização Sentry (ex.: "minha-org"). Único por conta. */
  orgSlug: text('org_slug').notNull(),
  /** Projeto opcional pra filtrar issues (slug). Vazio = todos os projetos da org. */
  projectSlug: text('project_slug'),
  displayName: text('display_name'),
  /** Auth token cifrado (host.secrets). Decifrar antes de usar. */
  tokenEncrypted: blob('token_encrypted', { mode: 'buffer' }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export type SentryAccountRow = typeof sentryAccounts.$inferSelect;

/**
 * Automação do Sentry por workspace: vigia issues novas e, conforme as
 * condições (severidade mínima + projeto), propõe um fix no Inbox (ou dispara a
 * análise direto) com o agente escolhido. `seenIssueIds` guarda os ids já vistos
 * (JSON) pra só agir em issues NOVAS — semeado ao ligar pra não inundar.
 */
export const sentryAutomations = sqliteTable('sentry_automations', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  /** Severidade mínima que dispara: fatal | error | warning | info. */
  minLevel: text('min_level').notNull().default('error'),
  /** Slug do projeto pra filtrar. Vazio/null = todos os projetos. */
  projectSlug: text('project_slug'),
  /** Agente que analisa (null = CEO/orquestrador). */
  agentId: text('agent_id'),
  /** 'propose' = cria proposta no Inbox; 'auto' = abre a análise na hora. */
  mode: text('mode').notNull().default('propose'),
  /** Intervalo (min) de auto-refresh pra observabilidade. 0 = desligado. */
  refreshIntervalMin: integer('refresh_interval_min').notNull().default(5),
  /** Ids de issues já processadas (JSON array), capado às mais recentes. */
  seenIssueIds: text('seen_issue_ids').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export type SentryAutomationRow = typeof sentryAutomations.$inferSelect;

/**
 * Regras de automação do Sentry (VÁRIAS por workspace). Cada regra vigia issues
 * novas que batem nas condições (severidade mínima + projeto) e age: propõe um
 * fix no Inbox ou abre a análise na hora, com o agente escolhido. `seenIssueIds`
 * guarda os ids já processados (JSON) pra só agir em issues NOVAS.
 */
export const sentryRules = sqliteTable('sentry_rules', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  minLevel: text('min_level').notNull().default('error'),
  projectSlug: text('project_slug'),
  agentId: text('agent_id'),
  mode: text('mode').notNull().default('propose'),
  seenIssueIds: text('seen_issue_ids').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export type SentryRuleRow = typeof sentryRules.$inferSelect;

/** Histórico de execuções das regras: o que o watcher fez pra cada issue. */
export const sentryRuleRuns = sqliteTable('sentry_rule_runs', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id')
    .notNull()
    .references(() => sentryRules.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull(),
  issueId: text('issue_id').notNull(),
  shortId: text('short_id'),
  title: text('title'),
  level: text('level'),
  project: text('project'),
  /** 'proposed' (Inbox) | 'analyzed' (sessão aberta). */
  action: text('action').notNull(),
  /** 'ok' | 'error'. */
  status: text('status').notNull(),
  /** sessionId (analyzed) ou mensagem de erro. */
  detail: text('detail'),
  createdAt: text('created_at').notNull(),
});
export type SentryRuleRunRow = typeof sentryRuleRuns.$inferSelect;

export const observabilityAccounts = sqliteTable('observability_accounts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  displayName: text('display_name'),
  configJson: text('config_json').notNull().default('{}'),
  tokenEncrypted: blob('token_encrypted', { mode: 'buffer' }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export type ObservabilityAccountRow = typeof observabilityAccounts.$inferSelect;

export const observabilityRules = sqliteTable('observability_rules', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  kind: text('kind').notNull().default('all'),
  severity: text('severity'),
  serviceQuery: text('service_query'),
  agentId: text('agent_id'),
  mode: text('mode').notNull().default('propose'),
  refreshIntervalMin: integer('refresh_interval_min').notNull().default(5),
  seenSignalIds: text('seen_signal_ids').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export type ObservabilityRuleRow = typeof observabilityRules.$inferSelect;

export const observabilityRuleRuns = sqliteTable('observability_rule_runs', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id')
    .notNull()
    .references(() => observabilityRules.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull(),
  provider: text('provider').notNull(),
  signalId: text('signal_id').notNull(),
  title: text('title'),
  kind: text('kind'),
  service: text('service'),
  severity: text('severity'),
  action: text('action').notNull(),
  status: text('status').notNull(),
  detail: text('detail'),
  createdAt: text('created_at').notNull(),
});
export type ObservabilityRuleRunRow = typeof observabilityRuleRuns.$inferSelect;

export const azureDevopsAccounts = sqliteTable('azure_devops_accounts', {
  id: text('id').primaryKey().default('singleton'),
  displayName: text('display_name'),
  email: text('email'),
  tenantId: text('tenant_id'),
  accessTokenEncrypted: blob('access_token_encrypted', { mode: 'buffer' }).notNull(),
  refreshTokenEncrypted: blob('refresh_token_encrypted', { mode: 'buffer' }),
  scope: text('scope').notNull().default(''),
  expiresAt: text('expires_at').notNull(),
  organizations: text('organizations', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Knowledge Base — páginas hierárquicas (tree), wikilinks, entidades extraídas,
 * relations e chunks binários compactados (BKF) pra consumo do agente.
 */
export const kbPages = sqliteTable('kb_pages', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  kind: text('kind', { enum: ['doc', 'index', 'auto-generated', 'agent-memory'] })
    .notNull()
    .default('doc'),
  contentJson: text('content_json'),
  contentMd: text('content_md'),
  icon: text('icon'),
  sortOrder: integer('sort_order').notNull().default(0),
  isPinned: integer('is_pinned').notNull().default(0),
  isArchived: integer('is_archived').notNull().default(0),
  sourceId: text('source_id'),
  createdByAgentId: text('created_by_agent_id'),
  retrievalCount: integer('retrieval_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const kbLinks = sqliteTable('kb_links', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  sourcePageId: text('source_page_id')
    .notNull()
    .references(() => kbPages.id, { onDelete: 'cascade' }),
  targetKind: text('target_kind', { enum: ['page', 'entity', 'external'] }).notNull(),
  targetId: text('target_id'),
  targetLabel: text('target_label'),
  targetUrl: text('target_url'),
  strength: real('strength').notNull().default(1),
  createdAt: text('created_at').notNull(),
});

export const kbEntities = sqliteTable('kb_entities', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  mentionCount: integer('mention_count').notNull().default(0),
  lastMentionedAt: text('last_mentioned_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const kbRelations = sqliteTable('kb_relations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceEntityId: text('source_entity_id')
    .notNull()
    .references(() => kbEntities.id, { onDelete: 'cascade' }),
  targetEntityId: text('target_entity_id')
    .notNull()
    .references(() => kbEntities.id, { onDelete: 'cascade' }),
  relationType: text('relation_type').notNull(),
  weight: real('weight').notNull().default(1),
  createdAt: text('created_at').notNull(),
});

export const kbChunks = sqliteTable('kb_chunks', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  pageId: text('page_id')
    .notNull()
    .references(() => kbPages.id, { onDelete: 'cascade' }),
  parentChunkId: text('parent_chunk_id'),
  depth: integer('depth').notNull().default(0),
  payload: blob('payload', { mode: 'buffer' }).notNull(),
  sizeUncompressed: integer('size_uncompressed').notNull(),
  sizeCompressed: integer('size_compressed').notNull(),
  checksum: text('checksum').notNull(),
  snapshotVersion: integer('snapshot_version').notNull().default(1),
  createdAt: text('created_at').notNull(),
});

export const kbTokenIndex = sqliteTable('kb_token_index', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  pageId: text('page_id')
    .notNull()
    .references(() => kbPages.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  tf: integer('tf').notNull().default(1),
  field: text('field').notNull().default('body'),
  contentHash: text('content_hash'),
});

// Chunk de CÓDIGO-FONTE real indexado (≠ kb_pages, que é prosa escrita pela IA).
// Provenance file:line permite que o kb_search devolva trechos reais com origem.
export const kbCodeChunks = sqliteTable('kb_code_chunks', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull(),
  filePath: text('file_path').notNull(),
  lang: text('lang'),
  symbol: text('symbol'),
  startLine: integer('start_line').notNull(),
  endLine: integer('end_line').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Espelho BM25 dos chunks de código (mesma mecânica do kb_token_index das páginas).
export const kbCodeTokenIndex = sqliteTable('kb_code_token_index', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  chunkId: text('chunk_id')
    .notNull()
    .references(() => kbCodeChunks.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  tf: integer('tf').notNull().default(1),
  field: text('field').notNull().default('body'),
});

export const embeddingModels = sqliteTable('embedding_models', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull().default('local-gguf'),
  family: text('family').notNull().default('orkestral-embedding'),
  modelPath: text('model_path').notNull(),
  modelHash: text('model_hash').notNull(),
  dimension: integer('dimension').notNull(),
  contextTokens: integer('context_tokens').notNull().default(512),
  isRequired: integer('is_required').notNull().default(1),
  isActive: integer('is_active').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const kbEmbeddingItems = sqliteTable('kb_embedding_items', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  pageId: text('page_id').references(() => kbPages.id, { onDelete: 'cascade' }),
  chunkId: text('chunk_id').references(() => kbChunks.id, { onDelete: 'cascade' }),
  itemKind: text('item_kind', { enum: ['page', 'chunk'] })
    .notNull()
    .default('page'),
  sourceHash: text('source_hash').notNull(),
  title: text('title').notNull(),
  textPreview: text('text_preview'),
  tokenCount: integer('token_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const kbEmbeddings = sqliteTable('kb_embeddings', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  itemId: text('item_id')
    .notNull()
    .references(() => kbEmbeddingItems.id, { onDelete: 'cascade' }),
  modelId: text('model_id')
    .notNull()
    .references(() => embeddingModels.id, { onDelete: 'cascade' }),
  dimension: integer('dimension').notNull(),
  vector: blob('vector', { mode: 'buffer' }).notNull(),
  norm: real('norm').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const knowledgeUsageStats = sqliteTable('knowledge_usage_stats', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  targetKind: text('target_kind', {
    enum: ['page', 'chunk', 'embedding_item', 'source'],
  }).notNull(),
  targetId: text('target_id').notNull(),
  sourceId: text('source_id'),
  useCount: integer('use_count').notNull().default(0),
  hitCount: integer('hit_count').notNull().default(0),
  firstUsedAt: text('first_used_at'),
  lastUsedAt: text('last_used_at'),
  updatedAt: text('updated_at').notNull(),
});

export const cleanupSuggestions = sqliteTable('cleanup_suggestions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  kind: text('kind', {
    enum: ['kb_stale', 'kb_duplicate', 'kb_orphan', 'embedding_stale'],
  }).notNull(),
  status: text('status', {
    enum: ['open', 'dismissed', 'approved', 'applied'],
  })
    .notNull()
    .default('open'),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  reason: text('reason').notNull(),
  payloadJson: text('payload_json'),
  estimatedBytes: integer('estimated_bytes').notNull().default(0),
  itemCount: integer('item_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  decidedAt: text('decided_at'),
  appliedAt: text('applied_at'),
});

export const kbEmbeddingJobs = sqliteTable('kb_embedding_jobs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  reason: text('reason', {
    enum: ['page-write', 'workspace-rebuild', 'manual'],
  }).notNull(),
  status: text('status', {
    enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
  })
    .notNull()
    .default('queued'),
  sourceId: text('source_id'),
  sourceLabel: text('source_label'),
  pageIdsJson: text('page_ids_json', { mode: 'json' }).$type<string[]>().notNull().default([]),
  current: integer('current').notNull().default(0),
  total: integer('total').notNull().default(0),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  updatedAt: text('updated_at').notNull(),
});

export const kbAnalysisJobs = sqliteTable('kb_analysis_jobs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceId: text('source_id'),
  sourceLabel: text('source_label').notNull(),
  status: text('status', {
    enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
  })
    .notNull()
    .default('queued'),
  phase: text('phase'),
  message: text('message'),
  filesScanned: integer('files_scanned').notNull().default(0),
  pagesCreated: integer('pages_created').notNull().default(0),
  entitiesCreated: integer('entities_created').notNull().default(0),
  relationsCreated: integer('relations_created').notNull().default(0),
  coveragePages: integer('coverage_pages').notNull().default(0),
  embeddingJobId: text('embedding_job_id'),
  error: text('error'),
  // Custo do run LLM da análise (usage/total_cost_usd do `result` do claude
  // stream-json). NULL em runs via codex (sem custo no stream) e jobs antigos.
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  costUsd: real('cost_usd'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  updatedAt: text('updated_at').notNull(),
});

export const aiTrainingExamples = sqliteTable('ai_training_examples', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceKind: text('source_kind', {
    enum: ['issue_run', 'chat', 'rag_feedback', 'manual'],
  }).notNull(),
  sourceId: text('source_id'),
  taskType: text('task_type', {
    enum: ['code', 'reasoning', 'retrieval', 'planning', 'review'],
  })
    .notNull()
    .default('reasoning'),
  inputText: text('input_text').notNull(),
  expectedOutput: text('expected_output'),
  actualOutput: text('actual_output'),
  label: text('label', {
    enum: ['positive', 'negative', 'correction', 'neutral'],
  })
    .notNull()
    .default('neutral'),
  metadataJson: text('metadata_json'),
  status: text('status', {
    enum: ['candidate', 'approved', 'exported', 'ignored'],
  })
    .notNull()
    .default('candidate'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const ragEvaluationRuns = sqliteTable('rag_evaluation_runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  query: text('query').notNull(),
  expectedPageIdsJson: text('expected_page_ids_json', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  resultPageIdsJson: text('result_page_ids_json', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  metricsJson: text('metrics_json', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  status: text('status', { enum: ['passed', 'failed', 'needs_review'] })
    .notNull()
    .default('needs_review'),
  createdAt: text('created_at').notNull(),
});

export const multiAgentRuns = sqliteTable('multi_agent_runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  issueId: text('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
  runId: text('run_id'),
  status: text('status', {
    enum: ['planned', 'running', 'completed', 'failed', 'cancelled'],
  })
    .notNull()
    .default('planned'),
  planJson: text('plan_json', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const multiAgentSteps = sqliteTable('multi_agent_steps', {
  id: text('id').primaryKey(),
  multiAgentRunId: text('multi_agent_run_id')
    .notNull()
    .references(() => multiAgentRuns.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  role: text('role', {
    enum: ['researcher', 'memory', 'executor', 'reviewer', 'safety'],
  }).notNull(),
  status: text('status', {
    enum: ['pending', 'running', 'completed', 'failed', 'skipped'],
  })
    .notNull()
    .default('pending'),
  inputText: text('input_text'),
  outputText: text('output_text'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type KbPageRow = typeof kbPages.$inferSelect;
export type KbLinkRow = typeof kbLinks.$inferSelect;
export type KbEntityRow = typeof kbEntities.$inferSelect;
export type KbRelationRow = typeof kbRelations.$inferSelect;
export type KbChunkRow = typeof kbChunks.$inferSelect;
export type KbTokenRow = typeof kbTokenIndex.$inferSelect;
export type KbCodeChunkRow = typeof kbCodeChunks.$inferSelect;
export type KbCodeTokenRow = typeof kbCodeTokenIndex.$inferSelect;
export type EmbeddingModelRow = typeof embeddingModels.$inferSelect;
export type KbEmbeddingItemRow = typeof kbEmbeddingItems.$inferSelect;
export type KbEmbeddingRow = typeof kbEmbeddings.$inferSelect;
export type KnowledgeUsageStatsRow = typeof knowledgeUsageStats.$inferSelect;
export type CleanupSuggestionRow = typeof cleanupSuggestions.$inferSelect;
export type KbEmbeddingJobRow = typeof kbEmbeddingJobs.$inferSelect;
export type KbAnalysisJobRow = typeof kbAnalysisJobs.$inferSelect;
export type AiTrainingExampleRow = typeof aiTrainingExamples.$inferSelect;
export type RagEvaluationRunRow = typeof ragEvaluationRuns.$inferSelect;
export type MultiAgentRunRow = typeof multiAgentRuns.$inferSelect;
export type MultiAgentStepRow = typeof multiAgentSteps.$inferSelect;

export type GithubAccountRow = typeof githubAccounts.$inferSelect;
export type AzureDevopsAccountRow = typeof azureDevopsAccounts.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
export type OnboardingStateRow = typeof onboardingState.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;

/**
 * Histórico da camada de execução inteligente (economia de tokens).
 * Sem FK rígida — registra execuções mesmo após a issue ser removida.
 */
export const taskExecutions = sqliteTable('task_executions', {
  id: text('id').primaryKey(),
  issueId: text('issue_id'),
  runId: text('run_id'),
  workspaceId: text('workspace_id'),
  executionMode: text('execution_mode').notNull(),
  modelUsed: text('model_used').notNull().default('none'),
  risk: text('risk').notNull().default('low'),
  filesChanged: text('files_changed', { mode: 'json' }).notNull().default('[]'),
  diffSummary: text('diff_summary').notNull().default(''),
  validationResult: text('validation_result').notNull().default('skipped'),
  fallbackUsed: integer('fallback_used').notNull().default(0),
  failureReason: text('failure_reason'),
  attempts: integer('attempts').notNull().default(0),
  durationMs: integer('duration_ms'),
  metrics: text('metrics', { mode: 'json' }).notNull().default('{}'),
  plan: text('plan', { mode: 'json' }),
  createdAt: text('created_at').notNull(),
});

/**
 * Dependências entre issues (Paperclip): "blocker bloqueia blocked".
 * Índices criados na migration. Sem helpers de index aqui pra não mexer imports.
 */
export const issueDependencies = sqliteTable('issue_dependencies', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  blockerIssueId: text('blocker_issue_id').notNull(),
  blockedIssueId: text('blocked_issue_id').notNull(),
  createdAt: text('created_at').notNull(),
});

/** Reviewers e approvers de uma issue (role discrimina; decision rastreia aprovação). */
export const issueReviewers = sqliteTable('issue_reviewers', {
  id: text('id').primaryKey(),
  issueId: text('issue_id').notNull(),
  agentId: text('agent_id').notNull(),
  role: text('role').notNull().default('reviewer'),
  decision: text('decision'),
  decidedAt: text('decided_at'),
  createdAt: text('created_at').notNull(),
});

/**
 * Trace de execução PERSISTIDO (página Logs). Antes era só ring buffer em
 * memória → sumia no restart. Agora grava aqui e é expurgado pra manter no
 * máximo 500 linhas (ver TraceLogRepository.prune).
 */
export const traceLogs = sqliteTable('trace_logs', {
  id: text('id').primaryKey(),
  ts: integer('ts').notNull(),
  level: text('level').notNull(),
  source: text('source').notNull(),
  message: text('message').notNull(),
  scope: text('scope'),
  workspaceId: text('workspace_id'),
  agentId: text('agent_id'),
  agentName: text('agent_name'),
  issueKey: text('issue_key'),
  durationMs: integer('duration_ms'),
});

/**
 * Timeline estruturada local do agente. Alimenta a UX tipo "LangSmith local":
 * passos, status, payloads de retrieval/ferramentas/validacao e vinculo com
 * issue/run. Nao e expurgada junto com trace_logs.
 */
export const agentTraceEvents = sqliteTable('agent_trace_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  runId: text('run_id'),
  issueId: text('issue_id'),
  issueKey: text('issue_key'),
  agentId: text('agent_id'),
  agentName: text('agent_name'),
  parentId: text('parent_id'),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  title: text('title').notNull(),
  summary: text('summary'),
  payloadJson: text('payload_json'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  durationMs: integer('duration_ms'),
});
