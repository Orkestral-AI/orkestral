import { describe, it, expect } from 'vitest';

import { parsePremiumCompletion, isPremiumAdapter, FORGE_ADAPTER } from './premium-runner';

describe('premium-runner (provider-agnostic premiumChat)', () => {
  it('premium = any adapter that is not Forge', () => {
    expect(isPremiumAdapter('claude_local')).toBe(true);
    expect(isPremiumAdapter('codex_local')).toBe(true);
    expect(isPremiumAdapter(FORGE_ADAPTER)).toBe(false);
  });

  it('parses the REAL output of claude --print --output-format json', () => {
    // Capturado de verdade rodando `echo ... | claude --print --output-format json`.
    const real =
      '{"type":"result","subtype":"success","is_error":false,"result":"OK","stop_reason":"end_turn","total_cost_usd":0.0915,"usage":{"input_tokens":11203,"cache_creation_input_tokens":2758,"cache_read_input_tokens":15621,"output_tokens":4}}';
    const out = parsePremiumCompletion(real);
    expect(out.text).toBe('OK');
    expect(out.premiumIn).toBe(11203);
    expect(out.premiumOut).toBe(4);
  });

  it('parses JSONL (stream) ignoring non-JSON banner', () => {
    const jsonl = [
      'Warning: algum banner do CLI',
      '{"type":"system","subtype":"init"}',
      '{"type":"result","result":"plano aqui","usage":{"input_tokens":500,"output_tokens":120}}',
    ].join('\n');
    const out = parsePremiumCompletion(jsonl);
    expect(out.text).toBe('plano aqui');
    expect(out.premiumIn).toBe(500);
    expect(out.premiumOut).toBe(120);
  });

  it('extracts text from message.content when there is no result field', () => {
    const j =
      '{"message":{"content":[{"type":"text","text":"oi "},{"type":"text","text":"mundo"}]},"usage":{"input_tokens":3,"output_tokens":2}}';
    const out = parsePremiumCompletion(j);
    expect(out.text).toBe('oi mundo');
  });
});
