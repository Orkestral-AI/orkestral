import { describe, expect, it } from 'vitest';
import { chatFinalTextForIssueRun } from './issue-execution-service';

describe('issue chat mirror smoke', () => {
  it('does not mirror raw local file-change summaries as repeated chat messages', () => {
    expect(
      chatFinalTextForIssueRun('1 arquivo(s) alterado(s) localmente: src/app/layout.tsx'),
    ).toBe(undefined);
  });

  it('keeps code-change blocks for the aggregated review surface', () => {
    expect(
      chatFinalTextForIssueRun(
        '✅ Run finalizado\n\n<orkestral:code-changes source_id="s"></orkestral:code-changes>',
      ),
    ).toBe('<orkestral:code-changes source_id="s"></orkestral:code-changes>');
  });

  it('strips the neutral "Run concluído" header (e o antigo "✅ Run finalizado")', () => {
    expect(chatFinalTextForIssueRun('Run concluído · 9 ações · uso alto da sessão')).toBe(
      undefined,
    );
    expect(chatFinalTextForIssueRun('Run concluído · 3 ações\n\nResolvi o bug do botão.')).toBe(
      'Resolvi o bug do botão.',
    );
    expect(chatFinalTextForIssueRun('✅ Run finalizado · 2 ações')).toBe(undefined);
  });
});
