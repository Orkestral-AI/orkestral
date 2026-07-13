import type {
  AgentActivityItem,
  AgentActivityStats,
  ChatAttachment,
  ChatQueueItem,
  KbPage,
  VoicePackStatus,
  KbPageNode,
  KbPageKind,
  KbBacklink,
  KbSearchHit,
  KbSearchFilters,
  KbGraph,
  KbAnalysisJobSummary,
  KbEmbeddingJobSummary,
  KbSourceCoverageSummary,
  KnowledgeCleanupSuggestion,
  AiTrainingExample,
  FineTuningReadiness,
  RagBenchmarkSummary,
  RagEvaluationRun,
  TrainingDatasetExport,
  TrainingPackExport,
  Workspace,
  EngineV2RunSummary,
  ChannelType,
  ChannelAccountSnapshot,
  ChannelSessionMeta,
  SourceAgentAssignment,
  Project,
  UserProfile,
  SettingsRecord,
  OnboardingState,
  OnboardingSubmission,
  AdapterDescriptor,
  AdapterModel,
  AdapterTestResult,
  AdapterType,
  Agent,
  ChatSession,
  ChatMessage,
  GithubAccount,
  AzureDevopsAccount,
  AzureDevopsDeviceCode,
  AzureDevopsDeviceFlowStatus,
  AzureDevopsRepoSummary,
  GithubDeviceCode,
  GithubDeviceFlowStatus,
  GithubRepoSummary,
  GithubPullRequest,
  AgentInstructionFile,
  HeartbeatRun,
  AgentApiKey,
  Skill,
  SkillKind,
  DetectedCliMcp,
  ModelRoutingDecision,
  ModelRoutingPhase,
  SmartExecConfig,
  TaskRisk,
  TaskExecutionRecord,
  SmartExecMetricsSummary,
  WorkspaceDiagnostics,
  TraceEntry,
  AgentTraceEvent,
  Issue,
  IssueComment,
  IssueAttachment,
  IssueRun,
  IssueExecutionEvent,
  QaValidation,
  IssueStatus,
  IssuePriority,
  IssueRelations,
  IssueReviewer,
  IssueReviewerRole,
  IssueReviewerDecision,
  ActivityEntry,
  Routine,
  Goal,
  CodeReview,
  CodeReviewComment,
  CodeReviewLinkedPr,
  WorkspaceSource,
  WorkspaceSourceKind,
  WorkspaceSourceRole,
  MarketplaceCatalogItem,
} from './types';

/**
 * Contrato IPC do Orkestral — single source of truth da comunicação main ↔ renderer.
 *
 * Padrão:
 *  - canal nomeado `<dominio>:<acao>` (kebab/colon).
 *  - request e response tipados.
 *  - todo handler do main implementa um `IpcHandler<TRequest, TResponse>`.
 *  - todo método do `window.orkestral.*` no renderer chama `ipcRenderer.invoke(channel, payload)`.
 */

// -----------------------------------------------------------------------------
// Map de canal → (request, response)
// -----------------------------------------------------------------------------

/**
 * Economia de execução (ver exec-stats.repo.ts). Todas as contagens são
 * medidas direto da tabela issue_runs — nada aqui é sintetizado.
 */
export interface ExecEconomics {
  /** Execuções resolvidas 100% pelo Forge local, sem premium. */
  localExecutions: number;
  /** Resolvidas local mas com assist do premium por arquivo. */
  localAssisted: number;
  /** Runs que escalaram pro modelo premium completo (fallback). */
  escalations: number;
  /** (local + assisted) + escalations (total orquestrado). */
  orchestratedTotal: number;
  /**
   * Taxa de RESOLUÇÃO local (não escalou pro premium) = (local + assisted) /
   * orchestratedTotal, ou null se não há run orquestrado. NÃO é uma afirmação de
   * correção: ver `localCorrectnessRate` para a taxa de fato VERIFICADA.
   */
  localSuccessRate: number | null;
  /** Runs locais que atingiram done VERIFICADO (passaram no gate de aprovação). */
  localVerified: number;
  /** Runs locais que produziram trabalho mas foram reprovados no gate de verificação. */
  localRejected: number;
  /** Runs locais sem veredito ainda (verified IS NULL) — excluídos da taxa de correção. */
  localPendingVerification: number;
  /**
   * Taxa de CORREÇÃO honesta: localVerified / (localVerified + localRejected),
   * computada SÓ sobre runs com veredito; null quando nenhum run tem veredito.
   */
  localCorrectnessRate: number | null;
  /** Custo premium REAL (USD) medido nas escalações (cost_usd do stream-json). */
  premiumSpentUsd: number;
  /** Custo médio REAL por escalação premium, ou null se nenhuma teve custo medido. */
  avgPremiumCostUsd: number | null;
  /** Economia REAL estimada (resoluções locais × custo médio premium medido), ou null. */
  savedUsd: number | null;
  /**
   * Fases analíticas (sumarização/classificação) resolvidas no modelo local em
   * vez de premium. Diferente de `localExecutions` (que são issues/code-edits):
   * estas são fases de ingestão/KB/roteamento que antes só geravam ledger
   * sintético e agora rodam local de verdade.
   */
  localPhaseRuns: number;
  /** Tokens premium (entrada+saída) evitados por essas fases locais — estimativa (chars/4). */
  localPhaseTokensAvoided: number;
  /**
   * Tokens de ENTRADA que o premium TERIA processado pelo trabalho que o Forge fez
   * local (code-edits + fases). Base do counterfactual — premium não rodou.
   */
  counterfactualInputTokens: number;
  /** Tokens de SAÍDA que o premium TERIA gerado pelo mesmo trabalho local. */
  counterfactualOutputTokens: number;
  /**
   * Economia ESTIMADA (USD) = tokens evitados × preço de REFERÊNCIA (não cobrado).
   * Diferente de `savedUsd` (derivado de custo premium REAL medido): este é sempre
   * computável (mesmo sem nenhuma escalação), tornando a economia visível por padrão.
   */
  counterfactualSavedUsd: number;
  /** Rótulo do preço de referência usado (ex.: "Claude Sonnet (ref.)"). */
  referencePriceLabel: string;
}

/** Resultado do boot-check de atualização (GitHub Releases). */
export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  notes: string | null;
  /** URL de download do .dmg da arch atual (ou da página da release como fallback). */
  url: string | null;
  /** Página HTML da release (pra "ver notas"). */
  htmlUrl: string | null;
  publishedAt: string | null;
}

export type IpcContract = {
  // ---- App / sistema ----
  'app:get-version': {
    request: void;
    response: { version: string; electron: string; node: string };
  };
  /** RAM total da máquina (MB) — onboarding usa pra recomendar o preset de memória. */
  'system:hardware': {
    request: void;
    response: { totalMemMb: number };
  };
  /** Consumo de memória AO VIVO (app + modelos locais) — monitor em tempo real nos Logs. */
  'system:memory-stats': {
    request: void;
    response: {
      /** RSS do processo (inclui as alocações nativas do llama.cpp) em MB. */
      rssMb: number;
      heapUsedMb: number;
      totalMemMb: number;
      freeMemMb: number;
      /** Modelos locais residentes na RAM agora (on/off por modelo). */
      models: { kind: 'forge' | 'fast-apply' | 'embeddings'; loaded: boolean }[];
    };
  };
  /** Boot-check: checa o GitHub Releases por uma versão mais nova. */
  'update:check': {
    request: void;
    response: UpdateInfo;
  };
  /** Abre a URL de download da atualização no navegador (download manual). */
  'update:open': {
    request: { url: string };
    response: { ok: boolean };
  };
  /** Baixa o instalador DENTRO do app (progresso via evento `update:download-progress`)
   *  e abre o instalador no fim — sem mandar pro navegador. */
  'update:download': {
    request: { url: string };
    response: { ok: boolean };
  };
  /** Reinicia o app aplicando a atualização já baixada (auto-update Win/Linux). */
  'update:quit-and-install': {
    request: void;
    response: { ok: true };
  };
  /** Abre os ajustes de data/hora do SO (deep-link nativo). */
  'system:open-datetime-settings': {
    request: void;
    response: { ok: true };
  };
  /** Embeddings presente e íntegro? + se há download em andamento. */
  'models:embeddings-status': {
    request: void;
    response: { present: boolean; downloading: boolean };
  };
  /** Baixa os embeddings sob demanda (~640MB). Progresso via models:download-progress. */
  'models:download-embeddings': {
    request: void;
    response: { started: boolean };
  };
  /** Status do modelo FAST-APPLY (o "morph" próprio, ~986MB). */
  'models:fast-apply-status': {
    request: void;
    response: { present: boolean; downloading: boolean };
  };
  /** Baixa o fast-apply sob demanda. Progresso via models:download-progress. */
  'models:download-fast-apply': {
    request: void;
    response: { started: boolean };
  };
  /** Encerra o aplicativo. */
  'app:quit': {
    request: void;
    response: { ok: true };
  };
  /** Controles de janela custom (traffic lights nativos escondidos no macOS). */
  'window:minimize': {
    request: void;
    response: { ok: true };
  };
  'window:toggle-maximize': {
    request: void;
    response: { maximized: boolean };
  };
  'window:close': {
    request: void;
    response: { ok: true };
  };
  /** Docka o DevTools do <webview> do Preview DENTRO de outro <webview> (estilo Chrome).
   *  open=true: liga setDevToolsWebContents(devtoolsId)+openDevTools; open=false: fecha. */
  'webview:set-devtools': {
    request: { targetId: number; devtoolsId?: number; open: boolean };
    response: { ok: true };
  };
  // ---- Desktop pet (docs/DESKTOP_PET.md) — janela flutuante always-on-top ----
  /** Liga/desliga o click-through da janela do pet. O renderer do pet chama em
   *  mouseenter/mouseleave das áreas interativas (sprite/cards); fora delas o
   *  clique atravessa pro app de baixo. */
  'pet:set-ignore-mouse': {
    request: { ignore: boolean };
    response: { ok: true };
  };
  /** Mostra/esconde o pet: persiste `pet.enabled` nas settings e cria/destrói a
   *  janela. Usado pelo toggle das Configurações (o Tray chama o main direto). */
  'pet:set-enabled': {
    request: { enabled: boolean };
    response: { enabled: boolean };
  };
  /** Clique num card/menu do pet: foca a janela principal e navega (push
   *  `app:navigate` com o hash) e/ou abre as Configurações (`app:open-settings`).
   *  hash null = só focar o app. */
  'pet:open-target': {
    request: { hash: string | null; openSettings?: boolean };
    response: { ok: true };
  };
  /** Drag manual do pet (drag nativo por app-region engoliria o clique do menu):
   *  o main gruda a janela no cursor via polling até o drag-end. */
  'pet:drag-start': {
    request: void;
    response: { ok: true };
  };
  'pet:drag-end': {
    request: void;
    response: { ok: true };
  };
  /** Sai da sessão local sem apagar dados do workspace. */
  'app:logout': {
    request: void;
    response: { ok: true };
  };
  /** URL (file://) do preload injetado no <webview> do Preview. */
  'app:webview-preload-path': {
    request: Record<string, never>;
    response: { url: string };
  };
  // ---- Orkestral Cloud (login via web, deep link orkestral://auth) ----
  /** Conta Cloud conectada (ou null se sem login). Tokens nunca saem do main. */
  'cloud:get-account': {
    request: void;
    response: { email: string; name: string | null } | null;
  };
  /** Abre o login do Orkestral Cloud no navegador (fluxo next=desktop).
   *  `url` é null quando o Cloud não está configurado neste build (sem Supabase). */
  'cloud:login-start': {
    request: void;
    response: { url: string | null };
  };
  /** Desconecta a conta Cloud local (não revoga a sessão no web). */
  'cloud:logout': {
    request: void;
    response: { ok: true };
  };
  /** Aplica um zoom factor global em todas as janelas (escala fonte+densidade). */
  'system:set-zoom': {
    request: { factor: number };
    response: { ok: true };
  };
  /** Ajusta a visibilidade do app (Dock no macOS). Tray é follow-up. */
  'system:apply-visibility': {
    request: { showAppIn: 'dock-and-status' | 'dock' | 'status' };
    response: { ok: true };
  };
  /** Traz a janela principal pro foreground (clique em notificação nativa). */
  'system:focus-window': {
    request: void;
    response: { ok: true };
  };

  // ---- Dados (painel de Configurações → Dados) ----
  /** Tamanho do banco + contagem de linhas das principais tabelas. */
  'data:stats': {
    /** `workspaceId` escopa as contagens de conteúdo ao workspace ativo. */
    request: { workspaceId?: string } | void;
    response: {
      dbPath: string;
      dbSizeBytes: number;
      counts: {
        workspaces: number;
        agents: number;
        sessions: number;
        messages: number;
        issues: number;
        kbPages: number;
        kbChunks: number;
        kbTokenIndex: number;
        kbEmbeddingItems: number;
        kbEmbeddings: number;
        cleanupSuggestions: number;
        taskExecutions: number;
        issueRuns: number;
        traceLogs: number;
        agentTraceEvents: number;
        aiTrainingExamples: number;
        ragEvaluationRuns: number;
        multiAgentRuns: number;
        multiAgentSteps: number;
      };
    };
  };
  /** Exporta os dados do app pra um JSON num diretório escolhido pelo usuário. */
  'data:export': {
    request: void;
    response:
      | { ok: true; path: string; counts: Record<string, number> }
      | { ok: false; cancelled: true };
  };
  /** Abre a pasta de dados (~/.orkestral/instances/default) no Finder/Explorer. */
  'data:reveal': {
    request: void;
    response: { ok: true };
  };
  /** Limpa cache HTTP/sessão do webContents (não apaga dados do banco). */
  'data:clear-cache': {
    request: void;
    response: { ok: true };
  };
  /** Lista sugestões de limpeza segura; nada é apagado neste preview. */
  'data:cleanup-preview': {
    request: { workspaceId: string };
    response: {
      suggestions: KnowledgeCleanupSuggestion[];
      totalItems: number;
      totalBytes: number;
    };
  };
  /** Aplica apenas sugestões aprovadas pelo usuário. */
  'data:cleanup-run': {
    request: { workspaceId: string; suggestionIds: string[] };
    response: {
      applied: number;
      deletedRows: number;
      reclaimedBytesEstimate: number;
    };
  };
  /** Apaga sessões + mensagens de chat do workspace (ação destrutiva, com confirm na UI). */
  'data:clear-chat-history': {
    request: { workspaceId: string };
    response: { deletedSessions: number; deletedMessages: number };
  };

  // ---- Workspace ----
  'workspace:list': {
    request: void;
    response: Workspace[];
  };
  'workspace:create': {
    request: { name: string; icon?: string; color?: string; planMode?: 'local' | 'team' };
    response: Workspace;
  };
  'workspace:switch': {
    request: { workspaceId: string };
    response: Workspace;
  };
  /** Atualiza nome/cor/ícone do workspace (ex.: cor principal por workspace). */
  'workspace:update': {
    request: {
      workspaceId: string;
      patch: { name?: string; color?: string | null; icon?: string | null };
    };
    response: Workspace;
  };
  /**
   * Chamado pelo renderer após clonar um repo GitHub durante o onboarding.
   * Atualiza o path local e dispara o hiring plan do CEO em background.
   */
  'workspace:finalize-github': {
    request: { workspaceId: string; clonedPath: string; runInitialHiringPlan?: boolean };
    response: Workspace;
  };
  'workspace:list-archived': {
    request: void;
    response: Workspace[];
  };
  'workspace:archive': {
    request: { workspaceId: string };
    response: Workspace;
  };
  'workspace:unarchive': {
    request: { workspaceId: string };
    response: Workspace;
  };
  'workspace:delete': {
    request: { workspaceId: string };
    response: { ok: true };
  };

  // ---- Canais (WhatsApp e futuros) ----
  // Motor v2: roda uma fatia (premium configurado planeja/conduz, Forge local executa).
  'engine-v2:run-slice': {
    request: { workspaceId: string; intent: string; projectRoot: string; port?: number };
    response: EngineV2RunSummary;
  };
  // Preview do projeto gerado: sobe/para o dev server e devolve a URL pro painel.
  'preview:start': {
    request: { workspaceId: string };
    response: { running: boolean; url: string | null; runnable: boolean; reason?: string };
  };
  'preview:stop': {
    request: { workspaceId: string };
    response: { ok: true };
  };
  'preview:status': {
    request: { workspaceId: string };
    response: { running: boolean; url: string | null; runnable: boolean; reason?: string };
  };
  'channels:list': {
    request: { channelType?: ChannelType } | void;
    response: ChannelAccountSnapshot[];
  };
  'channels:create': {
    request: { channelType: ChannelType; workspaceId: string; agentId: string };
    response: ChannelAccountSnapshot;
  };
  /** Salva a config do canal: agente que responde + allowlist (guard) + credenciais
   *  do bot (token do Discord ou appId/appPassword/tenantId/porta do Teams). */
  'channels:set-config': {
    request: {
      accountId: string;
      agentId: string;
      allowlist: string[];
      token?: string;
      teams?: { appId?: string; appPassword?: string; tenantId?: string; port?: number };
    };
    response: ChannelAccountSnapshot | null;
  };
  /** Salva o bot token do Telegram (BotFather) — pré-requisito pra conectar. */
  'channels:set-telegram-token': {
    request: { accountId: string; token: string };
    response: ChannelAccountSnapshot | null;
  };
  /** Sobe o servidor/conexão pra mostrar o QR ou reconectar (só ao clicar). */
  'channels:connect': {
    request: { accountId: string };
    response: ChannelAccountSnapshot | null;
  };
  /** Derruba a conexão sem revogar a sessão (reconecta sem QR depois). */
  'channels:disconnect': {
    request: { accountId: string };
    response: ChannelAccountSnapshot | null;
  };
  'channels:logout': {
    request: { accountId: string };
    response: ChannelAccountSnapshot | null;
  };
  'channels:delete': {
    request: { accountId: string };
    response: { ok: true };
  };
  /** Proveniência de canal das sessões de chat de um workspace (badge/header). */
  'channels:session-meta': {
    request: { workspaceId: string };
    response: ChannelSessionMeta[];
  };
  /** Teams: sobe o túnel embutido, cria o app/bot via CLI da Microsoft com a URL
   *  pública e salva as credenciais. Devolve só os dados não-secretos (o client
   *  secret fica cifrado no main). */
  'channels:teams-create-app': {
    request: { accountId: string; name?: string };
    response:
      | { ok: true; appId: string; tenantId: string }
      | { ok: false; code: 'not-logged-in' | 'cli-missing' | 'failed'; message: string };
  };
  /** Teams: abre a página de login no navegador externo (botão da UI). */
  'channels:teams-open-page': {
    request: { url: string };
    response: { ok: true };
  };

  // ---- Project ----
  'project:list': {
    request: { workspaceId: string };
    response: Project[];
  };
  'project:create': {
    request: {
      workspaceId: string;
      name: string;
      path?: string;
      gitRemote?: string;
      provider?: 'local' | 'github';
      description?: string;
    };
    response: Project;
  };
  'project:delete': {
    request: { projectId: string };
    response: { ok: true };
  };
  'project:scan': {
    request: { projectId: string };
    response: { ok: true; indexedFiles: number } | { ok: false; error: string };
  };

  // ---- Agente (criação) ----
  'agent:create': {
    request: {
      workspaceId: string;
      name: string;
      role?: string;
      title?: string;
      adapterType: AdapterType;
      model?: string;
      adapterConfig?: Record<string, unknown>;
      systemPrompt?: string;
      avatarSeed?: string | null;
      canCreateAgents?: boolean;
      canAssignTasks?: boolean;
      canEditFiles?: boolean;
      canRunCommands?: boolean;
    };
    response: Agent;
  };
  /**
   * Cria (ou retorna, se já existir — idempotente) o CEO/Orchestrator do
   * workspace. Usado pelo wizard de criação de workspace na sidebar.
   */
  'agent:create-orchestrator': {
    request: {
      workspaceId: string;
      name: string;
      adapterType: AdapterType;
      model?: string;
      adapterConfig?: Record<string, unknown>;
    };
    response: Agent;
  };
  'agent:update': {
    request: {
      agentId: string;
      patch: {
        name?: string;
        title?: string | null;
        role?: string;
        adapterType?: AdapterType;
        adapterConfig?: Record<string, unknown>;
        model?: string | null;
        capabilities?: string | null;
        reportsTo?: string | null;
        avatarSeed?: string | null;
        runtimeConfig?: Record<string, unknown>;
        canCreateAgents?: boolean;
        canAssignTasks?: boolean;
        canEditFiles?: boolean;
        canRunCommands?: boolean;
        heartbeatEnabled?: boolean;
        heartbeatIntervalMinutes?: number;
      };
    };
    response: Agent;
  };
  'agent:pause': {
    request: { agentId: string; reason?: string };
    response: Agent;
  };
  'agent:resume': {
    request: { agentId: string };
    response: Agent;
  };
  'agent:list-instructions': {
    request: { agentId: string };
    response: AgentInstructionFile[];
  };
  'agent:read-instruction': {
    request: { agentId: string; fileName: string };
    response: { content: string };
  };
  'agent:write-instruction': {
    request: { agentId: string; fileName: string; content: string };
    response: AgentInstructionFile;
  };
  'agent:delete-instruction': {
    request: { agentId: string; fileName: string };
    response: { ok: true };
  };
  'agent:delete': {
    request: { agentId: string };
    response: { ok: true };
  };
  'agent:run-heartbeat': {
    request: { agentId: string };
    response: HeartbeatRun;
  };
  'agent:list-heartbeat-runs': {
    request: { agentId: string; limit?: number };
    response: HeartbeatRun[];
  };
  'agent:get-heartbeat-stats': {
    request: { agentId: string; days?: number };
    response: {
      total: number;
      succeeded: number;
      failed: number;
      avgDurationMs: number | null;
      lastStatus: HeartbeatRun['status'] | null;
    };
  };
  'agent:cancel-heartbeat': {
    request: { runId: string };
    response: { cancelled: boolean };
  };
  // ---- Atividade unificada (chat + heartbeat + code review) ----
  'agent:get-activity': {
    request: { agentId: string; limit?: number };
    response: AgentActivityItem[];
  };
  'agent:get-activity-stats': {
    request: { agentId: string; days?: number };
    response: AgentActivityStats;
  };
  // ---- API Keys ----
  'agent:list-api-keys': {
    request: { agentId: string };
    response: AgentApiKey[];
  };
  'agent:create-api-key': {
    request: { agentId: string; name: string };
    response: { key: AgentApiKey; token: string };
  };
  'agent:revoke-api-key': {
    request: { keyId: string };
    response: { ok: true };
  };
  // ---- Reset sessions (limpa sessões + mensagens do agente) ----
  'agent:reset-sessions': {
    request: { agentId: string };
    response: { deletedSessions: number };
  };

  // ---- Dialog nativo ----
  'dialog:open-directory': {
    request: { title?: string } | void;
    response: { path: string } | null;
  };
  'dialog:open-file': {
    request: { title?: string; filters?: { name: string; extensions: string[] }[] } | void;
    response: { path: string } | null;
  };

  // ---- User profile ----
  'user:get': {
    request: void;
    response: UserProfile | null;
  };
  'user:update': {
    request: Partial<UserProfile>;
    response: UserProfile;
  };

  // ---- Settings ----
  'settings:get': {
    request: void;
    response: SettingsRecord;
  };
  'settings:update': {
    request: Partial<SettingsRecord>;
    response: SettingsRecord;
  };
  'model-routing:decide': {
    request: {
      phase: ModelRoutingPhase;
      risk?: TaskRisk;
      localModelReady?: boolean;
      activeCliProvider?: string | null;
    };
    response: { decision: ModelRoutingDecision; ledgerLine: string };
  };

  // ---- Onboarding ----
  'onboarding:get': {
    request: void;
    response: OnboardingState;
  };
  'onboarding:set-step': {
    request: { step: number };
    response: OnboardingState;
  };
  'onboarding:complete': {
    request: OnboardingSubmission;
    response: { workspace: Workspace; project: Project | null; user: UserProfile };
  };
  'onboarding:reset': {
    request: void;
    response: OnboardingState;
  };

  // ---- Adapters CLI (Step 2 do onboarding) ----
  'adapter:list': {
    request: void;
    response: AdapterDescriptor[];
  };
  'adapter:list-models': {
    request: { type: AdapterType };
    response: AdapterModel[];
  };
  'adapter:test': {
    request: { type: AdapterType };
    response: AdapterTestResult;
  };
  /** Status da API key (cifrada) de cada provedor — pra a página Provedores. O valor
   *  em claro NUNCA volta pro renderer; só "configured" e se o provedor aceita key. */
  'provider:key-status': {
    request: void;
    response: Array<{ type: AdapterType; supportsApiKey: boolean; apiKeyConfigured: boolean }>;
  };
  'provider:set-key': {
    request: { type: AdapterType; apiKey: string };
    response: { configured: boolean };
  };
  'provider:clear-key': {
    request: { type: AdapterType };
    response: { configured: boolean };
  };

  // ---- Agentes ----
  'agent:list': {
    request: { workspaceId: string };
    response: Agent[];
  };
  'agent:source-assignments': {
    request: { workspaceId: string };
    response: SourceAgentAssignment[];
  };
  'agent:create-source-specialist': {
    request: { workspaceId: string; sourceId: string };
    response: Agent;
  };
  'agent:get': {
    request: { agentId: string };
    response: Agent | null;
  };

  // ---- Sessões de chat ----
  'session:list': {
    request: { workspaceId: string };
    response: ChatSession[];
  };
  'session:create': {
    request: {
      workspaceId: string;
      agentId: string;
      /** Id gerado no cliente pra navegação otimista (back insere com ele). Omisso = back gera. */
      sessionId?: string;
      title?: string;
      firstMessage?: string;
      /** Escopo do chat da primeira mensagem (igual chat:send). */
      scope?: 'all' | string[];
      /** Anexos (imagens/arquivos) da primeira mensagem — antes eram perdidos. */
      attachments?: ChatAttachment[];
    };
    response: { session: ChatSession; messages: ChatMessage[] };
  };
  'session:get': {
    request: { sessionId: string };
    response: { session: ChatSession; messages: ChatMessage[] } | null;
  };
  'session:delete': {
    request: { sessionId: string };
    response: { ok: true };
  };
  'session:archive': {
    request: { sessionId: string; archived: boolean };
    response: { ok: true };
  };

  // ---- Chat / envio de mensagem ----
  'chat:send': {
    request: {
      sessionId: string;
      content: string;
      /** Escopo do chat: 'all' (workspace inteiro) ou lista de sourceIds. */
      scope?: 'all' | string[];
      /** Anexos (imagens, arquivos) em base64. */
      attachments?: ChatAttachment[];
    };
    response: { runId: string; messageId: string; userMessageId: string };
  };
  'chat:cancel': {
    request: {
      runId: string;
      /** Stop manual (pause): NÃO despachar a próxima da fila ao fechar o run. */
      pause?: boolean;
    };
    response: { cancelled: boolean };
  };
  /**
   * Enfileira uma mensagem na fila persistida do MAIN. Se a sessão tem um run
   * ativo, fica `pending` e é despachada ao terminar; senão é enviada na hora.
   */
  'chat:enqueue': {
    request: {
      sessionId: string;
      content: string;
      scope?: 'all' | string[];
      attachments?: ChatAttachment[];
      kind?: 'queue' | 'steer';
    };
    response: { enqueued: boolean; items: ChatQueueItem[] };
  };
  /** Pendentes da fila de uma sessão (pra hidratar a UI no load). */
  'chat:queue-list': {
    request: { sessionId: string };
    response: { items: ChatQueueItem[] };
  };
  'chat:queue-set-kind': {
    request: { itemId: string; kind: 'queue' | 'steer' };
    response: { ok: true };
  };
  'chat:queue-cancel': {
    request: { itemId: string };
    response: { ok: true };
  };
  'hiring:apply-plan': {
    request: { sessionId: string; responseText: string; approved: boolean };
    // forgeNeeded: criou agente(s) Forge mas o modelo local não está baixado — o
    // card oferece baixar (~1.1GB); até lá esses agentes rodam no premium ($).
    response: { created: number; names: string[]; forgeNeeded: boolean };
  };
  /**
   * Dispara o plano de contratação inicial (time) do CEO em background para um
   * workspace já criado. Usado pelo wizard de criação de workspace (toggle
   * "gerar time inicial"); o onboarding usa o caminho próprio em
   * `onboarding:complete` / `workspace:finalize-github`.
   */
  'hiring:run-initial': {
    request: { workspaceId: string };
    response: { scheduled: boolean };
  };

  // ---- GitHub integration (Device Flow + repos) ----
  'github:get-account': {
    request: void;
    response: GithubAccount | null;
  };
  'github:list-accounts': {
    request: void;
    response: GithubAccount[];
  };
  'github:start-device-flow': {
    request: void;
    response: GithubDeviceCode;
  };
  'github:poll-device-flow': {
    request: { deviceCode: string };
    response: GithubDeviceFlowStatus;
  };
  'github:open-verification': {
    request: { url: string };
    response: { ok: true };
  };
  'github:open-access-settings': {
    request: void;
    response: { ok: true };
  };
  'github:disconnect': {
    request: { accountLogin?: string | null } | void;
    response: { ok: true };
  };
  'github:list-repos': {
    request: { accountLogin?: string | null } | void;
    response: GithubRepoSummary[];
  };
  'github:clone-repo': {
    request: { ownerRepo: string; workspaceId: string; branch?: string };
    response: { path: string };
  };
  'github:list-prs': {
    request: { ownerRepo: string };
    response: GithubPullRequest[];
  };
  'azure-devops:get-account': {
    request: void;
    response: AzureDevopsAccount | null;
  };
  'azure-devops:start-device-flow': {
    request: void;
    response: AzureDevopsDeviceCode;
  };
  'azure-devops:poll-device-flow': {
    request: { deviceCode: string };
    response: AzureDevopsDeviceFlowStatus;
  };
  'azure-devops:open-verification': {
    request: { url: string };
    response: { ok: true };
  };
  'azure-devops:disconnect': {
    request: void;
    response: { ok: true };
  };
  'azure-devops:list-repos': {
    request: { organization?: string };
    response: AzureDevopsRepoSummary[];
  };

  // ---- Sentry ----
  'sentry:get-account': {
    request: { workspaceId: string };
    response: {
      orgSlug: string;
      projectSlug: string | null;
      displayName: string | null;
      connectedAt: string;
    } | null;
  };
  'sentry:connect': {
    request: {
      workspaceId: string;
      orgSlug: string;
      projectSlug?: string | null;
      authToken: string;
    };
    response: {
      orgSlug: string;
      projectSlug: string | null;
      displayName: string | null;
      connectedAt: string;
    };
  };
  'sentry:disconnect': {
    request: { workspaceId: string };
    response: { ok: true };
  };
  'sentry:list-issues': {
    request: { workspaceId: string; limit?: number };
    response: Array<{
      id: string;
      shortId: string;
      title: string;
      culprit: string;
      level: string;
      count: number;
      userCount: number;
      lastSeen: string;
      permalink: string;
      project: string;
    }>;
  };
  /** Detalhe de uma issue: evento mais recente com stacktrace, breadcrumbs,
   *  request e tags. Pra a tela de detalhe e pro contexto da análise. */
  'sentry:get-issue': {
    request: { workspaceId: string; issueId: string };
    response: {
      id: string;
      shortId: string;
      title: string;
      culprit: string;
      level: string;
      count: number;
      userCount: number;
      firstSeen: string;
      lastSeen: string;
      permalink: string;
      project: string;
      platform: string | null;
      message: string | null;
      tags: Array<{ key: string; value: string }>;
      breadcrumbs: Array<{ category: string; level: string; message: string; timestamp: string }>;
      exception: {
        type: string;
        value: string;
        frames: Array<{
          filename: string;
          function: string;
          lineNo: number | null;
          inApp: boolean;
        }>;
      } | null;
      request: { method: string; url: string } | null;
    };
  };
  /** Pede pro CEO analisar e corrigir um erro do Sentry: cria/abre uma sessão de
   *  chat com o contexto do erro e dispara a mensagem. Retorna o sessionId. */
  'sentry:analyze-issue': {
    request: { workspaceId: string; issueId: string; agentId?: string | null };
    response: { sessionId: string };
  };
  /** Ajuste do workspace: intervalo de auto-refresh (observabilidade). */
  'sentry:get-automation': {
    request: { workspaceId: string };
    response: { refreshIntervalMin: number };
  };
  'sentry:set-automation': {
    request: { workspaceId: string; refreshIntervalMin: number };
    response: { refreshIntervalMin: number };
  };
  /** Regras de automação (várias por workspace). */
  'sentry:list-rules': {
    request: { workspaceId: string };
    response: Array<{
      id: string;
      name: string;
      enabled: boolean;
      minLevel: string;
      projectSlug: string | null;
      agentId: string | null;
      mode: 'propose' | 'auto';
    }>;
  };
  'sentry:save-rule': {
    request: {
      id?: string | null;
      workspaceId: string;
      name: string;
      enabled: boolean;
      minLevel: string;
      projectSlug: string | null;
      agentId: string | null;
      mode: 'propose' | 'auto';
    };
    response: {
      id: string;
      name: string;
      enabled: boolean;
      minLevel: string;
      projectSlug: string | null;
      agentId: string | null;
      mode: 'propose' | 'auto';
    };
  };
  'sentry:delete-rule': {
    request: { ruleId: string };
    response: { ok: true };
  };
  /** Histórico de execuções das regras. */
  'sentry:list-runs': {
    request: { workspaceId: string; limit?: number };
    response: Array<{
      id: string;
      ruleId: string;
      issueId: string;
      shortId: string | null;
      title: string | null;
      level: string | null;
      project: string | null;
      action: 'proposed' | 'analyzed';
      status: 'ok' | 'error';
      detail: string | null;
      createdAt: string;
    }>;
  };

  // ---- Observability providers (New Relic, Better Stack) ----
  'observability:get-account': {
    request: { workspaceId: string; provider: 'new_relic' | 'better_stack' };
    response: {
      provider: 'new_relic' | 'better_stack';
      displayName: string | null;
      connectedAt: string;
      config: Record<string, unknown>;
    } | null;
  };
  'observability:connect': {
    request: {
      workspaceId: string;
      provider: 'new_relic' | 'better_stack';
      token: string;
      displayName?: string | null;
      config?: Record<string, unknown>;
    };
    response: {
      provider: 'new_relic' | 'better_stack';
      displayName: string | null;
      connectedAt: string;
      config: Record<string, unknown>;
    };
  };
  'observability:disconnect': {
    request: { workspaceId: string; provider: 'new_relic' | 'better_stack' };
    response: { ok: true };
  };
  'observability:list-signals': {
    request: { workspaceId: string; provider: 'new_relic' | 'better_stack'; limit?: number };
    response: Array<{
      id: string;
      provider: 'new_relic' | 'better_stack';
      kind: 'error' | 'incident' | 'log';
      title: string;
      service: string | null;
      severity: string | null;
      count: number | null;
      lastSeen: string | null;
      url: string | null;
      summary: string;
      raw: Record<string, unknown>;
    }>;
  };
  'observability:get-signal': {
    request: { workspaceId: string; provider: 'new_relic' | 'better_stack'; signalId: string };
    response: {
      id: string;
      provider: 'new_relic' | 'better_stack';
      kind: 'error' | 'incident' | 'log';
      title: string;
      service: string | null;
      severity: string | null;
      count: number | null;
      lastSeen: string | null;
      url: string | null;
      summary: string;
      raw: Record<string, unknown>;
    };
  };
  'observability:analyze-signal': {
    request: {
      workspaceId: string;
      provider: 'new_relic' | 'better_stack';
      signal: {
        id: string;
        provider: 'new_relic' | 'better_stack';
        kind: 'error' | 'incident' | 'log';
        title: string;
        service: string | null;
        severity: string | null;
        count: number | null;
        lastSeen: string | null;
        url: string | null;
        summary: string;
        raw: Record<string, unknown>;
      };
      agentId?: string | null;
    };
    response: { sessionId: string };
  };
  'observability:list-rules': {
    request: { workspaceId: string; provider: 'new_relic' | 'better_stack' };
    response: Array<{
      id: string;
      name: string;
      enabled: boolean;
      kind: 'all' | 'error' | 'incident' | 'log';
      severity: string | null;
      serviceQuery: string | null;
      agentId: string | null;
      mode: 'propose' | 'auto';
      refreshIntervalMin: number;
    }>;
  };
  'observability:save-rule': {
    request: {
      id?: string | null;
      workspaceId: string;
      provider: 'new_relic' | 'better_stack';
      name: string;
      enabled: boolean;
      kind: 'all' | 'error' | 'incident' | 'log';
      severity?: string | null;
      serviceQuery?: string | null;
      agentId?: string | null;
      mode: 'propose' | 'auto';
      refreshIntervalMin?: number;
    };
    response: {
      id: string;
      name: string;
      enabled: boolean;
      kind: 'all' | 'error' | 'incident' | 'log';
      severity: string | null;
      serviceQuery: string | null;
      agentId: string | null;
      mode: 'propose' | 'auto';
      refreshIntervalMin: number;
    };
  };
  'observability:delete-rule': {
    request: { ruleId: string };
    response: { ok: true };
  };
  'observability:list-runs': {
    request: { workspaceId: string; provider: 'new_relic' | 'better_stack'; limit?: number };
    response: Array<{
      id: string;
      ruleId: string;
      signalId: string;
      title: string | null;
      kind: string | null;
      service: string | null;
      severity: string | null;
      action: 'proposed' | 'analyzed';
      status: 'ok' | 'error';
      detail: string | null;
      createdAt: string;
    }>;
  };

  // ---- Skills ----
  'skill:list': {
    request: { workspaceId: string };
    response: Skill[];
  };
  'skill:get': {
    request: { skillId: string };
    response: Skill | null;
  };
  'skill:create': {
    request: {
      workspaceId: string;
      name: string;
      kind?: SkillKind;
      description?: string | null;
      content?: string;
      config?: Record<string, unknown>;
    };
    response: Skill;
  };
  'skill:update': {
    request: {
      skillId: string;
      patch: {
        name?: string;
        description?: string | null;
        content?: string;
        kind?: SkillKind;
        config?: Record<string, unknown>;
      };
    };
    response: Skill;
  };
  'skill:delete': {
    request: { skillId: string };
    response: { ok: true };
  };
  'skill:list-by-agent': {
    request: { agentId: string };
    response: Skill[];
  };
  'skill:attach': {
    request: { agentId: string; skillId: string };
    response: { ok: true };
  };
  'skill:detach': {
    request: { agentId: string; skillId: string };
    response: { ok: true };
  };

  // ---- Marketplace (Skills/MCP) ----
  'marketplace:list': {
    request: { kind: 'skill' | 'mcp'; query?: string };
    response: MarketplaceCatalogItem[];
  };
  /** Versão paginada (infinite scroll): página `offset` + cursor `nextOffset`. */
  'marketplace:browse': {
    request: { kind: 'skill' | 'mcp'; query?: string; offset?: number };
    response: { items: MarketplaceCatalogItem[]; nextOffset: number | null };
  };
  /** Detecta MCPs já configurados nos CLIs do usuário (Claude, Codex, …). */
  'marketplace:detect-cli': {
    request: Record<string, never>;
    response: DetectedCliMcp[];
  };

  // ---- Execução inteligente (economia de tokens) ----
  /** Config GERENCIADA (modelo embutido) — somente leitura, sem setter. */
  'smart-exec:get-config': {
    request: Record<string, never>;
    response: SmartExecConfig;
  };
  'smart-exec:list-records': {
    request: { workspaceId: string; limit?: number };
    response: TaskExecutionRecord[];
  };
  'smart-exec:metrics': {
    request: { workspaceId: string };
    response: SmartExecMetricsSummary;
  };
  // ---- Economia de execução (Forge local vs premium) ----
  /** Contagens reais de execuções locais vs escalonamentos (tabela issue_runs). */
  'execStats:get': {
    request: void;
    response: ExecEconomics;
  };
  // ---- Diagnóstico de saúde + métricas de execução (página Logs) ----
  /** Findings heurísticos (suspicious/stuck/failed) + métricas agregadas do workspace. */
  'diagnostics:get': {
    request: { workspaceId: string };
    response: WorkspaceDiagnostics;
  };
  // ---- Logs / trace de execução (página Logs) ----
  /** Backfill do trace ao abrir a página (ao vivo vem pelo evento `logs:entry`). */
  'logs:list': {
    request: { limit?: number };
    response: TraceEntry[];
  };
  'logs:clear': {
    request: Record<string, never>;
    response: { ok: true };
  };
  'logs:list-agent-trace-events': {
    request: {
      workspaceId: string;
      issueId?: string;
      runId?: string;
      limit?: number;
    };
    response: AgentTraceEvent[];
  };
  'marketplace:install': {
    request: {
      workspaceId: string;
      item: MarketplaceCatalogItem;
      /** Valores das credenciais/env coletadas no diálogo (key → value). */
      env?: Record<string, string>;
      /**
       * Model-scopes onde habilitar. Default `['*']` (todos os modelos) — assim
       * trocar o adapter do agente (codex ↔ claude) mantém o item funcionando.
       */
      modelScopes?: string[];
    };
    response: Skill;
  };
  'marketplace:uninstall': {
    request: { skillId: string; modelScope?: string };
    response: { ok: true };
  };
  'marketplace:set-model-scopes': {
    request: { skillId: string; modelScopes: string[] };
    response: Skill;
  };
  /** Atualiza env e/ou model-scopes de um item instalado num único round-trip. */
  'marketplace:configure': {
    request: {
      skillId: string;
      env?: Record<string, string>;
      modelScopes?: string[];
    };
    response: Skill;
  };

  // ---- Issues ----
  'issue:list': {
    request: {
      workspaceId: string;
      status?: IssueStatus;
      assigneeAgentId?: string;
    };
    response: Issue[];
  };
  'issue:get': {
    request: { issueId: string };
    response: Issue | null;
  };
  'issue:children': {
    request: { parentIssueId: string };
    response: Issue[];
  };
  'issue:create-full': {
    request: {
      workspaceId: string;
      title: string;
      description?: string | null;
      status?: IssueStatus;
      priority?: IssuePriority;
      labels?: string[];
      assigneeAgentId?: string | null;
      reporterAgentId?: string | null;
      parentIssueId?: string | null;
      dueDate?: string | null;
    };
    response: Issue;
  };
  // Marca/desmarca um checkbox da checklist de execução (componente Tasks da issue).
  'issue:complete-checkbox': {
    request: { issueId: string; checkboxId: string; status: 'pending' | 'done' | 'blocked' };
    response: Issue;
  };
  // Atribui (agentId) ou tira (null) o responsável de uma task da checklist.
  'issue:update-checkbox-assignee': {
    request: { issueId: string; checkboxId: string; agentId: string | null };
    response: Issue;
  };
  'issue:update': {
    request: {
      issueId: string;
      patch: {
        title?: string;
        description?: string | null;
        status?: IssueStatus;
        priority?: IssuePriority;
        labels?: string[];
        assigneeAgentId?: string | null;
        parentIssueId?: string | null;
        goalId?: string | null;
        dueDate?: string | null;
      };
    };
    response: Issue;
  };
  'issue:delete': {
    request: { issueId: string };
    response: { ok: true };
  };
  'issue:bulk-delete': {
    request: { issueIds: string[] };
    response: { deleted: number };
  };
  'issue:bulk-set-status': {
    request: { issueIds: string[]; status: IssueStatus };
    response: { updated: number };
  };
  'issue:list-comments': {
    request: { issueId: string };
    response: IssueComment[];
  };
  'issue:add-comment': {
    request: {
      issueId: string;
      body: string;
      authorAgentId?: string | null;
      authorKind?: 'user' | 'agent' | 'system';
      attachments?: IssueAttachment[];
    };
    response: IssueComment;
  };
  'issue:delete-comment': {
    request: { commentId: string };
    response: { ok: true };
  };
  'qa:list-validations': {
    request: { issueId: string };
    response: QaValidation[];
  };
  'qa:get-latest-validation': {
    request: { issueId: string };
    response: QaValidation | null;
  };
  'issue:counts-by-status': {
    request: { workspaceId: string };
    response: Record<IssueStatus, number>;
  };
  /**
   * Decide um plano (épica + sub-issues). `approve` libera as sub-issues
   * (backlog → todo) e dispara execução automática das elegíveis;
   * `request_changes` registra a observação como comentário na épica.
   */
  'issue:decide-plan': {
    request: {
      epicIssueId: string;
      decision: 'approve' | 'request_changes' | 'reject';
      note?: string;
      attachments?: IssueAttachment[];
    };
    response: { ok: true; executed: number; cancelled: number };
  };
  'attachment:add-files': {
    request: void;
    response: { attachments: IssueAttachment[] };
  };
  'attachment:open': {
    request: { path: string };
    response: { ok: boolean };
  };

  // ---- Routines ----
  'routine:list': {
    request: { workspaceId: string };
    response: Routine[];
  };
  'routine:create': {
    request: {
      workspaceId: string;
      agentId: string;
      name: string;
      description?: string | null;
      prompt: string;
      intervalMinutes?: number;
      enabled?: boolean;
    };
    response: Routine;
  };
  'routine:update': {
    request: {
      routineId: string;
      patch: {
        name?: string;
        description?: string | null;
        prompt?: string;
        intervalMinutes?: number;
        enabled?: boolean;
        agentId?: string;
      };
    };
    response: Routine;
  };
  'routine:delete': {
    request: { routineId: string };
    response: { ok: true };
  };
  'routine:run-now': {
    request: { routineId: string };
    response: { ok: true };
  };

  // ---- Goals ----
  'goal:list': {
    request: { workspaceId: string };
    response: Goal[];
  };
  'goal:create': {
    request: {
      workspaceId: string;
      title: string;
      description?: string | null;
      ownerAgentId?: string | null;
      dueDate?: string | null;
      parentGoalId?: string | null;
    };
    response: Goal;
  };
  'goal:update': {
    request: {
      goalId: string;
      patch: {
        title?: string;
        description?: string | null;
        status?: 'active' | 'achieved' | 'archived';
        progress?: number;
        ownerAgentId?: string | null;
        dueDate?: string | null;
      };
    };
    response: Goal;
  };
  'goal:delete': {
    request: { goalId: string };
    response: { ok: true };
  };
  /** Aciona o CEO pra decompor o objetivo em issues. Retorna a sessão criada. */
  'goal:plan': {
    request: { goalId: string };
    response: { ok: true; sessionId: string };
  };
  /** Aciona o CEO pra verificar (goal-backward) se o objetivo foi alcançado. */
  'goal:verify': {
    request: { goalId: string };
    response: { ok: true; sessionId: string };
  };

  // ---- Workspace sources ----
  'source:list': {
    request: { workspaceId: string };
    response: WorkspaceSource[];
  };
  'source:create': {
    request: {
      workspaceId: string;
      kind: WorkspaceSourceKind;
      path?: string | null;
      repoFullName?: string | null;
      label: string;
      role?: WorkspaceSourceRole | null;
      isPrimary?: boolean;
      githubAccountLogin?: string | null;
      waitForClone?: boolean;
      /** github/azure SEM clone: grava o repoFullName (pra PRs) mas não baixa nem
       *  entra na árvore de código. Usado pelo "conectar pra PRs sem adicionar source". */
      skipClone?: boolean;
      runHiringPlanAfterCreate?: boolean;
      runKnowledgeAnalysisAfterCreate?: boolean;
    };
    response: WorkspaceSource;
  };
  /** Dedupe: acha um source que já mapeia este repo (github_repo direto OU pasta local
   *  cujo .git remote aponta pro mesmo owner/repo). null = nenhum. */
  'source:match-repo': {
    request: { workspaceId: string; repoFullName: string };
    response: { source: WorkspaceSource | null };
  };
  /** Promove um source local existente a github_repo (seta repoFullName) sem re-clonar. */
  'source:link-repo': {
    request: { sourceId: string; repoFullName: string };
    response: WorkspaceSource;
  };
  'source:update': {
    request: {
      sourceId: string;
      patch: {
        label?: string;
        role?: WorkspaceSourceRole | null;
        path?: string | null;
        repoFullName?: string | null;
        displayOrder?: number;
      };
    };
    response: WorkspaceSource;
  };
  'source:set-primary': {
    request: { sourceId: string };
    response: WorkspaceSource;
  };
  'source:delete': {
    request: { sourceId: string };
    response: { ok: true };
  };
  /** Lista PRs combinada de TODOS os repos github do workspace. */
  'source:list-all-prs': {
    request: { workspaceId: string };
    response: Array<{
      sourceId: string;
      sourceLabel: string;
      sourceRole: WorkspaceSourceRole | null;
      repoFullName: string;
      prs: GithubPullRequest[];
    }>;
  };
  /**
   * Versão PAGINADA do list-all-prs (infinite scroll). Busca SÓ uma página por
   * repo do estado pedido (open/closed/all) — evita o fetch de até 1000 PRs/repo
   * upfront que travava a tela. hasMore = algum repo encheu a página.
   */
  'source:list-prs-page': {
    request: {
      workspaceId: string;
      state: 'open' | 'closed' | 'all';
      page: number;
      perPage?: number;
    };
    response: {
      groups: Array<{
        sourceId: string;
        sourceLabel: string;
        sourceRole: WorkspaceSourceRole | null;
        repoFullName: string;
        prs: GithubPullRequest[];
      }>;
      hasMore: boolean;
    };
  };
  /** Abre dialog nativo de pasta. Retorna path absoluto ou null. */
  'source:pick-folder': {
    request: { defaultPath?: string };
    response: { path: string | null };
  };
  /** Lista subdiretórios dos sources do workspace (pra @ mention de pastas).
   *  relPath é relativo à raiz do source. Ignora node_modules/.git/etc e tem cap. */
  'source:list-dirs': {
    request: { workspaceId: string };
    response: Array<{ sourceId: string; sourceLabel: string; relPath: string }>;
  };
  /** Lista ARQUIVOS dos sources (pro `@` mencionar arquivos, estilo opencode). */
  'source:list-files': {
    request: { workspaceId: string };
    response: Array<{ sourceId: string; sourceLabel: string; relPath: string }>;
  };
  /** Varre uma pasta local procurando repos git (até 2 níveis). Se a própria
   *  pasta for repo (`rootIsGit`), não varre. Senão devolve os repos achados
   *  dentro pra adicionar cada um como source separada. */
  'source:scan-folder': {
    request: { path: string };
    response: {
      rootIsGit: boolean;
      /** Remote `origin` da pasta quando ela já é repo git (pra "apontar pro repo
       *  existente"). null quando é repo sem remote. */
      rootRemote?: {
        url: string;
        provider: 'github' | 'azure' | 'other';
        fullName: string;
      } | null;
      repos: Array<{ path: string; name: string; relPath: string }>;
    };
  };
  /** Lista UM nível de uma pasta dentro de uma source. relPath '' = raiz da source.
   *  Valida que o path resolvido fica dentro de source.path. Dirs antes de files. */
  'source:read-dir': {
    request: { sourceId: string; relPath: string };
    response: Array<{ name: string; relPath: string; kind: 'dir' | 'file' }>;
  };
  /** Lê um arquivo de texto dentro da source. Retorna binary/tooLarge quando não dá
   *  pra editar (byte nulo nos primeiros bytes, ou size > 2MB). */
  'source:read-file': {
    request: { sourceId: string; relPath: string };
    response:
      | { content: string; size: number; binary?: false; tooLarge?: false }
      | { binary: true }
      | { tooLarge: true; size: number };
  };
  /** Escreve um arquivo JÁ EXISTENTE dentro da source (utf-8). Rejeita criação. */
  'source:write-file': {
    request: { sourceId: string; relPath: string; content: string };
    response: { ok: true };
  };
  /** Cria um arquivo NOVO vazio dentro da source. Rejeita se já existe. */
  'source:create-file': { request: { sourceId: string; relPath: string }; response: { ok: true } };
  /** Cria um diretório NOVO dentro da source. Rejeita se já existe. */
  'source:create-dir': { request: { sourceId: string; relPath: string }; response: { ok: true } };
  /** Renomeia/move um arquivo ou pasta dentro da source. Rejeita se o alvo já existe. */
  'source:rename': {
    request: { sourceId: string; relPath: string; newRelPath: string };
    response: { ok: true };
  };
  /** Copia/duplica um arquivo ou pasta (recursivo) dentro da source. Rejeita se o alvo já existe. */
  'source:copy': {
    request: { sourceId: string; relPath: string; newRelPath: string };
    response: { ok: true };
  };
  /** Monta o permalink do GitHub pro arquivo (e linha). Só em source kind=github_repo. */
  'source:github-permalink': {
    request: { sourceId: string; relPath: string; line?: number };
    response: { url: string };
  };
  /** Manda um arquivo/pasta da source pra lixeira (trash). NÃO é o delete da source inteira. */
  'source:delete-file': { request: { sourceId: string; relPath: string }; response: { ok: true } };
  /** Revela um arquivo/pasta da source no gerenciador de arquivos do SO. */
  'source:reveal': { request: { sourceId: string; relPath: string }; response: { ok: true } };
  /** Busca conteúdo nos arquivos de texto da source (caps de match por arquivo e total). */
  'source:search': {
    request: {
      sourceId: string;
      query: string;
      opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean };
      scope?: string;
      include?: string;
      exclude?: string;
    };
    response: {
      results: Array<{
        relPath: string;
        matches: Array<{ line: number; column: number; preview: string }>;
      }>;
      truncated: boolean;
      fileCount: number;
      matchCount: number;
    };
  };
  /** Substitui todas as ocorrências de `query` por `replacement` nos arquivos de texto da source. */
  'source:replace-all': {
    request: {
      sourceId: string;
      query: string;
      replacement: string;
      opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean };
      scope?: string;
      include?: string;
      exclude?: string;
    };
    response: { files: number; occurrences: number };
  };

  // ---- Terminal integrado (PTY real via node-pty) ----
  /** Cria um terminal novo. Retorna o id; o I/O sai pelo evento `terminal:data`. `meta`
   *  é um marcador opaco do renderer (o sourceId) pra re-associar a aba no re-attach. */
  'terminal:create': {
    request: { cwd?: string; cols?: number; rows?: number; meta?: string };
    response: { id: string };
  };
  /** Lista os PTYs vivos no main (sobrevivem ao reload) — pro re-attach restaurar as abas +
   *  o buffer e voltar a poder matar a sessão (senão vira processo fantasma). */
  'terminal:list': {
    request: undefined;
    response: Array<{ id: string; cwd: string; meta?: string; buffer: string }>;
  };
  /** Envia input (teclado) pro pty. */
  'terminal:input': { request: { id: string; data: string }; response: { ok: true } };
  /** Redimensiona o pty (cols/rows do xterm). */
  'terminal:resize': {
    request: { id: string; cols: number; rows: number };
    response: { ok: true };
  };
  /** Mata o pty. */
  'terminal:kill': { request: { id: string }; response: { ok: true } };

  // ---- Docker (controlador de containers, Fase 1) ----
  /** Status do engine: connected | no-engine | error. */
  'docker:ping': {
    request: void;
    response: { status: 'connected' | 'no-engine' | 'error'; message?: string };
  };
  /** Engines Docker disponíveis no host (Docker Desktop, OrbStack, Colima, default). */
  'docker:list-engines': {
    request: void;
    response: {
      engines: Array<{
        id: string;
        label: string;
        socketPath: string;
        available: boolean;
        active: boolean;
      }>;
    };
  };
  /** Troca a engine ativa pelo socket escolhido. */
  'docker:set-engine': {
    request: { socketPath: string };
    response: { ok: true };
  };
  'docker:list-containers': {
    request: void;
    response: {
      containers: Array<{
        id: string;
        name: string;
        image: string;
        state: string;
        status: string;
        labels: Record<string, string>;
        /** Rótulo da engine de origem (Docker Desktop / OrbStack) — só no modo "Todas". */
        engine?: string;
      }>;
    };
  };
  'docker:list-images': {
    request: void;
    response: { images: Array<{ id: string; tags: string[]; sizeMb: number; created: number }> };
  };
  'docker:image-inspect': { request: { id: string }; response: { json: string } };
  'docker:list-volumes': {
    request: void;
    response: {
      volumes: Array<{
        name: string;
        driver: string;
        sizeBytes: number;
        created: string;
        mountpoint: string;
        labels: Record<string, string>;
      }>;
    };
  };
  'docker:list-networks': {
    request: void;
    response: {
      networks: Array<{
        id: string;
        name: string;
        driver: string;
        scope: string;
        subnet: string;
        gateway: string;
        created: string;
        labels: Record<string, string>;
      }>;
    };
  };
  'docker:stats-all': {
    request: void;
    response: {
      stats: Array<{
        id: string;
        name: string;
        project: string | null;
        image: string;
        cpuPercent: number;
        memUsedMb: number;
        netKbps: number;
        diskMbps: number;
      }>;
    };
  };
  'docker:container-action': {
    request: { id: string; action: 'start' | 'stop' | 'restart' | 'remove' };
    response: { ok: true };
  };
  'docker:inspect': { request: { id: string }; response: { json: string } };
  /** Lista o filesystem do container num diretório (aba Files). */
  'docker:list-files': {
    request: { id: string; path: string };
    response: {
      path: string;
      entries: Array<{
        name: string;
        isDir: boolean;
        size: number;
        modified: string;
        kind: 'Folder' | 'File' | 'Symlink';
      }>;
    };
  };
  'docker:logs-start': { request: { id: string }; response: { ok: true } };
  'docker:logs-stop': { request: { id: string }; response: { ok: true } };
  'docker:stats-start': { request: { id: string }; response: { ok: true } };
  'docker:stats-stop': { request: { id: string }; response: { ok: true } };
  /** Abre um exec (shell) no container. Retorna o execId pra reuso do xterm. */
  'docker:exec-start': {
    request: { id: string; cols: number; rows: number };
    response: { execId: string };
  };
  'docker:exec-input': { request: { execId: string; data: string }; response: { ok: true } };
  'docker:exec-resize': {
    request: { execId: string; cols: number; rows: number };
    response: { ok: true };
  };
  'docker:exec-kill': { request: { execId: string }; response: { ok: true } };

  // ---- Knowledge base ----
  'kb:list-pages': {
    request: { workspaceId: string; includeArchived?: boolean };
    response: KbPage[];
  };
  'kb:tree': {
    request: { workspaceId: string };
    response: KbPageNode[];
  };
  'kb:get-page': {
    request: { pageId: string };
    response: { page: KbPage; backlinks: KbBacklink[] } | null;
  };
  'kb:resolve-wikilink': {
    request: { workspaceId: string; label: string };
    response: KbPage | null;
  };
  'kb:create-page': {
    request: {
      workspaceId: string;
      title: string;
      parentId?: string | null;
      kind?: KbPageKind;
      contentMd?: string | null;
      icon?: string | null;
    };
    response: KbPage;
  };
  'kb:update-page': {
    request: {
      pageId: string;
      patch: {
        title?: string;
        parentId?: string | null;
        contentJson?: string | null;
        contentMd?: string | null;
        icon?: string | null;
        sortOrder?: number;
        isPinned?: boolean;
        isArchived?: boolean;
      };
      /** Links extraídos do conteúdo pra sincronizar. Opcional. */
      links?: Array<{
        targetKind: 'page' | 'entity' | 'external';
        targetId?: string | null;
        targetLabel?: string | null;
        targetUrl?: string | null;
      }>;
    };
    response: KbPage;
  };
  'kb:delete-page': {
    request: { pageId: string };
    response: { ok: true };
  };
  'kb:search': {
    request: { workspaceId: string; query: string; limit?: number; filters?: KbSearchFilters };
    response: KbSearchHit[];
  };
  'kb:get-graph': {
    request: { workspaceId: string };
    response: KbGraph;
  };
  'kb:rebuild-snapshots': {
    request: { workspaceId: string };
    response: {
      chunks: number;
      bkfPath: string;
      bkfSizeBytes: number;
      embeddings: number;
      embeddingJobId: string;
    };
  };
  'kb:get-bkf-info': {
    request: { workspaceId: string };
    response: {
      path: string;
      sizeBytes: number;
      modifiedAt: string;
    } | null;
  };
  'kb:cleanup-suggestions': {
    request: { workspaceId: string };
    response: KnowledgeCleanupSuggestion[];
  };
  'kb:embedding-status': {
    request: { workspaceId: string };
    response: KbEmbeddingJobSummary[];
  };
  'kb:analysis-status': {
    request: { workspaceId: string };
    response: KbAnalysisJobSummary[];
  };
  'kb:source-coverage': {
    request: { workspaceId: string };
    response: KbSourceCoverageSummary[];
  };
  'kb:cancel-embedding-job': {
    request: { jobId: string };
    response: { cancelled: boolean };
  };
  'kb:evaluate-rag': {
    request: { workspaceId: string; query: string; expectedPageIds?: string[]; limit?: number };
    response: RagEvaluationRun;
  };
  'kb:list-rag-evaluations': {
    request: { workspaceId: string; limit?: number };
    response: RagEvaluationRun[];
  };
  'kb:record-rag-feedback': {
    request: {
      workspaceId: string;
      query: string;
      pageId: string;
      label: 'positive' | 'negative' | 'correction' | 'neutral';
      expectedAnswer?: string | null;
      actualAnswer?: string | null;
      metadata?: Record<string, unknown> | null;
    };
    response: AiTrainingExample;
  };
  'kb:list-training-examples': {
    request: { workspaceId: string; limit?: number };
    response: AiTrainingExample[];
  };
  'kb:fine-tuning-readiness': {
    request: { workspaceId: string };
    response: FineTuningReadiness;
  };
  'kb:curate-training-example': {
    request: {
      id: string;
      status?: 'candidate' | 'approved' | 'exported' | 'ignored';
      label?: 'positive' | 'negative' | 'correction' | 'neutral';
      expectedOutput?: string | null;
      actualOutput?: string | null;
      metadata?: Record<string, unknown> | null;
    };
    response: AiTrainingExample | null;
  };
  'kb:export-training-dataset': {
    request: {
      workspaceId: string;
      limit?: number;
      includeCandidates?: boolean;
      validationRatio?: number;
      format?: 'jsonl' | 'chat-jsonl' | 'trajectory-jsonl';
    };
    response: TrainingDatasetExport;
  };
  'kb:export-training-pack': {
    request: {
      workspaceId: string;
      limit?: number;
      includeCandidates?: boolean;
      validationRatio?: number;
    };
    response: TrainingPackExport;
  };
  'kb:run-rag-benchmark': {
    request: { workspaceId: string; limit?: number };
    response: RagBenchmarkSummary;
  };
  'kb:analyze-source': {
    request: { workspaceId: string; sourceId: string };
    response: { jobId: string };
  };
  'kb:cancel-analyze': {
    request: { jobId: string };
    response: { cancelled: boolean };
  };
  'kb:request-source-analysis': {
    request: { workspaceId: string; sourceId: string };
    response: { issueId: string; issueKey: number; prefix: string };
  };
  'issue:execute': {
    request: { issueId: string };
    response: { runId: string };
  };
  /**
   * Aprova o plano de issues criado num chat: executa as issues (folhas, com
   * assignee) originadas naquela sessão que ainda estão pendentes (backlog).
   * Retorna quantas foram disparadas.
   */
  'issues:run-plan': {
    // selectedEpicIds (opcional): aprova/roda só os épicos escolhidos (e seus filhos);
    // ausente = aprova o plano TODO da sessão (comportamento legado). replanEpics
    // (opcional): épicos a NÃO aprovar agora — recebem o comentário e voltam pro CEO
    // refinar (segura só aquele épico; o resto segue).
    request: {
      workspaceId: string;
      sessionId: string;
      selectedEpicIds?: string[];
      replanEpics?: Array<{ epicId: string; comment: string }>;
    };
    response: { started: number; approvedPlans: number };
  };
  'issue:cancel-execution': {
    request: { issueId: string };
    response: { cancelled: boolean };
  };
  /** STOP GLOBAL: para TUDO no workspace — mata todos os runs ativos, limpa a fila e
   *  halta o auto-avanço do plano. Disparado pelo botão de parar do chat. */
  'exec:stop-all': {
    request: { workspaceId: string };
    response: { cancelled: number };
  };
  'issue:list-runs': {
    request: { issueId: string };
    response: IssueRun[];
  };
  'issue:list-execution-events': {
    request: { issueIds: string[]; limitPerIssue?: number };
    response: Record<string, IssueExecutionEvent[]>;
  };
  // ---- Relações de issue (Paperclip): dependências, reviewers, monitor ----
  'issue:get-relations': {
    request: { issueId: string };
    response: IssueRelations;
  };
  'issue:add-dependency': {
    request: { workspaceId: string; blockerIssueId: string; blockedIssueId: string };
    response: { ok: true };
  };
  'issue:remove-dependency': {
    request: { linkId: string };
    response: { ok: true };
  };
  'issue:add-reviewer': {
    request: { issueId: string; agentId: string; role: IssueReviewerRole };
    response: IssueReviewer;
  };
  'issue:remove-reviewer': {
    request: { id: string };
    response: { ok: true };
  };
  'issue:set-reviewer-decision': {
    request: { id: string; decision: IssueReviewerDecision };
    response: { ok: true };
  };
  'issue:set-monitor': {
    request: { issueId: string; schedule: string | null };
    response: { ok: true };
  };
  'issue:get-by-key': {
    request: { workspaceId: string; issueKey: number };
    response: Issue | null;
  };

  // ---- Code review ----
  'code-review:list': {
    request: { workspaceId: string; limit?: number };
    response: CodeReview[];
  };
  'code-review:get': {
    request: { reviewId: string };
    response: { review: CodeReview; comments: CodeReviewComment[] } | null;
  };
  'code-review:latest-for-pr': {
    request: { workspaceId: string; repoFullName: string; prNumber: number };
    response: CodeReview | null;
  };
  'code-review:run': {
    request: {
      workspaceId: string;
      repoFullName: string;
      prNumber: number;
      reviewerAgentId?: string | null;
      linkedPrs?: CodeReviewLinkedPr[];
    };
    response: { reviewId: string };
  };
  'code-review:cancel': {
    request: { reviewId: string };
    response: { ok: boolean };
  };
  'code-review:get-diff': {
    request: { workspaceId: string; repoFullName: string; prNumber: number };
    response: { diff: string; files: Array<{ filePath: string; hunk: string }> };
  };
  'code-review:apply-suggestion': {
    request: { commentId: string };
    response: { ok: boolean; appliedTo: string };
  };
  'code-review:post-to-github': {
    request: { reviewId: string };
    response: { ok: true };
  };
  'code-review:update-comment-resolution': {
    request: { commentId: string; resolution: 'pending' | 'resolved' | 'ignored' };
    response: { ok: true };
  };
  'code-review:delete': {
    request: { reviewId: string };
    response: { ok: true };
  };

  // ---- Code changes (git operations no source ativo) ----
  /** Detecta se o path local da source é um repo git (existe `.git`). UI usa
   *  pra decidir se mostra a parte de git — pasta local pura não tem. */
  'git:is-repo': {
    request: { sourceId: string };
    response: { isRepo: boolean };
  };
  /** `git init -b main` numa pasta local que ainda não é repo (botão "Criar repositório"). */
  'git:init': {
    request: { sourceId: string };
    response: { ok: true };
  };
  'git:status': {
    request: { sourceId: string };
    response: {
      branch: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      files: Array<{
        path: string;
        indexStatus: string;
        workingStatus: string;
        staged: boolean;
        unstaged: boolean;
        oldPath?: string;
      }>;
    };
  };
  'git:diff': {
    request: { sourceId: string; filePath: string; staged?: boolean };
    response: { diff: string };
  };
  'git:branches': {
    request: { sourceId: string };
    response: Array<{
      name: string;
      current: boolean;
      remote: boolean;
      upstream?: string;
      lastCommit?: { sha: string; subject: string; relativeDate: string };
    }>;
  };
  'git:checkout': {
    request: { sourceId: string; branch: string };
    response: { ok: true };
  };
  'git:create-branch': {
    request: { sourceId: string; name: string; fromBranch?: string };
    response: { ok: true };
  };
  'git:stage': {
    request: { sourceId: string; files: string[] };
    response: { ok: true };
  };
  'git:unstage': {
    request: { sourceId: string; files: string[] };
    response: { ok: true };
  };
  'git:commit': {
    request: { sourceId: string; message: string; files?: string[] };
    response: { sha: string };
  };
  'git:push': {
    request: { sourceId: string; branch?: string };
    response: { ok: true };
  };
  'git:fetch': {
    request: { sourceId: string };
    response: { ok: true };
  };
  'git:open-pr': {
    request: {
      sourceId: string;
      title: string;
      body?: string;
      base: string;
      head: string;
      draft?: boolean;
    };
    response: { number: number; htmlUrl: string };
  };
  /**
   * Sugere título/corpo do PR (via Forge local) a partir do diff da branch atual
   * vs a base (default do repo). Resolve a base automaticamente se não vier.
   */
  'git:suggest-pr': {
    request: { sourceId: string; base?: string };
    response: { title: string; body: string; base: string };
  };
  /**
   * Cria o PR "prontinho": publica (push -u) a branch atual no remoto, resolve a
   * base (default do repo se não vier) e abre o PR. head = branch atual.
   */
  'git:create-pr': {
    request: { sourceId: string; title: string; body?: string; base?: string; draft?: boolean };
    response: { number: number; htmlUrl: string };
  };
  'git:log': {
    request: { sourceId: string; limit?: number; branch?: string };
    response: Array<{
      sha: string;
      shortSha: string;
      subject: string;
      body: string;
      authorName: string;
      authorEmail: string;
      relativeDate: string;
      isoDate: string;
    }>;
  };
  'git:discard': {
    request: { sourceId: string; files: string[]; issueId?: string; snapshotId?: string };
    response: { ok: true };
  };
  'git:show-commit': {
    request: { sourceId: string; sha: string };
    response: {
      sha: string;
      shortSha: string;
      subject: string;
      body: string;
      authorName: string;
      authorEmail: string;
      relativeDate: string;
      isoDate: string;
      parents: string[];
      files: Array<{
        path: string;
        oldPath?: string;
        status: string;
        additions: number;
        deletions: number;
      }>;
    };
  };
  'git:commit-file-diff': {
    request: { sourceId: string; sha: string; filePath: string };
    response: { diff: string };
  };
  'git:pull': {
    request: { sourceId: string; rebase?: boolean; branch?: string };
    response: { summary: string };
  };
  /**
   * Gera (via LLM local Forge, com fallback heurístico) uma mensagem de commit
   * a partir do diff dos arquivos alterados. Nunca lança: sempre devolve algo.
   */
  'git:suggest-commit': {
    request: { sourceId: string; files?: string[] };
    response: { summary: string; description: string };
  };
  'git:ignore': {
    request: { sourceId: string; patterns: string[] };
    response: { ok: true };
  };
  'shell:reveal': {
    request: { sourceId: string; relPath: string };
    response: { ok: true };
  };
  'shell:open-path': {
    request: { sourceId: string; relPath: string };
    response: { ok: boolean };
  };

  // ---- Activity log ----
  'activity:list': {
    request: { workspaceId: string; limit?: number };
    response: ActivityEntry[];
  };

  // ---- Voice pack + ditado ----
  /** Retorna o status atual do voice pack (instalado, instalando, versão, etc.). */
  'voice:get-status': {
    request: void;
    response: VoicePackStatus;
  };
  /** Inicia o download+instalação do voice pack. Progresso via evento `voice:install-progress`. */
  'voice:install': {
    request: void;
    response: { ok: true };
  };
  /** Remove os arquivos do voice pack instalado. */
  'voice:uninstall': {
    request: void;
    response: { ok: true };
  };
  /** Cria uma nova sessão de ditado e retorna o sessionId gerado. */
  'voice:dictation-start': {
    request: void;
    response: { sessionId: string };
  };
  /**
   * Envia um bloco de PCM para o buffer e solicita transcrição parcial (ao vivo).
   * `pcm` é um ArrayBuffer de Float32 mono 16kHz.
   */
  'voice:dictation-tick': {
    request: { sessionId: string; pcm: ArrayBuffer; sampleRate: number };
    response: { committedText: string; tailText: string };
  };
  /**
   * Envia o bloco final de PCM, encerra a sessão e devolve o texto definitivo.
   * `pcm` pode ser vazio (byteLength 0) se não houve áudio extra desde o último tick.
   */
  'voice:dictation-stop': {
    request: { sessionId: string; pcm: ArrayBuffer; sampleRate: number };
    response: { finalText: string };
  };
  /** Cancela a sessão de ditado sem transcrever. */
  'voice:dictation-cancel': {
    request: { sessionId: string };
    response: void;
  };

  // ---- Stubs reservados para fases futuras (apenas tipagem) ----
  'knowledge:index': { request: { projectId: string }; response: { jobId: string } };
  'knowledge:search': { request: { query: string }; response: { hits: unknown[] } };
  'mcp:list': { request: void; response: unknown[] };
  'integration:connect': { request: { provider: string }; response: { ok: boolean } };
};

export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request'];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response'];

/**
 * Tipo do handler implementado no main process.
 * Cada handler recebe o request e devolve a response (sync ou async).
 */
export type IpcHandler<C extends IpcChannel> = (
  request: IpcRequest<C>,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

/**
 * Tipo da API exposta pelo preload no renderer.
 * Cada canal vira um método `invoke<Channel>(request) => Promise<response>`.
 */
export type OrkestralApi = {
  [C in IpcChannel]: IpcRequest<C> extends void
    ? () => Promise<IpcResponse<C>>
    : (request: IpcRequest<C>) => Promise<IpcResponse<C>>;
};

/**
 * Lista de canais (usada pelo preload pra montar a API dinamicamente).
 */
export const IPC_CHANNELS = [
  'app:get-version',
  'system:hardware',
  'system:memory-stats',
  'update:check',
  'update:open',
  'update:download',
  'update:quit-and-install',
  'system:open-datetime-settings',
  'models:embeddings-status',
  'models:download-embeddings',
  'models:fast-apply-status',
  'models:download-fast-apply',
  'app:quit',
  'window:minimize',
  'window:toggle-maximize',
  'webview:set-devtools',
  'window:close',
  'pet:set-ignore-mouse',
  'pet:set-enabled',
  'pet:open-target',
  'pet:drag-start',
  'pet:drag-end',
  'app:logout',
  'app:webview-preload-path',
  'cloud:get-account',
  'cloud:login-start',
  'cloud:logout',
  'system:set-zoom',
  'system:apply-visibility',
  'system:focus-window',
  'data:stats',
  'data:export',
  'data:reveal',
  'data:clear-cache',
  'data:cleanup-preview',
  'data:cleanup-run',
  'data:clear-chat-history',
  'workspace:list',
  'workspace:create',
  'workspace:switch',
  'workspace:update',
  'workspace:finalize-github',
  'workspace:list-archived',
  'workspace:archive',
  'workspace:unarchive',
  'workspace:delete',
  'engine-v2:run-slice',
  'preview:start',
  'preview:stop',
  'preview:status',
  'channels:list',
  'channels:create',
  'channels:set-config',
  'channels:set-telegram-token',
  'channels:connect',
  'channels:disconnect',
  'channels:logout',
  'channels:delete',
  'channels:session-meta',
  'channels:teams-create-app',
  'channels:teams-open-page',
  'project:list',
  'project:create',
  'project:delete',
  'project:scan',
  'user:get',
  'user:update',
  'settings:get',
  'settings:update',
  'model-routing:decide',
  'onboarding:get',
  'onboarding:set-step',
  'onboarding:complete',
  'onboarding:reset',
  'adapter:list',
  'adapter:list-models',
  'adapter:test',
  'provider:key-status',
  'provider:set-key',
  'provider:clear-key',
  'agent:list',
  'agent:source-assignments',
  'agent:create-source-specialist',
  'agent:get',
  'agent:create',
  'agent:create-orchestrator',
  'agent:update',
  'agent:pause',
  'agent:resume',
  'agent:list-instructions',
  'agent:read-instruction',
  'agent:write-instruction',
  'agent:delete-instruction',
  'agent:delete',
  'agent:run-heartbeat',
  'agent:list-heartbeat-runs',
  'agent:get-heartbeat-stats',
  'agent:get-activity',
  'agent:get-activity-stats',
  'agent:cancel-heartbeat',
  'agent:list-api-keys',
  'agent:create-api-key',
  'agent:revoke-api-key',
  'agent:reset-sessions',
  'skill:list',
  'skill:get',
  'skill:create',
  'skill:update',
  'skill:delete',
  'skill:list-by-agent',
  'skill:attach',
  'skill:detach',
  'marketplace:list',
  'marketplace:browse',
  'marketplace:detect-cli',
  'smart-exec:get-config',
  'smart-exec:list-records',
  'smart-exec:metrics',
  'execStats:get',
  'diagnostics:get',
  'logs:list',
  'logs:clear',
  'logs:list-agent-trace-events',
  'marketplace:install',
  'marketplace:uninstall',
  'marketplace:set-model-scopes',
  'marketplace:configure',
  'issue:list',
  'issue:get',
  'issue:children',
  'issue:create-full',
  'issue:complete-checkbox',
  'issue:update-checkbox-assignee',
  'issue:update',
  'issue:delete',
  'issue:bulk-delete',
  'issue:bulk-set-status',
  'issue:list-comments',
  'issue:add-comment',
  'issue:delete-comment',
  'qa:list-validations',
  'qa:get-latest-validation',
  'issue:counts-by-status',
  'issue:decide-plan',
  'attachment:add-files',
  'attachment:open',
  'git:is-repo',
  'git:init',
  'git:status',
  'git:diff',
  'git:branches',
  'git:checkout',
  'git:create-branch',
  'git:stage',
  'git:unstage',
  'git:commit',
  'git:push',
  'git:fetch',
  'git:open-pr',
  'git:suggest-pr',
  'git:create-pr',
  'git:log',
  'git:discard',
  'git:show-commit',
  'git:commit-file-diff',
  'git:pull',
  'git:suggest-commit',
  'git:ignore',
  'shell:reveal',
  'shell:open-path',
  'activity:list',
  'source:list',
  'source:create',
  'source:match-repo',
  'source:link-repo',
  'source:update',
  'source:set-primary',
  'source:delete',
  'source:list-all-prs',
  'source:list-prs-page',
  'source:pick-folder',
  'source:list-dirs',
  'source:list-files',
  'source:scan-folder',
  'source:read-dir',
  'source:read-file',
  'source:write-file',
  'source:create-file',
  'source:create-dir',
  'source:rename',
  'source:copy',
  'source:github-permalink',
  'source:delete-file',
  'source:reveal',
  'source:search',
  'source:replace-all',
  'terminal:create',
  'terminal:list',
  'terminal:input',
  'terminal:resize',
  'terminal:kill',
  'docker:ping',
  'docker:list-engines',
  'docker:set-engine',
  'docker:list-containers',
  'docker:list-images',
  'docker:image-inspect',
  'docker:list-volumes',
  'docker:list-networks',
  'docker:stats-all',
  'docker:container-action',
  'docker:inspect',
  'docker:list-files',
  'docker:logs-start',
  'docker:logs-stop',
  'docker:stats-start',
  'docker:stats-stop',
  'docker:exec-start',
  'docker:exec-input',
  'docker:exec-resize',
  'docker:exec-kill',
  'kb:list-pages',
  'kb:tree',
  'kb:get-page',
  'kb:resolve-wikilink',
  'kb:create-page',
  'kb:update-page',
  'kb:delete-page',
  'kb:search',
  'kb:get-graph',
  'kb:rebuild-snapshots',
  'kb:get-bkf-info',
  'kb:cleanup-suggestions',
  'kb:embedding-status',
  'kb:analysis-status',
  'kb:source-coverage',
  'kb:cancel-embedding-job',
  'kb:evaluate-rag',
  'kb:list-rag-evaluations',
  'kb:record-rag-feedback',
  'kb:list-training-examples',
  'kb:fine-tuning-readiness',
  'kb:curate-training-example',
  'kb:export-training-dataset',
  'kb:export-training-pack',
  'kb:run-rag-benchmark',
  'kb:analyze-source',
  'kb:cancel-analyze',
  'kb:request-source-analysis',
  'issue:execute',
  'issues:run-plan',
  'issue:cancel-execution',
  'exec:stop-all',
  'issue:list-runs',
  'issue:list-execution-events',
  'issue:get-relations',
  'issue:add-dependency',
  'issue:remove-dependency',
  'issue:add-reviewer',
  'issue:remove-reviewer',
  'issue:set-reviewer-decision',
  'issue:set-monitor',
  'issue:get-by-key',
  'code-review:list',
  'code-review:get',
  'code-review:latest-for-pr',
  'code-review:run',
  'code-review:cancel',
  'code-review:get-diff',
  'code-review:apply-suggestion',
  'code-review:post-to-github',
  'code-review:update-comment-resolution',
  'code-review:delete',
  'routine:list',
  'routine:create',
  'routine:update',
  'routine:delete',
  'routine:run-now',
  'goal:list',
  'goal:create',
  'goal:update',
  'goal:delete',
  'goal:plan',
  'goal:verify',
  'dialog:open-directory',
  'dialog:open-file',
  'github:get-account',
  'github:list-accounts',
  'github:start-device-flow',
  'github:poll-device-flow',
  'github:open-verification',
  'github:open-access-settings',
  'github:disconnect',
  'github:list-repos',
  'github:clone-repo',
  'github:list-prs',
  'azure-devops:get-account',
  'azure-devops:start-device-flow',
  'azure-devops:poll-device-flow',
  'azure-devops:open-verification',
  'azure-devops:disconnect',
  'azure-devops:list-repos',
  'sentry:get-account',
  'sentry:connect',
  'sentry:disconnect',
  'sentry:list-issues',
  'sentry:get-issue',
  'sentry:analyze-issue',
  'sentry:get-automation',
  'sentry:set-automation',
  'sentry:list-rules',
  'sentry:save-rule',
  'sentry:delete-rule',
  'sentry:list-runs',
  'observability:get-account',
  'observability:connect',
  'observability:disconnect',
  'observability:list-signals',
  'observability:get-signal',
  'observability:analyze-signal',
  'observability:list-rules',
  'observability:save-rule',
  'observability:delete-rule',
  'observability:list-runs',
  'session:list',
  'session:create',
  'session:get',
  'session:delete',
  'session:archive',
  'chat:send',
  'chat:cancel',
  'chat:enqueue',
  'chat:queue-list',
  'chat:queue-set-kind',
  'chat:queue-cancel',
  'hiring:apply-plan',
  'hiring:run-initial',
  'voice:get-status',
  'voice:install',
  'voice:uninstall',
  'voice:dictation-start',
  'voice:dictation-tick',
  'voice:dictation-stop',
  'voice:dictation-cancel',
  'knowledge:index',
  'knowledge:search',
  'mcp:list',
  'integration:connect',
] as const satisfies readonly IpcChannel[];
