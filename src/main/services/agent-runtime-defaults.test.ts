import { describe, it, expect } from 'vitest';
import { roleRuntimeDefaults, isExecutorRole } from './agent-runtime-defaults';

describe('roleRuntimeDefaults', () => {
  it('todos os papéis ignoram o sandbox', () => {
    for (const role of ['tech-lead', 'frontend', 'qa', 'designer', 'orchestrator']) {
      expect(roleRuntimeDefaults(role).bypassSandbox).toBe(true);
    }
  });

  it("papéis de raciocínio (TechLead/Reviewer/QA/CEO) usam esforço 'auto', sem fastMode", () => {
    for (const role of ['tech-lead', 'code-reviewer', 'qa', 'orchestrator', 'product']) {
      const cfg = roleRuntimeDefaults(role);
      expect(cfg.thinkingEffort).toBe('auto');
      expect(cfg.fastMode).toBeUndefined();
    }
  });

  it('executores (Frontend/Backend/Designer/DevOps) usam modo rápido, sem esforço fixo', () => {
    for (const role of ['frontend', 'backend', 'designer', 'devops']) {
      const cfg = roleRuntimeDefaults(role);
      expect(cfg.fastMode).toBe(true);
      expect(cfg.thinkingEffort).toBeUndefined();
    }
  });

  it('normaliza rótulos com espaço/maiúsculas (ex: "Tech Lead", "Frontend")', () => {
    expect(isExecutorRole('Frontend')).toBe(true);
    expect(isExecutorRole('Tech Lead')).toBe(false);
    expect(roleRuntimeDefaults('Frontend').fastMode).toBe(true);
  });
});
