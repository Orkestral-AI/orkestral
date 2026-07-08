import type Database from 'better-sqlite3';

/**
 * Migrations versionadas e idempotentes.
 *
 * Cada migration tem um `version` e um SQL que é executado uma única vez.
 * O versionamento usa `PRAGMA user_version` do SQLite.
 *
 * Regras:
 *  - nunca editar uma migration já publicada (commitada);
 *  - sempre criar uma nova migration para mudanças;
 *  - migrations não dependem de outras tabelas além das criadas anteriormente.
 */

type Migration = {
  version: number;
  name: string;
  sql: string;
};

const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        email TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
        use_device_timezone INTEGER NOT NULL DEFAULT 1,
        language TEXT NOT NULL DEFAULT 'pt-BR',
        ai_style TEXT NOT NULL DEFAULT 'concise',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT,
        color TEXT,
        plan_mode TEXT NOT NULL DEFAULT 'local',
        active_project_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        path TEXT,
        git_remote TEXT,
        provider TEXT,
        description TEXT,
        knowledge_base_status TEXT NOT NULL DEFAULT 'not_started',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'onboarding',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS onboarding_state (
        id TEXT PRIMARY KEY DEFAULT 'singleton',
        completed INTEGER NOT NULL DEFAULT 0,
        step INTEGER NOT NULL DEFAULT 0,
        plan TEXT,
        llm_provider TEXT,
        objectives TEXT NOT NULL DEFAULT '[]',
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'agents',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        title TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        effort TEXT NOT NULL DEFAULT 'medium',
        system_prompt TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idle',
        is_orchestrator INTEGER NOT NULL DEFAULT 0,
        can_create_agents INTEGER NOT NULL DEFAULT 0,
        can_assign_tasks INTEGER NOT NULL DEFAULT 0,
        can_edit_files INTEGER NOT NULL DEFAULT 0,
        can_run_commands INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_agents_orchestrator ON agents(workspace_id, is_orchestrator);
    `,
  },
  {
    version: 4,
    name: 'company_and_adapter_fields',
    sql: /* sql */ `
      -- Workspace ganha "company name", missão e objetivos do onboarding novo
      ALTER TABLE workspaces ADD COLUMN company_name TEXT;
      ALTER TABLE workspaces ADD COLUMN mission TEXT;
      ALTER TABLE workspaces ADD COLUMN objectives TEXT NOT NULL DEFAULT '[]';

      -- Agente ganha adapter_type (claude_local, codex_local, ...) e
      -- adapter_config (json livre — model, fastMode, etc.).
      ALTER TABLE agents ADD COLUMN adapter_type TEXT;
      ALTER TABLE agents ADD COLUMN adapter_config TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    version: 5,
    name: 'chat_sessions_messages_runs',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT 'Nova conversa',
        last_model TEXT,
        last_directory TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON chat_sessions(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace_updated
        ON chat_sessions(workspace_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        parts TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'done',
        run_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        adapter_type TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        exit_code INTEGER,
        error_message TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session ON agent_runs(session_id);
    `,
  },
  {
    version: 6,
    name: 'workspace_is_project',
    sql: /* sql */ `
      ALTER TABLE workspaces ADD COLUMN path TEXT;
      ALTER TABLE workspaces ADD COLUMN git_remote TEXT;
      ALTER TABLE workspaces ADD COLUMN provider TEXT;
    `,
  },
  {
    version: 7,
    name: 'github_accounts',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS github_accounts (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        display_name TEXT,
        avatar_url TEXT,
        token_encrypted BLOB NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 8,
    name: 'workspace_archive',
    sql: /* sql */ `
      ALTER TABLE workspaces ADD COLUMN archived_at TEXT;
    `,
  },
  {
    version: 9,
    name: 'agent_identity_runtime_pause',
    sql: /* sql */ `
      -- Hierarquia
      ALTER TABLE agents ADD COLUMN reports_to TEXT;

      -- Identity
      ALTER TABLE agents ADD COLUMN capabilities TEXT;

      -- Runtime config (cheap model, thinking effort, bypass sandbox, etc.)
      ALTER TABLE agents ADD COLUMN runtime_config TEXT NOT NULL DEFAULT '{}';

      -- Pause state
      ALTER TABLE agents ADD COLUMN pause_reason TEXT;
      ALTER TABLE agents ADD COLUMN paused_at TEXT;

      -- Heartbeat tracking (preparação pra Fase 2)
      ALTER TABLE agents ADD COLUMN last_heartbeat_at TEXT;

      CREATE INDEX IF NOT EXISTS idx_agents_reports_to ON agents(reports_to);
    `,
  },
  {
    version: 10,
    name: 'heartbeat_runs',
    sql: /* sql */ `
      -- Config de heartbeat por agente
      ALTER TABLE agents ADD COLUMN heartbeat_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agents ADD COLUMN heartbeat_interval_minutes INTEGER NOT NULL DEFAULT 30;

      -- Tabela de runs (heartbeat e manual)
      CREATE TABLE IF NOT EXISTS heartbeat_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

        -- Origem: 'manual' (botão Run Heartbeat) ou 'scheduler' (intervalo)
        source TEXT NOT NULL,

        -- Status do ciclo: queued → running → succeeded | failed | cancelled
        status TEXT NOT NULL DEFAULT 'queued',

        started_at TEXT NOT NULL,
        finished_at TEXT,

        -- Output do CLI (truncado pros últimos N chars pra não estourar DB)
        output TEXT,
        error_message TEXT,

        -- Tracking de processo
        exit_code INTEGER,
        duration_ms INTEGER,

        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_agent
        ON heartbeat_runs(agent_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_workspace
        ON heartbeat_runs(workspace_id, started_at DESC);
    `,
  },
  {
    version: 11,
    name: 'agent_api_keys',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS agent_api_keys (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        token_preview TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_agent ON agent_api_keys(agent_id);
    `,
  },
  {
    version: 12,
    name: 'skills_issues',
    sql: /* sql */ `
      -- Skills: capabilities reutilizáveis que podem ser linkadas a agentes.
      -- Kind: 'instruction' (markdown injetado), 'mcp' (server config), 'tool' (futuro).
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'instruction',
        description TEXT,
        content TEXT NOT NULL DEFAULT '',
        config TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_skills_workspace ON skills(workspace_id);

      -- Junção agent ↔ skill
      CREATE TABLE IF NOT EXISTS agent_skills (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, skill_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_skills_skill ON agent_skills(skill_id);

      -- Issues / tasks atribuíveis a agentes
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        -- Key sequencial humana tipo ORK-1, ORK-2...
        issue_key INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'backlog', -- enum values vão no Drizzle
        priority TEXT NOT NULL DEFAULT 'medium',
        labels TEXT NOT NULL DEFAULT '[]',
        assignee_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        reporter_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        parent_issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
        due_date TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, issue_key)
      );
      CREATE INDEX IF NOT EXISTS idx_issues_workspace_status
        ON issues(workspace_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(assignee_agent_id);

      -- Sequencer pro issue_key (por workspace)
      CREATE TABLE IF NOT EXISTS issue_counters (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        last_value INTEGER NOT NULL DEFAULT 0
      );

      -- Comments
      CREATE TABLE IF NOT EXISTS issue_comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        author_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        author_kind TEXT NOT NULL DEFAULT 'user',
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_issue_comments_issue
        ON issue_comments(issue_id, created_at ASC);
    `,
  },
  {
    version: 13,
    name: 'activity_log',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS activity_log (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        actor_kind TEXT NOT NULL DEFAULT 'user',
        actor_id TEXT,
        subject_kind TEXT,
        subject_id TEXT,
        title TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_workspace
        ON activity_log(workspace_id, created_at DESC);
    `,
  },
  {
    version: 14,
    name: 'routines_goals',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        prompt TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        enabled INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routines_workspace ON routines(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_routines_agent ON routines(agent_id);

      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        progress INTEGER NOT NULL DEFAULT 0,
        owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        due_date TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goals_workspace_status
        ON goals(workspace_id, status, updated_at DESC);
    `,
  },
  {
    version: 15,
    name: 'code_reviews',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS code_reviews (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        repo_full_name TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        pr_title TEXT NOT NULL,
        pr_author TEXT,
        head_ref TEXT,
        base_ref TEXT,
        head_sha TEXT,
        html_url TEXT NOT NULL,
        reviewer_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,

        -- 'queued' | 'analyzing' | 'completed' | 'failed' | 'cancelled'
        status TEXT NOT NULL DEFAULT 'queued',
        summary TEXT,
        risk_level TEXT,
        error_message TEXT,

        -- Contagens agregadas
        total_comments INTEGER NOT NULL DEFAULT 0,
        bug_count INTEGER NOT NULL DEFAULT 0,
        suggestion_count INTEGER NOT NULL DEFAULT 0,
        security_count INTEGER NOT NULL DEFAULT 0,
        style_count INTEGER NOT NULL DEFAULT 0,
        performance_count INTEGER NOT NULL DEFAULT 0,
        question_count INTEGER NOT NULL DEFAULT 0,

        -- Posting on GitHub
        posted_to_github_at TEXT,
        github_review_id TEXT,

        started_at TEXT NOT NULL,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, repo_full_name, pr_number, head_sha)
      );
      CREATE INDEX IF NOT EXISTS idx_code_reviews_workspace
        ON code_reviews(workspace_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_code_reviews_pr
        ON code_reviews(repo_full_name, pr_number);

      CREATE TABLE IF NOT EXISTS code_review_comments (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES code_reviews(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        line_start INTEGER,
        line_end INTEGER,
        -- 'bug' | 'suggestion' | 'security' | 'style' | 'performance' | 'question'
        kind TEXT NOT NULL DEFAULT 'suggestion',
        -- 'critical' | 'warning' | 'info'
        severity TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        suggestion TEXT,
        -- 'pending' | 'resolved' | 'ignored'
        resolution TEXT NOT NULL DEFAULT 'pending',
        github_comment_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_code_review_comments_review
        ON code_review_comments(review_id, kind, severity);
    `,
  },
  {
    version: 16,
    name: 'code_review_rich_fields',
    sql: /* sql */ `
      ALTER TABLE code_reviews ADD COLUMN rating REAL;
      ALTER TABLE code_reviews ADD COLUMN effort TEXT;
      ALTER TABLE code_reviews ADD COLUMN recommendation TEXT;
      ALTER TABLE code_reviews ADD COLUMN tests_assessment TEXT;
      ALTER TABLE code_reviews ADD COLUMN walkthrough_json TEXT;
      ALTER TABLE code_reviews ADD COLUMN files_changed_json TEXT;
      ALTER TABLE code_reviews ADD COLUMN highlights_json TEXT;
      ALTER TABLE code_reviews ADD COLUMN concerns_json TEXT;

      ALTER TABLE code_review_comments ADD COLUMN diff_hunk TEXT;
      ALTER TABLE code_review_comments ADD COLUMN code_context TEXT;
      ALTER TABLE code_review_comments ADD COLUMN title TEXT;
    `,
  },
  {
    version: 17,
    name: 'workspace_sources_and_linked_prs',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS workspace_sources (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        -- 'local_folder' | 'github_repo'
        kind TEXT NOT NULL,
        -- Caminho local (folder OU clone do repo)
        path TEXT,
        -- Pra github_repo: "owner/repo"
        repo_full_name TEXT,
        -- Label visível na UI ("Frontend", "Backend", "Mobile API")
        label TEXT NOT NULL,
        -- 'frontend' | 'backend' | 'mobile' | 'infra' | 'docs' | 'other'
        role TEXT,
        is_primary INTEGER NOT NULL DEFAULT 0,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_sources_ws
        ON workspace_sources(workspace_id, display_order);

      ALTER TABLE code_reviews ADD COLUMN linked_prs_json TEXT;
    `,
  },
  {
    version: 18,
    name: 'seed_workspace_sources_from_workspaces',
    sql: /* sql */ `
      -- Pra cada workspace existente, cria 1 row em workspace_sources
      -- baseada no path + gitRemote do workspace.
      INSERT INTO workspace_sources (
        id, workspace_id, kind, path, repo_full_name, label, role,
        is_primary, display_order, created_at, updated_at
      )
      SELECT
        lower(hex(randomblob(16))) AS id,
        w.id AS workspace_id,
        CASE
          WHEN w.git_remote IS NOT NULL AND w.git_remote != '' THEN 'github_repo'
          ELSE 'local_folder'
        END AS kind,
        w.path AS path,
        -- Extrai "owner/repo" do remote URL se existir
        CASE
          WHEN w.git_remote LIKE '%/%' THEN
            replace(
              replace(
                substr(w.git_remote, instr(w.git_remote, '://') + 3),
                'github.com/', ''
              ),
              '.git', ''
            )
          ELSE NULL
        END AS repo_full_name,
        coalesce(w.name, 'Source') AS label,
        NULL AS role,
        1 AS is_primary,
        0 AS display_order,
        datetime('now') AS created_at,
        datetime('now') AS updated_at
      FROM workspaces w
      WHERE NOT EXISTS (
        SELECT 1 FROM workspace_sources s WHERE s.workspace_id = w.id
      );
    `,
  },
  {
    version: 19,
    name: 'knowledge_base_pages_links_entities',
    sql: /* sql */ `
      -- Páginas hierárquicas (tree via parent_id).
      CREATE TABLE IF NOT EXISTS kb_pages (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES kb_pages(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'doc',
        content_json TEXT,
        content_md TEXT,
        icon TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        source_id TEXT REFERENCES workspace_sources(id) ON DELETE SET NULL,
        created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_pages_ws ON kb_pages(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_kb_pages_parent ON kb_pages(parent_id);
      CREATE INDEX IF NOT EXISTS idx_kb_pages_sort ON kb_pages(workspace_id, parent_id, sort_order);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_pages_slug ON kb_pages(workspace_id, slug);

      -- Wikilinks resolvidos.
      CREATE TABLE IF NOT EXISTS kb_links (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source_page_id TEXT NOT NULL REFERENCES kb_pages(id) ON DELETE CASCADE,
        target_kind TEXT NOT NULL,
        target_id TEXT,
        target_label TEXT,
        target_url TEXT,
        strength REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_links_source ON kb_links(source_page_id);
      CREATE INDEX IF NOT EXISTS idx_kb_links_target ON kb_links(target_kind, target_id);

      -- Entidades extraídas.
      CREATE TABLE IF NOT EXISTS kb_entities (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT,
        mention_count INTEGER NOT NULL DEFAULT 0,
        last_mentioned_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_entities_ws ON kb_entities(workspace_id, kind);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_entities_slug
        ON kb_entities(workspace_id, kind, slug);

      -- Relações tipadas entre entidades.
      CREATE TABLE IF NOT EXISTS kb_relations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source_entity_id TEXT NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
        target_entity_id TEXT NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_relations_src ON kb_relations(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_kb_relations_tgt ON kb_relations(target_entity_id);

      -- Chunks binários compactados (BKF — Binary Knowledge Format).
      CREATE TABLE IF NOT EXISTS kb_chunks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        page_id TEXT NOT NULL REFERENCES kb_pages(id) ON DELETE CASCADE,
        parent_chunk_id TEXT REFERENCES kb_chunks(id) ON DELETE SET NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        payload BLOB NOT NULL,
        size_uncompressed INTEGER NOT NULL,
        size_compressed INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        snapshot_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_page ON kb_chunks(page_id);
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_ws ON kb_chunks(workspace_id);

      -- Inverted index pra busca BM25 — tokens.
      CREATE TABLE IF NOT EXISTS kb_token_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        page_id TEXT NOT NULL REFERENCES kb_pages(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        tf INTEGER NOT NULL DEFAULT 1,
        field TEXT NOT NULL DEFAULT 'body'
      );
      CREATE INDEX IF NOT EXISTS idx_kb_token_lookup
        ON kb_token_index(workspace_id, token);
      CREATE INDEX IF NOT EXISTS idx_kb_token_page
        ON kb_token_index(page_id);
    `,
  },
  {
    version: 20,
    name: 'issue_metadata_and_execution_state',
    sql: /* sql */ `
      -- Metadata livre na issue: usado pra carregar contexto da execução
      -- (kind='kb-analysis', sourceId, autoExec, etc.).
      ALTER TABLE issues ADD COLUMN metadata_json TEXT;

      -- Estado de execução da issue por agente (single agent por enquanto):
      -- usado pra rastrear runs concorrentes e exibir progresso na UI.
      CREATE TABLE IF NOT EXISTS issue_runs (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_message TEXT,
        output_summary TEXT,
        exit_code INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_issue_runs_issue ON issue_runs(issue_id);
    `,
  },
  {
    version: 21,
    name: 'issue_run_cost_summary',
    sql: /* sql */ `
      -- Cost summary por run: tokens consumidos + custo estimado em USD.
      -- Permite mostrar "Cost Summary · 4 runs · 12.3k tokens · $0.18" igual Paperclip.
      ALTER TABLE issue_runs ADD COLUMN tokens_in INTEGER;
      ALTER TABLE issue_runs ADD COLUMN tokens_out INTEGER;
      ALTER TABLE issue_runs ADD COLUMN cost_usd REAL;
      ALTER TABLE issue_runs ADD COLUMN tool_call_count INTEGER;
    `,
  },
  {
    version: 22,
    name: 'agent_avatar_seed',
    sql: /* sql */ `
      -- Seed do avatar DiceBear (estilo bottts). Cada agente tem um robô
      -- procedural único — usuário escolhe na criação ou edição via popover.
      -- NULL = derivado do nome (fallback determinístico).
      ALTER TABLE agents ADD COLUMN avatar_seed TEXT;
    `,
  },
  {
    version: 23,
    name: 'issue_comment_attachments',
    sql: /* sql */ `
      -- Anexos de comentário: JSON array de { id, fileName, mimeType, sizeBytes, path }.
      ALTER TABLE issue_comments ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 24,
    name: 'task_executions',
    sql: /* sql */ `
      -- Histórico da camada de execução inteligente (economia de tokens).
      -- Sem FK rígida pra issues/runs: registra também execuções avulsas e
      -- sobrevive à remoção da issue (auditoria de economia).
      CREATE TABLE IF NOT EXISTS task_executions (
        id TEXT PRIMARY KEY,
        issue_id TEXT,
        run_id TEXT,
        workspace_id TEXT,
        execution_mode TEXT NOT NULL,
        model_used TEXT NOT NULL DEFAULT 'none',
        risk TEXT NOT NULL DEFAULT 'low',
        files_changed TEXT NOT NULL DEFAULT '[]',
        diff_summary TEXT NOT NULL DEFAULT '',
        validation_result TEXT NOT NULL DEFAULT 'skipped',
        fallback_used INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        metrics TEXT NOT NULL DEFAULT '{}',
        plan TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_executions_workspace
        ON task_executions(workspace_id, created_at);
    `,
  },
  {
    version: 25,
    name: 'issue_relations',
    sql: /* sql */ `
      -- Relações de issue (Paperclip): dependências, reviewers/approvers, monitor.
      ALTER TABLE issues ADD COLUMN monitor_schedule TEXT;

      CREATE TABLE IF NOT EXISTS issue_dependencies (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        blocker_issue_id TEXT NOT NULL,
        blocked_issue_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS issue_dep_pair_idx
        ON issue_dependencies(blocker_issue_id, blocked_issue_id);
      CREATE INDEX IF NOT EXISTS issue_dep_blocked_idx
        ON issue_dependencies(blocked_issue_id);
      CREATE INDEX IF NOT EXISTS issue_dep_blocker_idx
        ON issue_dependencies(blocker_issue_id);

      CREATE TABLE IF NOT EXISTS issue_reviewers (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'reviewer',
        decision TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS issue_reviewer_issue_idx
        ON issue_reviewers(issue_id);
      CREATE UNIQUE INDEX IF NOT EXISTS issue_reviewer_unique_idx
        ON issue_reviewers(issue_id, agent_id, role);
    `,
  },
  {
    version: 26,
    name: 'perf_hot_query_indexes',
    sql: /* sql */ `
      -- Índices em colunas FK/filtro quentes. IF NOT EXISTS torna idempotente —
      -- alguns já existem via índices compostos (cobertos pelo prefixo à esquerda),
      -- mas garantimos os que faltavam para acelerar joins e lookups.

      -- messages(session_id): já há um composto (session_id, created_at);
      -- mantido por garantia em bancos antigos.
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

      -- issues: workspace_id (filtro principal) e parent_issue_id (sub-issues).
      CREATE INDEX IF NOT EXISTS idx_issues_workspace ON issues(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_issue_id);

      -- issue_runs(issue_id): lookups de runs por issue.
      CREATE INDEX IF NOT EXISTS idx_issue_runs_issue_id ON issue_runs(issue_id);

      -- chat_sessions(workspace_id): listagem de sessões por workspace.
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace
        ON chat_sessions(workspace_id);

      -- kb_pages(workspace_id): árvore/listagem da base de conhecimento.
      CREATE INDEX IF NOT EXISTS idx_kb_pages_workspace ON kb_pages(workspace_id);

      -- workspace_sources(workspace_id): badges/listagem de sources.
      CREATE INDEX IF NOT EXISTS idx_workspace_sources_workspace
        ON workspace_sources(workspace_id);

      -- code_reviews(workspace_id): listagem de reviews por workspace.
      CREATE INDEX IF NOT EXISTS idx_code_reviews_workspace_id
        ON code_reviews(workspace_id);

      -- activity_log(workspace_id): feed de atividades.
      CREATE INDEX IF NOT EXISTS idx_activity_log_workspace
        ON activity_log(workspace_id);
    `,
  },
  {
    version: 27,
    name: 'issue_run_orchestration_economics',
    sql: /* sql */ `
      -- Economia de execução (HONESTO, sem fakery): registra qual camada
      -- resolveu cada issue run.
      --   adapter_type = 'orkestral_local' quando o executor foi o Forge local.
      --   exit_reason  = 'local_resolved'        → Forge resolveu sem premium.
      --   exit_reason  = 'escalated_to_premium'  → caiu no fallback premium.
      -- Colunas nulas em runs antigos (pré-feature) — contagens só refletem
      -- execuções reais registradas a partir daqui.
      ALTER TABLE issue_runs ADD COLUMN adapter_type TEXT;
      ALTER TABLE issue_runs ADD COLUMN exit_reason TEXT;

      -- Lookup rápido pras agregações do painel de economia.
      CREATE INDEX IF NOT EXISTS idx_issue_runs_adapter
        ON issue_runs(adapter_type);
      CREATE INDEX IF NOT EXISTS idx_issue_runs_exit_reason
        ON issue_runs(exit_reason);
    `,
  },
  {
    version: 28,
    name: 'goal_linking',
    sql: /* sql */ `
      -- Liga issue → objetivo (null = sem objetivo). Progresso do goal é derivado.
      ALTER TABLE issues ADD COLUMN goal_id TEXT;
      -- Hierarquia objetivo → sub-objetivos.
      ALTER TABLE goals ADD COLUMN parent_goal_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_issues_goal ON issues(goal_id);
      CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_goal_id);
    `,
  },
  {
    // Vinha do main como v28; renumerada pra v29 no merge (v28 = goal_linking).
    version: 29,
    name: 'issue_human_numbering',
    sql: /* sql */ `
      -- Numeração HUMANA (display) desacoplada do issue_key interno.
      --   display_key   → top-level: sequencial entre as raízes do workspace
      --                   (PREFIX-{display_key}). NULL em sub-issues.
      --   child_ordinal → sub-issue: posição (1-based) entre os irmãos do mesmo
      --                   pai. Exibido como {display do pai}.{child_ordinal}.
      --                   NULL em top-level.
      -- Ordinais PERSISTIDOS e estáveis (estilo Linear): apagar deixa buraco,
      -- não renumera. Sub-issue NÃO consome o contador de display_key → as
      -- raízes ficam contíguas. issue_key interno permanece intacto.
      ALTER TABLE issues ADD COLUMN display_key INTEGER;
      ALTER TABLE issues ADD COLUMN child_ordinal INTEGER;

      -- Backfill top-level: display_key = rank por created_at (desempate por id)
      -- entre as issues SEM pai do mesmo workspace. 1-based.
      UPDATE issues SET display_key = (
        SELECT COUNT(*) FROM issues b
        WHERE b.workspace_id = issues.workspace_id
          AND b.parent_issue_id IS NULL
          AND (b.created_at < issues.created_at
               OR (b.created_at = issues.created_at AND b.id <= issues.id))
      ) WHERE parent_issue_id IS NULL;

      -- Backfill sub-issues: child_ordinal = rank por created_at entre irmãos
      -- (mesmo parent_issue_id). 1-based.
      UPDATE issues SET child_ordinal = (
        SELECT COUNT(*) FROM issues b
        WHERE b.parent_issue_id = issues.parent_issue_id
          AND (b.created_at < issues.created_at
               OR (b.created_at = issues.created_at AND b.id <= issues.id))
      ) WHERE parent_issue_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_issues_display_key
        ON issues(workspace_id, display_key);
    `,
  },
  {
    version: 30,
    name: 'goal_plan_verify_sessions',
    sql: /* sql */ `
      -- Liga objetivo ↔ chat por id (dedup por goal.id, não por título).
      ALTER TABLE goals ADD COLUMN plan_session_id TEXT;
      ALTER TABLE goals ADD COLUMN verify_session_id TEXT;
    `,
  },
  {
    version: 31,
    name: 'chat_sessions_is_archived',
    sql: /* sql */ `
      -- Arquivar conversa: fica fora da lista de Recentes (delete continua via
      -- session:delete). Default 0 = ativa.
      ALTER TABLE chat_sessions ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 32,
    name: 'trace_logs',
    sql: /* sql */ `
      -- Trace de execução PERSISTIDO (página Logs). Antes era só ring buffer em
      -- memória → sumia no restart. Expurgado pra manter no máx. 500 linhas.
      CREATE TABLE IF NOT EXISTS trace_logs (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        scope TEXT,
        workspace_id TEXT,
        agent_id TEXT,
        agent_name TEXT,
        issue_key TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_trace_logs_ts ON trace_logs(ts);
    `,
  },
  {
    version: 33,
    name: 'goals_catchup',
    sql: /* sql */ `
      -- CATCH-UP idempotente do schema de Goals (merge): num banco que já passou
      -- da versão das migrations originais de goals, elas foram PULADAS e faltam
      -- colunas (ex.: issues.goal_id → "no such column"). O runner ignora
      -- "duplicate column"/"already exists", então isto converge qualquer banco.
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        progress INTEGER NOT NULL DEFAULT 0,
        owner_agent_id TEXT,
        parent_goal_id TEXT,
        plan_session_id TEXT,
        verify_session_id TEXT,
        due_date TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE issues ADD COLUMN goal_id TEXT;
      ALTER TABLE goals ADD COLUMN parent_goal_id TEXT;
      ALTER TABLE goals ADD COLUMN plan_session_id TEXT;
      ALTER TABLE goals ADD COLUMN verify_session_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_issues_goal ON issues(goal_id);
      CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_goal_id);
    `,
  },
  {
    version: 34,
    name: 'skill_provenance_lifecycle',
    sql: /* sql */ `
      -- Procedência + telemetria + ciclo de vida das skills (auto-curadoria estilo
      -- Hermes): skills criadas pelo agente vs pelo usuário, contagem de uso, e
      -- estado active/archived. ADD COLUMN é idempotente via runner.
      ALTER TABLE skills ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE skills ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE skills ADD COLUMN last_used_at TEXT;
      ALTER TABLE skills ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
    `,
  },
  {
    version: 35,
    name: 'messages_fts',
    sql: /* sql */ `
      -- Busca full-text nas conversas passadas (estilo Hermes session_search/FTS5).
      -- Standalone (não external-content): preenchida/atualizada pelo session-search.ts
      -- em JS (o texto fica em messages.parts JSON, fora do alcance de triggers SQL).
      -- Colunas UNINDEXED são filtráveis por WHERE mas não entram no MATCH.
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_id UNINDEXED,
        session_id UNINDEXED,
        workspace_id UNINDEXED,
        role UNINDEXED,
        created_at UNINDEXED,
        title UNINDEXED,
        text
      );
    `,
  },
  {
    version: 36,
    name: 'workspace_user_profile',
    sql: /* sql */ `
      -- Perfil persistente do usuário por workspace (estilo USER.md do Hermes):
      -- nome, papel, preferências, estilo de comunicação. Injetado no prompt do
      -- chat e atualizado pelos agentes via MCP. ADD COLUMN idempotente via runner.
      ALTER TABLE workspaces ADD COLUMN user_profile TEXT;
    `,
  },
  {
    version: 37,
    name: 'agent_trace_events',
    sql: /* sql */ `
      -- Timeline estruturada local do agente. Diferente de trace_logs, que e um
      -- terminal curto expurgado, esta tabela guarda passos explicaveis para UX,
      -- auditoria, avaliacao e futura construcao de datasets de fine-tuning.
      CREATE TABLE IF NOT EXISTS agent_trace_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT,
        issue_id TEXT,
        issue_key TEXT,
        agent_id TEXT,
        agent_name TEXT,
        parent_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        payload_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_trace_events_workspace_started
        ON agent_trace_events(workspace_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_agent_trace_events_issue
        ON agent_trace_events(issue_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_agent_trace_events_run
        ON agent_trace_events(run_id, started_at);
    `,
  },
  {
    version: 38,
    name: 'local_embeddings_usage_cleanup',
    sql: /* sql */ `
      -- Modelo local obrigatorio de embeddings. Separado do Forge executor:
      -- o GGUF de chat/instruct nao deve ser reaproveitado como embedder.
      CREATE TABLE IF NOT EXISTS embedding_models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'local-gguf',
        family TEXT NOT NULL DEFAULT 'orkestral-embedding',
        model_path TEXT NOT NULL,
        model_hash TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        context_tokens INTEGER NOT NULL DEFAULT 512,
        is_required INTEGER NOT NULL DEFAULT 1,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_embedding_models_active
        ON embedding_models(is_active, model_hash);

      -- Unidade semantica embeddavel. Hoje indexamos paginas; a tabela ja
      -- suporta chunks para evoluir para RAG granular sem trocar contrato.
      CREATE TABLE IF NOT EXISTS kb_embedding_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        page_id TEXT REFERENCES kb_pages(id) ON DELETE CASCADE,
        chunk_id TEXT REFERENCES kb_chunks(id) ON DELETE CASCADE,
        item_kind TEXT NOT NULL DEFAULT 'page',
        source_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        text_preview TEXT,
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_embedding_items_workspace
        ON kb_embedding_items(workspace_id, item_kind);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_embedding_items_page
        ON kb_embedding_items(workspace_id, page_id, item_kind);

      -- Vetor em BLOB Float32LE. Mantemos SQLite puro para empacotamento local
      -- estavel; a busca usa cosine em JS e pode migrar para sqlite-vec depois.
      CREATE TABLE IF NOT EXISTS kb_embeddings (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES kb_embedding_items(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL REFERENCES embedding_models(id) ON DELETE CASCADE,
        dimension INTEGER NOT NULL,
        vector BLOB NOT NULL,
        norm REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_embeddings_workspace_model
        ON kb_embeddings(workspace_id, model_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_embeddings_item_model
        ON kb_embeddings(item_id, model_id);

      -- Telemetria local de uso da base. Alimenta expurgo assistido: o app
      -- sugere limpeza, o usuario aprova, nada e apagado sozinho.
      CREATE TABLE IF NOT EXISTS knowledge_usage_stats (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        source_id TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        hit_count INTEGER NOT NULL DEFAULT 0,
        first_used_at TEXT,
        last_used_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_knowledge_usage_target
        ON knowledge_usage_stats(workspace_id, target_kind, target_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_usage_last_used
        ON knowledge_usage_stats(workspace_id, last_used_at);

      CREATE TABLE IF NOT EXISTS cleanup_suggestions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT,
        estimated_bytes INTEGER NOT NULL DEFAULT 0,
        item_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        applied_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cleanup_suggestions_workspace_status
        ON cleanup_suggestions(workspace_id, status, created_at);
    `,
  },
  {
    version: 39,
    name: 'kb_embedding_jobs',
    sql: /* sql */ `
      -- Fila persistente de indexacao semantica. Permite retomar jobs apos
      -- restart do app e mostrar progresso real para o usuario.
      CREATE TABLE IF NOT EXISTS kb_embedding_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        page_ids_json TEXT NOT NULL DEFAULT '[]',
        current INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_embedding_jobs_workspace_created
        ON kb_embedding_jobs(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_kb_embedding_jobs_status
        ON kb_embedding_jobs(status, created_at);
    `,
  },
  {
    version: 40,
    name: 'forge_learning_eval_multiagent',
    sql: /* sql */ `
      -- Dataset local para aprendizado supervisionado futuro. Isto NAO treina
      -- pesos ainda; coleta exemplos curados para RAG feedback, LoRA/QLoRA ou
      -- avaliacao offline sem misturar memoria com fine-tuning real.
      CREATE TABLE IF NOT EXISTS ai_training_examples (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL,
        source_id TEXT,
        task_type TEXT NOT NULL DEFAULT 'reasoning',
        input_text TEXT NOT NULL,
        expected_output TEXT,
        actual_output TEXT,
        label TEXT NOT NULL DEFAULT 'neutral',
        metadata_json TEXT,
        status TEXT NOT NULL DEFAULT 'candidate',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_training_examples_workspace_status
        ON ai_training_examples(workspace_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_ai_training_examples_source
        ON ai_training_examples(source_kind, source_id);

      -- Avaliacao local de RAG: cada consulta guarda esperado, recuperado e
      -- metricas para medir precisao antes/depois de mudar chunking/reranking.
      CREATE TABLE IF NOT EXISTS rag_evaluation_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        query TEXT NOT NULL,
        expected_page_ids_json TEXT NOT NULL DEFAULT '[]',
        result_page_ids_json TEXT NOT NULL DEFAULT '[]',
        metrics_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'needs_review',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rag_evaluation_runs_workspace_created
        ON rag_evaluation_runs(workspace_id, created_at);

      -- Coordenacao multiagente local. Comeca como plano/rastreamento de papeis
      -- (researcher, memory, executor, reviewer, safety), sem spawn paralelo
      -- perigoso, e alimenta timeline/qualidade.
      CREATE TABLE IF NOT EXISTS multi_agent_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE,
        run_id TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        plan_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_multi_agent_runs_workspace_created
        ON multi_agent_runs(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_multi_agent_runs_issue
        ON multi_agent_runs(issue_id, created_at);

      CREATE TABLE IF NOT EXISTS multi_agent_steps (
        id TEXT PRIMARY KEY,
        multi_agent_run_id TEXT NOT NULL REFERENCES multi_agent_runs(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        input_text TEXT,
        output_text TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_multi_agent_steps_run_role
        ON multi_agent_steps(multi_agent_run_id, role);
    `,
  },
  {
    version: 41,
    name: 'azure_devops_account',
    sql: /* sql */ `
      -- Conta Azure DevOps conectada via Microsoft Entra OAuth/device code.
      -- Tokens ficam criptografados pelo safeStorage do Electron.
      CREATE TABLE IF NOT EXISTS azure_devops_accounts (
        id TEXT PRIMARY KEY DEFAULT 'singleton',
        display_name TEXT,
        email TEXT,
        tenant_id TEXT,
        access_token_encrypted BLOB NOT NULL,
        refresh_token_encrypted BLOB,
        scope TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL,
        organizations TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 42,
    name: 'kb_embedding_chunk_unique_index',
    sql: /* sql */ `
      -- v38 criou uniq_kb_embedding_items_page em (workspace_id,page_id,item_kind),
      -- o que impedia mais de um chunk por pagina. A busca semantica indexa
      -- pagina + varios chunks, entao separamos unicidade de page e chunk.
      DROP INDEX IF EXISTS uniq_kb_embedding_items_page;

      DELETE FROM kb_embedding_items
      WHERE page_id IS NOT NULL
        AND item_kind = 'page'
        AND rowid NOT IN (
          SELECT max(rowid)
          FROM kb_embedding_items
          WHERE page_id IS NOT NULL
            AND item_kind = 'page'
          GROUP BY workspace_id, page_id, item_kind
        );

      DELETE FROM kb_embedding_items
      WHERE page_id IS NOT NULL
        AND item_kind = 'chunk'
        AND rowid NOT IN (
          SELECT max(rowid)
          FROM kb_embedding_items
          WHERE page_id IS NOT NULL
            AND item_kind = 'chunk'
          GROUP BY workspace_id, page_id, item_kind, source_hash
        );

      CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_embedding_items_page
        ON kb_embedding_items(workspace_id, page_id, item_kind)
        WHERE item_kind = 'page';

      CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_embedding_items_chunk_hash
        ON kb_embedding_items(workspace_id, page_id, item_kind, source_hash)
        WHERE item_kind = 'chunk';
    `,
  },
  {
    version: 43,
    name: 'kb_analysis_jobs',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS kb_analysis_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source_id TEXT,
        source_label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        phase TEXT,
        message TEXT,
        files_scanned INTEGER NOT NULL DEFAULT 0,
        pages_created INTEGER NOT NULL DEFAULT 0,
        entities_created INTEGER NOT NULL DEFAULT 0,
        relations_created INTEGER NOT NULL DEFAULT 0,
        coverage_pages INTEGER NOT NULL DEFAULT 0,
        embedding_job_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kb_analysis_jobs_workspace_created
        ON kb_analysis_jobs(workspace_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_kb_analysis_jobs_source_status
        ON kb_analysis_jobs(source_id, status);
    `,
  },
  {
    version: 44,
    name: 'kb_embedding_jobs_source_metadata',
    sql: /* sql */ `
      ALTER TABLE kb_embedding_jobs ADD COLUMN source_id TEXT;
      ALTER TABLE kb_embedding_jobs ADD COLUMN source_label TEXT;

      CREATE INDEX IF NOT EXISTS idx_kb_embedding_jobs_source_status
        ON kb_embedding_jobs(source_id, status);
    `,
  },
  {
    version: 45,
    name: 'kb_pages_runtime_counters',
    sql: /* sql */ `
      -- Bancos que já tinham kb_pages antes do HUD/usage tracking precisam
      -- destes campos para tree/graph/search/cleanup não quebrarem no boot.
      ALTER TABLE kb_pages ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE kb_pages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 46,
    name: 'session_context_snapshots',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS session_context_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        char_count INTEGER NOT NULL DEFAULT 0,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        last_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_context_snapshots_session
        ON session_context_snapshots(session_id);

      CREATE INDEX IF NOT EXISTS idx_session_context_snapshots_workspace
        ON session_context_snapshots(workspace_id, updated_at);
    `,
  },
  {
    version: 47,
    name: 'sentry_accounts',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS sentry_accounts (
        id TEXT PRIMARY KEY,
        org_slug TEXT NOT NULL,
        project_slug TEXT,
        display_name TEXT,
        token_encrypted BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sentry_accounts_org
        ON sentry_accounts(org_slug);
    `,
  },
  {
    version: 48,
    name: 'sentry_automations',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS sentry_automations (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        min_level TEXT NOT NULL DEFAULT 'error',
        project_slug TEXT,
        agent_id TEXT,
        mode TEXT NOT NULL DEFAULT 'propose',
        refresh_interval_min INTEGER NOT NULL DEFAULT 5,
        seen_issue_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 49,
    name: 'sentry_rules',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS sentry_rules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        min_level TEXT NOT NULL DEFAULT 'error',
        project_slug TEXT,
        agent_id TEXT,
        mode TEXT NOT NULL DEFAULT 'propose',
        seen_issue_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sentry_rules_ws ON sentry_rules(workspace_id);

      CREATE TABLE IF NOT EXISTS sentry_rule_runs (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES sentry_rules(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        short_id TEXT,
        title TEXT,
        level TEXT,
        project TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sentry_rule_runs_ws
        ON sentry_rule_runs(workspace_id, created_at);
    `,
  },
  {
    version: 50,
    name: 'sentry_accounts_workspace_scope',
    sql: /* sql */ `
      ALTER TABLE sentry_accounts ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

      DROP INDEX IF EXISTS idx_sentry_accounts_org;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sentry_accounts_workspace
        ON sentry_accounts(workspace_id);

      CREATE INDEX IF NOT EXISTS idx_sentry_accounts_org
        ON sentry_accounts(org_slug);
    `,
  },
  {
    version: 51,
    name: 'observability_accounts',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS observability_accounts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        display_name TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        token_encrypted BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_observability_accounts_provider_ws
        ON observability_accounts(workspace_id, provider);
    `,
  },
  {
    version: 52,
    name: 'observability_rules',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS observability_rules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL DEFAULT 'all',
        severity TEXT,
        service_query TEXT,
        agent_id TEXT,
        mode TEXT NOT NULL DEFAULT 'propose',
        refresh_interval_min INTEGER NOT NULL DEFAULT 5,
        seen_signal_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_observability_rules_ws_provider
        ON observability_rules(workspace_id, provider);

      CREATE TABLE IF NOT EXISTS observability_rule_runs (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES observability_rules(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        title TEXT,
        kind TEXT,
        service TEXT,
        severity TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_observability_rule_runs_ws_provider
        ON observability_rule_runs(workspace_id, provider, created_at);
    `,
  },
  {
    // v54 (não v53): bancos que rodaram a branch de onboarding já estão em
    // user_version=53 (workspace_source_github_account) e pulariam uma v53 nova,
    // deixando a tabela sem criar. v54+ garante a aplicação em qualquer banco.
    version: 54,
    name: 'local_phase_runs',
    sql: /* sql */ `
      -- Economia REAL das fases analíticas (sumarização/classificação) que o
      -- Forge local executou em vez do premium. Uma linha por execução local.
      -- tokens_in/out são estimativas (chars/4) do que o premium teria gasto.
      CREATE TABLE IF NOT EXISTS local_phase_runs (
        id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_local_phase_runs_phase
        ON local_phase_runs(phase, created_at);
    `,
  },
  {
    version: 55,
    name: 'chat_queue',
    sql: /* sql */ `
      -- Fila de mensagens persistida no MAIN: mensagens enviadas durante um run
      -- ativo ficam aqui e são despachadas ao terminar o run (sobrevive a reload).
      CREATE TABLE IF NOT EXISTS chat_queue (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        attachments TEXT,
        kind TEXT NOT NULL DEFAULT 'queue',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_queue_session_status
        ON chat_queue(session_id, status, created_at);
    `,
  },
  {
    version: 56,
    name: 'tool_secrets',
    sql: /* sql */ `
      -- Secret store genérico das Ferramentas (key-value cifrado via safeStorage).
      -- Ex.: API key do Fast Apply (Morph). NUNCA vai pro renderer em claro.
      CREATE TABLE IF NOT EXISTS tool_secrets (
        key TEXT PRIMARY KEY,
        value_encrypted BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 57,
    name: 'issue_runs_verified',
    sql: /* sql */ `
      -- Provenance HONESTA do desfecho de um run local: separa "não escalou pro
      -- premium" de "foi de fato VERIFICADO". Preenchido pelo issue-execution-service
      -- no ponto de done VERIFICADO (passou no gate de aprovação) / reprovação.
      --   verified = 1    → run atingiu 'done' verificado (gate aprovou).
      --   verified = 0    → trabalho local produzido mas reprovado/sem verificação.
      --   verified = NULL → sem veredito (run antigo, em andamento ou aguardando).
      -- NULL deliberado, sem default e sem backfill: runs históricos não têm
      -- veredito honesto e ficam fora da taxa de correção.
      ALTER TABLE issue_runs ADD COLUMN verified INTEGER;
    `,
  },
  {
    version: 58,
    name: 'kb_token_index_content_hash',
    sql: /* sql */ `
      -- Hash do conteúdo (title+body) por trás das linhas de índice BM25 de uma
      -- página. Permite pular o delete+reinsert quando o conteúdo não mudou
      -- (reindex idempotente em batch) — evita rebuild caro do índice no WAL
      -- compartilhado. NULL/'' em linhas antigas → tratadas como "mudou" e
      -- reindexadas na próxima escrita.
      ALTER TABLE kb_token_index ADD COLUMN content_hash TEXT;
    `,
  },
  {
    version: 59,
    name: 'issue_runs_economics_index',
    sql: /* sql */ `
      -- getEconomics() varre issue_runs por (exit_reason, verified) pra computar
      -- localExecutions/assisted/escalations + buckets verified/rejected. Índice
      -- composto cobre esses filtros (count(*) vira index-only scan) e mantém o
      -- dashboard de economia barato conforme o histórico de runs cresce.
      CREATE INDEX IF NOT EXISTS idx_issue_runs_exit_verified
        ON issue_runs(exit_reason, verified);
    `,
  },
  {
    version: 60,
    name: 'kb_code_index',
    sql: /* sql */ `
      -- Índice de CÓDIGO-FONTE real (≠ páginas de KB escritas pela IA). Cada linha
      -- é um chunk de um arquivo de source, com provenance file:line, pra que o
      -- kb_search devolva trechos do CÓDIGO de verdade (não só "o que a KB diz
      -- sobre o código"). Distinto das kb_pages: não polui a árvore/grafo da KB.
      --   start_line/end_line → provenance 1-based exibida ao agente.
      --   content_hash        → skip incremental (não re-tokeniza chunk inalterado).
      --   symbol              → nome do símbolo top-level do chunk (quando detectado).
      CREATE TABLE IF NOT EXISTS kb_code_chunks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        lang TEXT,
        symbol TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kb_code_chunks_ws_source
        ON kb_code_chunks(workspace_id, source_id);
      CREATE INDEX IF NOT EXISTS idx_kb_code_chunks_file
        ON kb_code_chunks(workspace_id, source_id, file_path);

      -- Espelho BM25 dos chunks de código (mesma mecânica do kb_token_index das
      -- páginas, em tabela separada pra não misturar os corpora). field=symbol|body.
      CREATE TABLE IF NOT EXISTS kb_code_token_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES kb_code_chunks(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        tf INTEGER NOT NULL DEFAULT 1,
        field TEXT NOT NULL DEFAULT 'body'
      );

      CREATE INDEX IF NOT EXISTS idx_kb_code_token_ws_token
        ON kb_code_token_index(workspace_id, token);
      CREATE INDEX IF NOT EXISTS idx_kb_code_token_chunk
        ON kb_code_token_index(chunk_id);
    `,
  },
  {
    version: 61,
    name: 'issue_execution_events',
    sql: /* sql */ `
      -- Replay persistente do stream fino de execucao de issue. A UI usa isto
      -- para reconstruir "Working...", ferramentas, Forge/CLI e arquivos editados
      -- depois de reload/restart, sem depender apenas de eventos em memoria.
      CREATE TABLE IF NOT EXISTS issue_execution_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        run_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_issue_execution_events_issue_created
        ON issue_execution_events(issue_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_issue_execution_events_workspace_created
        ON issue_execution_events(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_issue_execution_events_run_created
        ON issue_execution_events(run_id, created_at);
    `,
  },
  {
    version: 62,
    name: 'workspace_source_freshness',
    sql: /* sql */ `
      -- Controle de frescor por source. Antes de executar uma issue, o
      -- orquestrador compara esse fingerprint com o estado real do repo/pasta.
      -- Se mudou, sincroniza/reanalisa KB antes do agente trabalhar.
      ALTER TABLE workspace_sources ADD COLUMN last_indexed_fingerprint TEXT;
      ALTER TABLE workspace_sources ADD COLUMN last_synced_fingerprint TEXT;
      ALTER TABLE workspace_sources ADD COLUMN freshness_status TEXT;
      ALTER TABLE workspace_sources ADD COLUMN last_sync_at TEXT;
      ALTER TABLE workspace_sources ADD COLUMN sync_details_json TEXT;

      CREATE INDEX IF NOT EXISTS idx_workspace_sources_freshness
        ON workspace_sources(workspace_id, freshness_status, updated_at);
    `,
  },
  {
    version: 63,
    name: 'economy_default_no_premium_escalation',
    sql: /* sql */ `
      -- ECONOMIA É O PILAR: o Forge resolve tudo localmente e NUNCA escala pro
      -- premium por padrao. Instalacoes antigas tinham allowPremiumFallback=true
      -- (default antigo) persistido — reseta pro novo default (false). Quem quiser
      -- premium religa explicitamente nas Configuracoes (opt-in).
      UPDATE settings
      SET value = json_set(value, '$.aiRouting.allowPremiumFallback', json('false'))
      WHERE key = 'app'
        AND json_extract(value, '$.aiRouting') IS NOT NULL;
    `,
  },
  {
    version: 64,
    name: 'local_first_routing_default',
    sql: /* sql */ `
      -- LOCAL-FIRST out-of-the-box: o roteamento inteligente tem que vir LIGADO e
      -- funcionando (o usuario nao deve configurar nada pro Forge assumir). Alinha
      -- installs existentes ao novo default: roteamento ligado, risco maximo ALTO
      -- (o Forge executa tudo; validacao fica no review), e premium OFF (economia —
      -- conserta tambem o allowPremiumFallback=true que reapareceu em alguns DBs).
      UPDATE settings
      SET value = json_set(
        value,
        '$.aiRouting.enabled', json('true'),
        '$.aiRouting.maxLocalRisk', 'high',
        '$.aiRouting.allowPremiumFallback', json('false')
      )
      WHERE key = 'app'
        AND json_extract(value, '$.aiRouting') IS NOT NULL;

      -- So tira do modo 'observe' (passivo) pra 'local_first'; preserva quem ja
      -- escolheu um modo ativo (local_assist/local_first).
      UPDATE settings
      SET value = json_set(value, '$.aiRouting.mode', 'local_first')
      WHERE key = 'app'
        AND json_extract(value, '$.aiRouting.mode') = 'observe';
    `,
  },
  {
    version: 65,
    name: 'issue_runs_counterfactual_tokens',
    sql: /* sql */ `
      -- ECONOMIA VISIVEL: quando o Forge resolve local, o premium NAO roda, entao
      -- nao ha custo medido (cost_usd fica null). Estas colunas guardam os tokens
      -- que o premium TERIA processado (entrada+saida estimadas) pelo mesmo
      -- trabalho — base do "counterfactual" mostrado ao usuario (tokens evitados x
      -- preco de referencia). Distintas de tokens_in/tokens_out (uso REAL premium).
      ALTER TABLE issue_runs ADD COLUMN cf_in_tokens INTEGER;
      ALTER TABLE issue_runs ADD COLUMN cf_out_tokens INTEGER;
    `,
  },
  {
    version: 66,
    name: 'forge_edit_examples',
    sql: /* sql */ `
      -- RAG-DE-EDITS: o Forge aprende COM os edits que o usuario JA aceitou neste
      -- repo (few-shot do estilo real do usuario, sem treinar/enviar nada pra fora).
      -- O CODIGO FICA LOCAL — esta tabela vive no SQLite do app, nunca vai pra Cloud.
      -- status: 'candidate' (aplicado pelo Forge, aguardando review) -> 'accepted'
      -- (review aprovou: vira exemplo de verdade) | 'rejected' (descartado).
      CREATE TABLE IF NOT EXISTS forge_edit_examples (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT,
        issue_id TEXT,
        file TEXT NOT NULL,
        symbol TEXT,
        instruction TEXT NOT NULL,
        anchor_excerpt TEXT,
        accepted_edit TEXT NOT NULL,
        edit_format TEXT NOT NULL DEFAULT 'lazy',
        status TEXT NOT NULL DEFAULT 'candidate',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_forge_examples_ws_status
        ON forge_edit_examples(workspace_id, status);
      CREATE INDEX IF NOT EXISTS idx_forge_examples_run
        ON forge_edit_examples(run_id);
    `,
  },
  {
    version: 67,
    name: 'qa_validations_tables',
    sql: /* sql */ `
      -- QA VALIDATIONS: as tabelas qa_validations/qa_validation_checks existiam no
      -- schema.ts (e o QaValidationRepository as consultava), mas a migration de
      -- CRIACAO nunca foi adicionada — todo DB batia em "no such table:
      -- qa_validations" no handler qa:get-latest-validation. Cria as duas
      -- (idempotente, FK + indices) casando EXATAMENTE o schema.ts.
      CREATE TABLE IF NOT EXISTS qa_validations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        executor_agent_id TEXT,
        qa_agent_id TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        summary TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_qa_validations_issue_created
        ON qa_validations(issue_id, created_at);

      CREATE TABLE IF NOT EXISTS qa_validation_checks (
        id TEXT PRIMARY KEY,
        validation_id TEXT NOT NULL REFERENCES qa_validations(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        command_hint TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        evidence TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_qa_validation_checks_validation_ordinal
        ON qa_validation_checks(validation_id, ordinal);
    `,
  },
  {
    version: 68,
    name: 'premium_fallback_on_by_default',
    sql: /* sql */ `
      -- MUDANCA DE POLITICA: o fallback premium passa a vir LIGADO por padrao. O
      -- Forge tenta resolver localmente primeiro (economia), mas o premium e a rede
      -- que garante que o trabalho TERMINA — em vez de bloquear a issue. Alinha os
      -- installs existentes (que as migrations 63/64 tinham forcado pra false) ao
      -- novo default e backfilla o nº de tentativas locais antes do fallback.
      UPDATE settings
      SET value = json_set(
        value,
        '$.aiRouting.allowPremiumFallback', json('true'),
        '$.aiRouting.localAttemptsBeforeFallback',
          COALESCE(json_extract(value, '$.aiRouting.localAttemptsBeforeFallback'), 2)
      )
      WHERE key = 'app'
        AND json_extract(value, '$.aiRouting') IS NOT NULL;
    `,
  },
  {
    version: 69,
    name: 'chat_queue_scope',
    sql: /* sql */ `
      -- A fila de chat persistida agora carrega o ESCOPO de sources do turno
      -- ('all' | [sourceIds], serializado em JSON). Sem ele, um item enfileirado
      -- num source específico era despachado em 'all' ao sair da fila. Coluna
      -- nullable; null = 'all' (retrocompatível com filas já gravadas).
      ALTER TABLE chat_queue ADD COLUMN scope TEXT;
    `,
  },
  {
    version: 70,
    name: 'channels_whatsapp',
    sql: /* sql */ `
      -- Canais de mensageria (WhatsApp primeiro). channel_accounts = conta conectada
      -- + roteamento (workspace/agente que responde) + status observável. As creds do
      -- Baileys NÃO ficam no DB — vivem em arquivos no userData (authDir). channel_sessions
      -- mapeia cada interlocutor (JID) à sessão de chat que mantém a conversa.
      CREATE TABLE IF NOT EXISTS channel_accounts (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'disconnected',
        self_id TEXT,
        last_connected_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_channel_accounts_type ON channel_accounts(channel_type);

      CREATE TABLE IF NOT EXISTS channel_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
        channel_user_id TEXT NOT NULL,
        display_name TEXT,
        chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        last_message_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_sessions_user
        ON channel_sessions(account_id, channel_user_id);
    `,
  },
  {
    version: 71,
    name: 'channel_accounts_allowlist',
    sql: /* sql */ `
      -- Allowlist (guard) por conta: só os números nesta lista são respondidos.
      -- Array JSON de dígitos normalizados; default '[]' (ninguém liberado ainda).
      ALTER TABLE channel_accounts ADD COLUMN allowlist TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 72,
    name: 'channel_sessions_provenance',
    sql: /* sql */ `
      -- Proveniência do interlocutor pra mostrar na UI (número real + foto de perfil).
      ALTER TABLE channel_sessions ADD COLUMN phone TEXT;
      ALTER TABLE channel_sessions ADD COLUMN photo_url TEXT;
    `,
  },
  {
    version: 73,
    name: 'chat_queue_origin',
    sql: /* sql */ `
      -- Origem da mensagem enfileirada ('renderer' | 'channel'); null = renderer.
      -- Preserva o evento user-message (bolha ao vivo) quando uma msg de canal
      -- passou pela fila (agente ocupado) antes de ser despachada.
      ALTER TABLE chat_queue ADD COLUMN origin TEXT;
    `,
  },
  {
    version: 74,
    name: 'chat_sessions_channel_type',
    sql: /* sql */ `
      -- Canal de origem da sessão (telegram/whatsapp/…). Persiste o ícone do canal
      -- na sessão mesmo quando o link (1 por contato) é re-apontado em /new.
      ALTER TABLE chat_sessions ADD COLUMN channel_type TEXT;
    `,
  },
  {
    version: 75,
    name: 'api_lab_core',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS api_lab_collections (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        variables_json TEXT NOT NULL DEFAULT '[]',
        auth_json TEXT NOT NULL DEFAULT '{"type":"none"}',
        scripts_json TEXT NOT NULL DEFAULT '{"preRequest":"","postResponse":""}',
        tests_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_lab_collections_workspace
        ON api_lab_collections(workspace_id, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS api_lab_environments (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '[]',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_lab_environments_workspace
        ON api_lab_environments(workspace_id, is_default, name);

      CREATE TABLE IF NOT EXISTS api_lab_requests (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        collection_id TEXT NOT NULL REFERENCES api_lab_collections(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'http',
        method TEXT NOT NULL DEFAULT 'GET',
        url TEXT NOT NULL DEFAULT '',
        headers_json TEXT NOT NULL DEFAULT '[]',
        query_json TEXT NOT NULL DEFAULT '[]',
        auth_json TEXT NOT NULL DEFAULT '{"type":"none"}',
        body_json TEXT NOT NULL DEFAULT '{"mode":"none"}',
        scripts_json TEXT NOT NULL DEFAULT '{"preRequest":"","postResponse":""}',
        tests_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_lab_requests_collection
        ON api_lab_requests(collection_id, sort_order, created_at);
      CREATE INDEX IF NOT EXISTS idx_api_lab_requests_workspace
        ON api_lab_requests(workspace_id);

      CREATE TABLE IF NOT EXISTS api_lab_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        collection_id TEXT REFERENCES api_lab_collections(id) ON DELETE SET NULL,
        request_id TEXT REFERENCES api_lab_requests(id) ON DELETE SET NULL,
        environment_id TEXT REFERENCES api_lab_environments(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        request_snapshot_json TEXT NOT NULL,
        response_json TEXT,
        error_message TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_lab_runs_workspace
        ON api_lab_runs(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_api_lab_runs_request
        ON api_lab_runs(request_id, created_at);
    `,
  },
  {
    version: 76,
    name: 'api_lab_request_scripts',
    sql: /* sql */ `
      ALTER TABLE api_lab_requests
        ADD COLUMN scripts_json TEXT NOT NULL DEFAULT '{"preRequest":"","postResponse":""}';
    `,
  },
  {
    version: 77,
    name: 'api_lab_collection_variables',
    sql: /* sql */ `
      ALTER TABLE api_lab_collections
        ADD COLUMN variables_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 78,
    name: 'api_lab_collection_runtime',
    sql: /* sql */ `
      ALTER TABLE api_lab_collections
        ADD COLUMN auth_json TEXT NOT NULL DEFAULT '{"type":"none"}';
      ALTER TABLE api_lab_collections
        ADD COLUMN scripts_json TEXT NOT NULL DEFAULT '{"preRequest":"","postResponse":""}';
      ALTER TABLE api_lab_collections
        ADD COLUMN tests_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 79,
    name: 'forge_pitfalls',
    sql: /* sql */ `
      -- OEP/Cápsula: RAG de ERROS. Cada falha de execução do Forge vira uma regra
      -- "when→avoid→because" que re-alimenta as próximas cápsulas (memória operacional
      -- que CONVERGE o mesmo erro em vez de re-descobri-lo).
      CREATE TABLE IF NOT EXISTS forge_pitfalls (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        file TEXT,
        keywords TEXT NOT NULL DEFAULT '',
        when_trigger TEXT NOT NULL,
        avoid TEXT NOT NULL,
        because TEXT NOT NULL,
        outcome TEXT NOT NULL,
        freq INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_forge_pitfalls_ws ON forge_pitfalls(workspace_id);
    `,
  },
  {
    version: 80,
    name: 'drop_api_lab',
    sql: /* sql */ `
      -- Feature API Lab removida (não estava pronta). Dropa as tabelas (ordem das FKs:
      -- filhas primeiro). As migrations v75-78 que as criaram ficam no histórico.
      DROP TABLE IF EXISTS api_lab_runs;
      DROP TABLE IF EXISTS api_lab_requests;
      DROP TABLE IF EXISTS api_lab_environments;
      DROP TABLE IF EXISTS api_lab_collections;
    `,
  },
  {
    version: 81,
    name: 'agent_run_cost_summary',
    sql: /* sql */ `
      -- Custo do turno de chat (orquestrador incluso): total_cost_usd + usage do
      -- evento 'result' do claude stream-json. Antes era descartado em
      -- chat-service.processClaudeEvent — o custo do braço orquestrador era
      -- invisível (só issue_runs media custo). Sem backfill: runs antigos não têm o dado.
      ALTER TABLE agent_runs ADD COLUMN tokens_in INTEGER;
      ALTER TABLE agent_runs ADD COLUMN tokens_out INTEGER;
      ALTER TABLE agent_runs ADD COLUMN cost_usd REAL;
    `,
  },
  {
    version: 82,
    name: 'chat_cli_resume_and_analyzer_cost',
    sql: /* sql */ `
      -- Reuso de sessão do CLI no chat (claude --resume): id da sessão do CLI,
      -- fingerprint do contexto ESTÁTICO enviado no 1º turno (instruções, skills,
      -- sources — mudou → sessão nova) e a última mensagem que o CLI viu (turnos
      -- resumidos mandam só o DELTA do histórico em vez do scaffolding inteiro).
      ALTER TABLE chat_sessions ADD COLUMN cli_session_id TEXT;
      ALTER TABLE chat_sessions ADD COLUMN cli_session_fingerprint TEXT;
      ALTER TABLE chat_sessions ADD COLUMN cli_last_message_id TEXT;
      -- Custo do run LLM da análise de repo (kb-repo-analyzer). Antes era
      -- INVISÍVEL (nenhuma tabela registrava) — a reanálise dispara a cada issue
      -- executada via ensureSourceFresh e subcontava o custo real do produto
      -- (inclusive no benchmark/). Sem backfill: jobs antigos ficam NULL.
      ALTER TABLE kb_analysis_jobs ADD COLUMN tokens_in INTEGER;
      ALTER TABLE kb_analysis_jobs ADD COLUMN tokens_out INTEGER;
      ALTER TABLE kb_analysis_jobs ADD COLUMN cost_usd REAL;
    `,
  },
  {
    version: 83,
    name: 'goal_horizon_budget',
    sql: /* sql */ `
      -- HORIZON Fase 2 (horizonte longo): orçamento honesto por objetivo.
      -- token_budget = teto de tokens (in+out somados dos issue_runs vinculados);
      -- NULL = sem teto. O loop de convergência (CEO re-entra com o DELTA até o
      -- objetivo fechar) respeita o teto e um cap de turnos (convergence_count),
      -- com rate-limit por last_convergence_at. Deadline reusa goals.due_date.
      ALTER TABLE goals ADD COLUMN token_budget INTEGER;
      ALTER TABLE goals ADD COLUMN convergence_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE goals ADD COLUMN last_convergence_at TEXT;
    `,
  },
];

/** Erros benignos = a mudança JÁ está aplicada (idempotente). Acontece quando
 * uma migration foi renumerada num merge e o banco já rodou a versão antiga. */
const BENIGN_MIGRATION_ERROR = /duplicate column name|already exists/i;

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) {
        if (next === quote) {
          current += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += ch + next;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch + next;
      i += 1;
      continue;
    }

    if (ch === ';') {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

function statementPreview(stmt: string): string {
  return stmt.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok: number } | undefined;
  return !!row;
}

function tableColumns(db: Database.Database, name: string): Set<string> {
  const rows = db.pragma(`table_info(${name})`) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function renameTableIfMissingColumns(
  db: Database.Database,
  name: string,
  requiredColumns: string[],
): void {
  if (!tableExists(db, name)) return;
  const columns = tableColumns(db, name);
  const missing = requiredColumns.filter((column) => !columns.has(column));
  if (missing.length === 0) return;

  const suffix = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  const backupName = `${name}_partial_${suffix}`;
  console.warn(
    `[db] tabela parcial detectada em ${name}; preservando como ${backupName} antes de migrar`,
  );
  db.exec(`ALTER TABLE ${name} RENAME TO ${backupName}`);
}

function tryExecMaintenance(db: Database.Database, sql: string, label: string): void {
  try {
    db.exec(sql);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[db] manutenção ignorada (${label}): ${message}`);
  }
}

function ensureColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
  ddl: string,
): void {
  if (!tableExists(db, tableName)) return;
  if (tableColumns(db, tableName).has(columnName)) return;
  tryExecMaintenance(
    db,
    `ALTER TABLE ${tableName} ADD COLUMN ${ddl};`,
    `adicionar ${tableName}.${columnName}`,
  );
}

function repairKnownRuntimeSchema(db: Database.Database): void {
  ensureColumn(db, 'kb_pages', 'is_pinned', 'is_pinned INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'kb_pages', 'retrieval_count', 'retrieval_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn(
    db,
    'api_lab_collections',
    'auth_json',
    `auth_json TEXT NOT NULL DEFAULT '{"type":"none"}'`,
  );
  ensureColumn(
    db,
    'api_lab_collections',
    'scripts_json',
    `scripts_json TEXT NOT NULL DEFAULT '{"preRequest":"","postResponse":""}'`,
  );
  ensureColumn(db, 'api_lab_collections', 'tests_json', `tests_json TEXT NOT NULL DEFAULT '[]'`);
}

function repairKnownPartialMigrations(db: Database.Database, currentVersion: number): void {
  if (currentVersion >= 38) return;

  renameTableIfMissingColumns(db, 'embedding_models', [
    'id',
    'provider',
    'family',
    'model_path',
    'model_hash',
    'dimension',
    'context_tokens',
    'is_required',
    'is_active',
    'created_at',
    'updated_at',
  ]);
  renameTableIfMissingColumns(db, 'kb_embedding_items', [
    'id',
    'workspace_id',
    'page_id',
    'chunk_id',
    'item_kind',
    'source_hash',
    'title',
    'text_preview',
    'token_count',
    'created_at',
    'updated_at',
  ]);
  renameTableIfMissingColumns(db, 'kb_embeddings', [
    'id',
    'workspace_id',
    'item_id',
    'model_id',
    'dimension',
    'vector',
    'norm',
    'created_at',
    'updated_at',
  ]);
  renameTableIfMissingColumns(db, 'knowledge_usage_stats', [
    'id',
    'workspace_id',
    'target_kind',
    'target_id',
    'source_id',
    'use_count',
    'hit_count',
    'first_used_at',
    'last_used_at',
    'updated_at',
  ]);
  renameTableIfMissingColumns(db, 'cleanup_suggestions', [
    'id',
    'workspace_id',
    'kind',
    'status',
    'title',
    'summary',
    'reason',
    'payload_json',
    'estimated_bytes',
    'item_count',
    'created_at',
    'updated_at',
    'decided_at',
    'applied_at',
  ]);

  if (tableExists(db, 'kb_embedding_items')) {
    tryExecMaintenance(
      db,
      `
        DELETE FROM kb_embedding_items
        WHERE page_id IS NOT NULL
          AND rowid NOT IN (
            SELECT max(rowid)
            FROM kb_embedding_items
            WHERE page_id IS NOT NULL
            GROUP BY workspace_id, page_id, item_kind
          );
      `,
      'dedupe kb_embedding_items antes do indice unico',
    );
  }
}

function runStartupMaintenance(db: Database.Database): void {
  repairKnownRuntimeSchema(db);

  if (tableExists(db, 'kb_embedding_jobs')) {
    tryExecMaintenance(
      db,
      `
        UPDATE kb_embedding_jobs
        SET status = 'queued',
            started_at = NULL,
            updated_at = datetime('now')
        WHERE status = 'running';
      `,
      'retomar jobs de embedding interrompidos',
    );
  }

  if (tableExists(db, 'kb_analysis_jobs')) {
    tryExecMaintenance(
      db,
      `
        UPDATE kb_analysis_jobs
        SET status = 'failed',
            error = COALESCE(error, 'Interrompido pelo reinicio do app. Reexecute a analise do source.'),
            completed_at = COALESCE(completed_at, datetime('now')),
            updated_at = datetime('now')
        WHERE status IN ('queued', 'running');
      `,
      'fechar jobs de analise interrompidos',
    );
  }

  if (tableExists(db, 'kb_embeddings') && tableExists(db, 'kb_embedding_items')) {
    tryExecMaintenance(
      db,
      `
        DELETE FROM kb_embeddings
        WHERE NOT EXISTS (
          SELECT 1 FROM kb_embedding_items i WHERE i.id = kb_embeddings.item_id
        );
      `,
      'limpar embeddings orfaos',
    );
  }

  if (tableExists(db, 'kb_embedding_items') && tableExists(db, 'kb_pages')) {
    tryExecMaintenance(
      db,
      `
        DELETE FROM kb_embedding_items
        WHERE page_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM kb_pages p WHERE p.id = kb_embedding_items.page_id
          );
      `,
      'limpar itens de embedding orfaos',
    );
  }

  // Sugestoes de limpeza ficam sob decisao do usuario; no boot so saneamos
  // artefatos tecnicos que podem impedir uma inicializacao limpa.
}

/**
 * Roda os statements da migration UM A UM, ignorando erros benignos por
 * statement (coluna/tabela já existe). Assim `ADD COLUMN` vira idempotente —
 * crucial pós-merge, quando o banco já tem parte do schema sob outra versão.
 */
function execMigrationStatements(db: Database.Database, sql: string): number {
  let benignSkips = 0;
  for (const stmt of splitSqlStatements(sql)) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (BENIGN_MIGRATION_ERROR.test(msg)) {
        // Esperado: migration de convergência re-afirma coluna/tabela que já
        // existe (ex.: ADD COLUMN num banco novo onde o CREATE TABLE já a criou).
        // Não é erro nem dado duplicado — só contamos pra um resumo enxuto.
        benignSkips += 1;
        continue;
      }
      throw new Error(`${msg} | statement: ${statementPreview(stmt)}`);
    }
  }
  return benignSkips;
}

export function runMigrations(db: Database.Database): void {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  const currentVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  repairKnownPartialMigrations(db, currentVersion);

  for (const m of migrations) {
    if (m.version <= currentVersion) continue;
    try {
      let benignSkips = 0;
      const trx = db.transaction(() => {
        benignSkips = execMigrationStatements(db, m.sql);
        db.pragma(`user_version = ${m.version}`);
      });
      trx();
      const skipNote = benignSkips > 0 ? ` (${benignSkips} coluna(s) já existiam, ok)` : '';
      console.log(`[db] migration aplicada: v${m.version} (${m.name})${skipNote}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Migration v${m.version} (${m.name}) falhou: ${message}. ` +
          `Se este banco veio de uma instalação anterior incompatível, ` +
          `mova ou apague o arquivo em userData e tente novamente.`,
      );
    }
  }

  runStartupMaintenance(db);
}
