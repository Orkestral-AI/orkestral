import { describe, it, expect } from 'vitest';
import { parseAskUserBlock, isHiddenPlanningMessage, PLANNING_DECISIONS_HIDDEN } from './ask-user';

const block = (body: string): string =>
  `Some framing prose.\n<orkestral:ask-user>${body}</orkestral:ask-user>\ntrailing.`;

describe('parseAskUserBlock', () => {
  it('parses a valid block and strips it from the text', () => {
    const json = JSON.stringify({
      intro: 'A few decisions',
      questions: [
        {
          id: 'scope',
          question: 'Where should we start?',
          options: [{ label: 'MVP', description: 'mock everything' }, { label: 'Real core' }],
          allowOther: true,
        },
      ],
    });
    const { payload, cleanedText } = parseAskUserBlock(block(json), 'assistant');
    expect(payload).not.toBeNull();
    expect(payload!.intro).toBe('A few decisions');
    expect(payload!.questions).toHaveLength(1);
    expect(payload!.questions[0].id).toBe('scope');
    expect(payload!.questions[0].options).toEqual([
      { label: 'MVP', description: 'mock everything' },
      { label: 'Real core', description: undefined },
    ]);
    // O bloco cru NUNCA aparece no texto renderizado.
    expect(cleanedText).not.toContain('orkestral:ask-user');
    expect(cleanedText).toContain('Some framing prose.');
    expect(cleanedText).toContain('trailing.');
  });

  it('only fires for assistant messages', () => {
    const json = JSON.stringify({ questions: [{ question: 'Q?', options: ['A', 'B'] }] });
    const { payload, cleanedText } = parseAskUserBlock(block(json), 'user');
    expect(payload).toBeNull();
    // Mesmo sem renderizar o wizard, o bloco é removido (não vaza JSON cru).
    expect(cleanedText).not.toContain('orkestral:ask-user');
  });

  it('returns null payload on malformed JSON but still strips the block', () => {
    const { payload, cleanedText } = parseAskUserBlock(block('{ not valid json'), 'assistant');
    expect(payload).toBeNull();
    expect(cleanedText).not.toContain('orkestral:ask-user');
    expect(cleanedText).not.toContain('not valid json');
  });

  it('normalizes string options into labels', () => {
    const json = JSON.stringify({ questions: [{ question: 'Q?', options: ['Yes', 'No'] }] });
    const { payload } = parseAskUserBlock(block(json), 'assistant');
    expect(payload!.questions[0].options).toEqual([{ label: 'Yes' }, { label: 'No' }]);
  });

  it('defaults allowOther to true and respects an explicit false', () => {
    const json = JSON.stringify({
      questions: [
        { id: 'a', question: 'A?', options: ['x'] },
        { id: 'b', question: 'B?', options: ['y'], allowOther: false },
      ],
    });
    const { payload } = parseAskUserBlock(block(json), 'assistant');
    expect(payload!.questions[0].allowOther).toBe(true);
    expect(payload!.questions[1].allowOther).toBe(false);
  });

  it('drops questions without text and returns null when none remain', () => {
    const json = JSON.stringify({ questions: [{ options: ['x'] }, { question: '   ' }] });
    const { payload } = parseAskUserBlock(block(json), 'assistant');
    expect(payload).toBeNull();
  });

  it('passes text through untouched when there is no block', () => {
    const text = 'Just a normal answer with no questions.';
    const { payload, cleanedText } = parseAskUserBlock(text, 'assistant');
    expect(payload).toBeNull();
    expect(cleanedText).toBe(text);
  });

  it('does not parse an incomplete (still-streaming) block', () => {
    const partial = 'Prose\n<orkestral:ask-user>{"questions":[{"question":"Q?"';
    const { payload } = parseAskUserBlock(partial, 'assistant');
    expect(payload).toBeNull();
  });

  it('assigns fallback ids when the question omits one', () => {
    const json = JSON.stringify({ questions: [{ question: 'First?', options: ['a'] }] });
    const { payload } = parseAskUserBlock(block(json), 'assistant');
    expect(payload!.questions[0].id).toBe('q1');
  });

  it('strips em-dashes from displayed strings', () => {
    const json = JSON.stringify({
      questions: [
        {
          question: 'A or B?',
          options: [{ label: 'A', description: 'the three together — same API' }],
        },
      ],
    });
    const { payload } = parseAskUserBlock(block(json), 'assistant');
    expect(payload!.questions[0].options[0].description).toBe('the three together, same API');
  });
});

describe('isHiddenPlanningMessage', () => {
  it('hides new messages carrying the marker', () => {
    expect(isHiddenPlanningMessage(`${PLANNING_DECISIONS_HIDDEN}\nMinhas decisões:\n- a: b`)).toBe(
      true,
    );
  });

  it('hides legacy decision messages by header (pt and en)', () => {
    expect(isHiddenPlanningMessage('Minhas decisões:\n- Canais?: WhatsApp')).toBe(true);
    expect(isHiddenPlanningMessage('My decisions:\n- Channels?: WhatsApp')).toBe(true);
  });

  it('does not hide a normal user message', () => {
    expect(isHiddenPlanningMessage('Quero que crie um plano de marketing')).toBe(false);
  });
});
