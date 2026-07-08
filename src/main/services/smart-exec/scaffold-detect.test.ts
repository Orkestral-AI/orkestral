import { describe, it, expect } from 'vitest';
import { isScaffoldIssue } from './orchestrator';
import type { Issue } from '../../../shared/types';

function issue(title: string, labels: string[] = []): Issue {
  return { title, labels } as unknown as Issue;
}

describe('isScaffoldIssue — scaffold greenfield sempre escala pro premium', () => {
  it('detecta issues de scaffold/bootstrap de projeto', () => {
    expect(isScaffoldIssue(issue('Scaffold Next.js 15 + shadcn/ui + Prisma + PostgreSQL'))).toBe(
      true,
    );
    expect(isScaffoldIssue(issue('Bootstrap do projeto'))).toBe(true);
    expect(isScaffoldIssue(issue('Setup do projeto inicial'))).toBe(true);
    expect(isScaffoldIssue(issue('Inicializar projeto Next'))).toBe(true);
    expect(isScaffoldIssue(issue('Criar app', ['scaffold']))).toBe(true);
  });

  it('NÃO marca edits normais como scaffold (evita escalar tudo)', () => {
    expect(isScaffoldIssue(issue('Backend — GET /api/conversations'))).toBe(false);
    expect(isScaffoldIssue(issue('Frontend — Página de Membros'))).toBe(false);
    expect(isScaffoldIssue(issue('Setup do cache Redis na rota'))).toBe(false);
  });
});
