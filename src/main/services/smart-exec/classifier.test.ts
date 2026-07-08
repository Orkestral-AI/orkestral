import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyIssue,
  deriveCreateFiles,
  detectValidationCommands,
  isPlanningIssue,
} from './classifier';
import { getSmartExecConfig } from './config';
import type { Issue } from '../../../shared/types';

const cfg = getSmartExecConfig();

function mkIssue(over: Partial<Issue>): Issue {
  return {
    id: 'i',
    workspaceId: 'w',
    issueKey: 1,
    title: '',
    description: null,
    status: 'todo',
    priority: 'medium',
    labels: [],
    assigneeAgentId: null,
    reporterAgentId: null,
    parentIssueId: null,
    goalId: null,
    displayKey: null,
    childOrdinal: null,
    dueDate: null,
    completedAt: null,
    metadata: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

describe('classifyIssue — Forge é o executor primário (P0-12/P0-14)', () => {
  it('arquivo existente no título → premium_edit (edição barata)', () => {
    const c = classifyIssue(mkIssue({ title: 'Fix button in src/components/Button.tsx' }), {
      config: cfg,
    });
    expect(c.executionMode).toBe('premium_edit');
  });

  it('sem arquivos no título → LOCAL (explora o repo, não escala)', () => {
    const c = classifyIssue(mkIssue({ title: 'Improve the onboarding experience' }), {
      config: cfg,
    });
    expect(c.executionMode).toBe('premium_model');
  });

  it('sem áreas críticas: arquivo "sensível" (auth) também roda local no Forge', () => {
    const c = classifyIssue(mkIssue({ title: 'update token check in src/auth/session.ts' }), {
      config: cfg,
    });
    // Decisão do dono: edição localizada num arquivo existente roda o caminho barato
    // (premium_edit); a validação fica com o CEO/TechLead no review.
    expect(c.executionMode).toBe('premium_edit');
  });

  it('muitos arquivos afetados → premium (mudança grande)', () => {
    const files = Array.from(
      { length: cfg.thresholds.maxAffectedFiles + 2 },
      (_, i) => `src/f${i}.ts`,
    );
    const c = classifyIssue(
      mkIssue({ title: 'big change', metadata: { affectedFiles: files } as never }),
      { config: cfg },
    );
    expect(c.executionMode).toBe('premium_model');
  });

  it('risco varia conforme o conteúdo (não é sempre o mesmo)', () => {
    const low = classifyIssue(mkIssue({ title: 'tweak copy in src/ui/Label.tsx' }), {
      config: cfg,
    });
    const risky = classifyIssue(mkIssue({ title: 'refactor architecture of src/core.ts' }), {
      config: cfg,
    });
    expect(low.risk).toBe('low');
    expect(['medium', 'high']).toContain(risky.risk);
  });

  it('Design/QA: [Design]/[QA] (ou label) → local_deliverable, não patch de código', () => {
    const d = classifyIssue(mkIssue({ title: '[Design] Mockup do SoftphoneWidget' }), {
      config: cfg,
    });
    expect(d.executionMode).toBe('premium_model');
    expect(d.deliverableKind).toBe('design');
    const q = classifyIssue(mkIssue({ title: '[QA] Validação final E2E' }), { config: cfg });
    expect(q.executionMode).toBe('premium_model');
    expect(q.deliverableKind).toBe('qa');
    // label também dispara (sem o prefixo no título)
    const byLabel = classifyIssue(mkIssue({ title: 'Tela de configuração', labels: ['design'] }), {
      config: cfg,
    });
    expect(byLabel.executionMode).toBe('premium_model');
    // issue de código normal NÃO é deliverable → edição barata (premium_edit)
    const code = classifyIssue(mkIssue({ title: 'Fix button in src/x.tsx' }), { config: cfg });
    expect(code.executionMode).toBe('premium_edit');
  });
});

describe('deriveCreateFiles — criar arquivo NOVO vs editar existente (raiz do bug das migrations)', () => {
  function laravelDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ork-laravel-'));
    mkdirSync(join(dir, 'database', 'migrations'), { recursive: true });
    writeFileSync(join(dir, 'composer.json'), '{}');
    return dir;
  }

  it('Laravel: "Migration + Models: calls, ..." deriva caminhos NOVOS (não edita os existentes)', () => {
    const dir = laravelDir();
    try {
      const files = deriveCreateFiles(
        mkIssue({ title: 'Migration + Models: calls, call_sessions, department_call_config' }),
        dir,
      );
      const migrations = files.filter((f) => f.startsWith('database/migrations/'));
      expect(migrations.length).toBe(3);
      expect(migrations.some((f) => /_create_calls_table\.php$/.test(f))).toBe(true);
      expect(migrations.some((f) => /_create_call_sessions_table\.php$/.test(f))).toBe(true);
      expect(migrations.some((f) => /_create_department_call_config_table\.php$/.test(f))).toBe(
        true,
      );
      // models singularizados em StudlyCase
      expect(files).toContain('app/Models/Call.php');
      expect(files).toContain('app/Models/CallSession.php');
      expect(files).toContain('app/Models/DepartmentCallConfig.php');
      // NUNCA propõe editar uma migration core existente
      expect(files.every((f) => !/create_users_table/.test(f))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('não-Laravel: não inventa caminho (vazio)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ork-node-'));
    try {
      expect(deriveCreateFiles(mkIssue({ title: 'Migration: calls' }), dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sem intenção de criar → vazio (edição normal segue o caminho antigo)', () => {
    const dir = laravelDir();
    try {
      expect(deriveCreateFiles(mkIssue({ title: 'fix bug in CallController' }), dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FRONTEND (stack-agnóstico): "Criar `src/contexts/CallContext.tsx`" deriva o caminho NOVO citado', () => {
    // Não é Laravel (repo Node/React). O caminho explícito na issue tem prioridade e
    // funciona pra qualquer stack — era o bug do CallContext (frontend bloqueando).
    const dir = mkdtempSync(join(tmpdir(), 'ork-react-'));
    try {
      const files = deriveCreateFiles(
        mkIssue({
          title: 'CallContext: provider de chamada',
          description: 'Criar `src/contexts/CallContext.tsx` com o provider e o hook useCall.',
        }),
        dir,
      );
      expect(files).toEqual(['src/contexts/CallContext.tsx']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caminho explícito que JÁ EXISTE não vira criação (é edição) → não dispara', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ork-react2-'));
    try {
      mkdirSync(join(dir, 'src', 'contexts'), { recursive: true });
      writeFileSync(join(dir, 'src', 'contexts', 'CallContext.tsx'), 'export {};');
      const files = deriveCreateFiles(
        mkIssue({ title: 'Editar Criar src/contexts/CallContext.tsx para adicionar mute' }),
        dir,
      );
      expect(files).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ANTI-OVER-TRIGGER: título de edição cuja DESCRIÇÃO cita migration/model NÃO dispara criação', () => {
    const dir = laravelDir();
    try {
      // Era o regressão pega na verificação: a prosa da descrição gerava caminhos-lixo.
      // É uma EDIÇÃO de controller EXISTENTE (infra já existe, conforme a descrição) →
      // o controller existe no repo, então o artefato dedupa (não recria) e a prosa
      // de migration/model não dispara criação.
      mkdirSync(join(dir, 'app', 'Http', 'Controllers'), { recursive: true });
      writeFileSync(join(dir, 'app', 'Http', 'Controllers', 'CallController.php'), '<?php');
      const files = deriveCreateFiles(
        mkIssue({
          title: 'CallController — GET/PUT /api/calling/config',
          description:
            'Lê a tabela call_config; a migration já existe e usa o model DepartmentCallConfig.',
        }),
        dir,
      );
      expect(files).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ANTI-OVER-TRIGGER: ":" cujo CABEÇALHO não declara migration/model NÃO dispara', () => {
    const dir = laravelDir();
    try {
      expect(
        deriveCreateFiles(
          mkIssue({ title: 'Tela admin: configurar ligações por departamento' }),
          dir,
        ),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('teto: respeita maxFiles (nunca cria em massa)', () => {
    const dir = laravelDir();
    try {
      const files = deriveCreateFiles(
        mkIssue({ title: 'Migration: a, b, c, d, e, f, g, h, i, j' }),
        dir,
        4,
      );
      expect(files.length).toBeLessThanOrEqual(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('não sobrescreve: caminho que JÁ existe é omitido', () => {
    const dir = laravelDir();
    try {
      mkdirSync(join(dir, 'app', 'Models'), { recursive: true });
      writeFileSync(join(dir, 'app', 'Models', 'Call.php'), '<?php');
      const files = deriveCreateFiles(mkIssue({ title: 'Models: calls' }), dir);
      expect(files).not.toContain('app/Models/Call.php');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('não duplica migration: tabela que JÁ tem migration (qualquer timestamp) é omitida', () => {
    const dir = laravelDir();
    try {
      // Bug real: re-rodar criava 224406_..._create_call_setting_table E
      // 224514_..._create_call_setting_table (mesma tabela). O stamp muda a cada
      // run, então checar o path exato nunca casava → duplicata → `migrate` quebra.
      writeFileSync(
        join(dir, 'database', 'migrations', '2020_01_01_000000_create_calls_table.php'),
        '<?php',
      );
      const files = deriveCreateFiles(mkIssue({ title: 'Migration: calls' }), dir);
      expect(files.filter((f) => /_create_calls_table\.php$/.test(f))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Migration + Model SEM ":" (formato com parênteses) deriva criação', () => {
    const dir = laravelDir();
    try {
      // Bug real (issue 48, run novo): o CEO usou "Migration + Model CallSession
      // (estados…)" — sem ":" e sem artefato no início → caía no explore e bloqueava.
      const f1 = deriveCreateFiles(
        mkIssue({ title: 'Migration + Model CallSession (estados ringing→ended)' }),
        dir,
      );
      expect(f1.some((f) => /_create_call_session_table\.php$/.test(f))).toBe(true);
      expect(f1).toContain('app/Models/CallSession.php');
      const f2 = deriveCreateFiles(
        mkIssue({ title: 'Migration + Model call_settings (canal/departamento/enabled)' }),
        dir,
      );
      expect(f2.some((f) => /_create_call_settings_table\.php$/.test(f))).toBe(true);
      expect(f2).toContain('app/Models/CallSetting.php');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('artefato nomeado no título (Controller/Service) → cria o arquivo certo', () => {
    const dir = laravelDir();
    try {
      // Bug real (EZC-1.5/38): "CallRecordingService — proxy…" não tinha alvo, o
      // explore chutava um arquivo existente errado e bloqueava. Agora deriva o
      // arquivo NOVO do artefato e cria.
      expect(
        deriveCreateFiles(mkIssue({ title: 'CallSettingsController — CRUD de config' }), dir),
      ).toEqual(['app/Http/Controllers/CallSettingsController.php']);
      expect(
        deriveCreateFiles(mkIssue({ title: 'CallRecordingService — proxy de stream' }), dir),
      ).toEqual(['app/Services/CallRecordingService.php']);
      // NÃO dispara no meio do título (edição de existente, não criação).
      expect(deriveCreateFiles(mkIssue({ title: 'fix bug in CallController' }), dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifyIssue: create-intent → premium_model (criação escala pro run completo) com createFiles', () => {
    const dir = laravelDir();
    try {
      const c = classifyIssue(mkIssue({ title: 'Criar migration: payments' }), {
        config: cfg,
        repoPath: dir,
      });
      // Criação de arquivo novo NÃO usa premium_edit (que só edita existente com
      // segurança): vai pro run premium completo, que cria com contexto do repo.
      expect(c.executionMode).toBe('premium_model');
      expect(c.createFiles.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detectValidationCommands: mudança PHP-only NÃO roda npm lint/typecheck (whole-repo JS)', () => {
    const dir = laravelDir();
    try {
      // P1-2: antes, npm lint (JS) rodava pra QUALQUER mudança se houvesse
      // package.json — uma mudança PHP era "validada" por lint de JS e podia
      // bloquear por erro JS pré-existente. Agora npm só roda quando há JS/TS.
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc' } }),
      );
      const cmds = detectValidationCommands(dir, ['app/Models/Call.php']);
      expect(cmds.some((c) => c.includes('npm run'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detectValidationCommands: NUNCA roda lint/typecheck do projeto do usuário (whole-repo)', () => {
    const dir = laravelDir();
    try {
      // O agente não roda a tooling do usuário (lint/typecheck do repo inteiro) —
      // ela falha por erro pré-existente e bloqueia trabalho bom. Só altera e pronto;
      // o Code Reviewer é a rede de qualidade.
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc', 'type-check': 'tsc' } }),
      );
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      const cmds = detectValidationCommands(dir, [
        'src/components/CallContext.tsx',
        'src/index.ts',
      ]);
      expect(cmds.some((c) => c.includes('npm run'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifyIssue: caminho citado em PROSA que não existe não vira affectedFile (P2-1)', () => {
    const dir = laravelDir();
    try {
      const c = classifyIssue(
        mkIssue({ title: 'Update something', description: 'see README.md and src/missing.ts' }),
        { config: cfg, repoPath: dir },
      );
      expect(c.affectedFiles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifyIssue: DIRETÓRIO em affectedFiles é descartado → cai no caminho de criação', () => {
    const dir = laravelDir();
    try {
      // Bug real (EZC-1.1): o CEO emitiu um DIRETÓRIO ("database/migrations/") como
      // arquivo afetado. existsSync é true pra diretório → ele virava alvo de edição,
      // o resolveTargetFiles expandia em N migrations existentes e destruía o plano
      // de CRIAÇÃO → 0 edições → bloqueio. O diretório DEVE ser descartado.
      const c = classifyIssue(
        mkIssue({
          title: 'Migration + Models: CallSetting e CallSession',
          metadata: { affectedFiles: ['database/migrations/'] },
        }),
        { config: cfg, repoPath: dir },
      );
      expect(c.affectedFiles).toEqual([]); // diretório descartado
      expect(c.createFiles.length).toBeGreaterThan(0); // criação derivada
      expect(c.executionMode).toBe('premium_model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isPlanningIssue — planejamento/spec/review roda no modelo do agente, não no Forge', () => {
  it('spec de arquitetura (cabeçalho) → planning', () => {
    expect(
      isPlanningIssue(mkIssue({ title: 'Spec de arquitetura — WhatsApp Business Calling' })),
    ).toBe(true);
  });
  it('prefixo [Review]/[Plan] → planning', () => {
    expect(isPlanningIssue(mkIssue({ title: '[Review] sessão e gravação' }))).toBe(true);
    expect(isPlanningIssue(mkIssue({ title: '[Plan] roadmap de ligações' }))).toBe(true);
  });
  it('revisão de código (cabeçalho PT) → planning', () => {
    expect(isPlanningIssue(mkIssue({ title: 'Revisão de código — sessão e sinalização' }))).toBe(
      true,
    );
  });
  it('label de planejamento → planning', () => {
    expect(isPlanningIssue(mkIssue({ title: 'Definir contrato', labels: ['architecture'] }))).toBe(
      true,
    );
  });
  it('edit de código comum NÃO é planning (sem falso-positivo)', () => {
    expect(isPlanningIssue(mkIssue({ title: 'Add review button to src/Toolbar.tsx' }))).toBe(false);
    expect(isPlanningIssue(mkIssue({ title: 'Migration + Model CallSession' }))).toBe(false);
  });
});

describe('path-traversal — caminhos fora do repo NUNCA viram alvos (segurança)', () => {
  it('"Create src/../../../tmp/evil.ts" → createFiles vazio (traversal descartado)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classifier-trav-'));
    try {
      const c = classifyIssue(mkIssue({ title: 'Create src/../../../tmp/evil.ts' }), {
        config: cfg,
        repoPath: dir,
      });
      expect(c.createFiles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deriveCreateFiles descarta `..` no MEIO do caminho que escapa a raiz', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classifier-abs-'));
    try {
      // O `..` está DENTRO do token capturado (não é prefixo que o regex já corta) →
      // resolve pra fora do repo → tem que ser descartado pelo isInsideRepo.
      const out = deriveCreateFiles(mkIssue({ title: 'Create src/../../../tmp/evil.ts now' }), dir);
      expect(out).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caminho de traversal citado no texto não vira affectedFiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classifier-aff-'));
    try {
      const c = classifyIssue(mkIssue({ title: 'edit ../../../tmp/evil.ts please' }), {
        config: cfg,
        repoPath: dir,
      });
      expect(c.affectedFiles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
