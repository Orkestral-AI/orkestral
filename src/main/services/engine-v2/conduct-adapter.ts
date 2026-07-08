/**
 * Motor v2: o conduct premium (secao 5 do plano).
 *
 * Quando o Forge local esgota num checkbox, o premium entra SO ali, com o estado real
 * (trilha + violacoes + diagnosticos + codigo atual), e devolve o arquivo correto. Fica
 * atras da interface PremiumChatFn: o app pluga o adapter de agente premium real; aqui a
 * logica (prompt + limpeza + tokens) e pura e testavel.
 */
import { cleanModelOutput, estimateTokens } from './generate-adapter';
import type { ConductFn, ConductInput } from './issue-runner';

export interface PremiumChatOutput {
  text: string;
  premiumIn: number;
  premiumOut: number;
}
export type PremiumChatFn = (system: string, user: string) => Promise<PremiumChatOutput>;

const CONDUCT_SYSTEM = [
  'You are the premium model conducting Orkestral execution.',
  'The local executor ran out of attempts on this file. Look at the REAL STATE and solve it.',
  'Use only imports that really exist and the project frozen design system.',
  'Respond ONLY with the final, correct file content. No explanation, no fences.',
].join('\n');

/** Monta o prompt de conducao a partir do snapshot compacto do checkbox travado. */
export function buildConductPrompt(input: ConductInput): { system: string; user: string } {
  const parts: string[] = [];
  parts.push(`File: ${input.checkbox.targetFile}`);
  parts.push(`Task: ${input.checkbox.instruction}`);
  parts.push(`Local attempts:\n${input.trail.join('\n') || '(no trail)'}`);
  if (input.violations.length > 0) {
    parts.push(
      `Invalid imports detected:\n${input.violations.map((v) => `- ${v.source}: ${v.detail}`).join('\n')}`,
    );
  }
  if (input.diagnostics.length > 0) {
    parts.push(
      `Compilation errors:\n${input.diagnostics.map((d) => `- TS${d.code} ${d.message}`).join('\n')}`,
    );
  }
  parts.push(
    input.currentCode != null
      ? `Current content:\n${input.currentCode}`
      : 'The file does not exist yet.',
  );
  parts.push('Generate the final, correct content of the file:');
  return { system: CONDUCT_SYSTEM, user: parts.join('\n\n') };
}

/** Cria a ConductFn que o orquestrador usa na escalada, plugada no premium do app. */
export function createConduct(
  premiumChat: PremiumChatFn,
  estimate: (t: string) => number = estimateTokens,
): ConductFn {
  return async (input: ConductInput) => {
    const { system, user } = buildConductPrompt(input);
    const out = await premiumChat(system, user);
    return {
      code: cleanModelOutput(out.text),
      // usa os tokens reportados pelo premium se vierem; senao estima do prompt+saida.
      premiumIn: out.premiumIn || estimate(system + user),
      premiumOut: out.premiumOut || estimate(out.text),
    };
  };
}

export { CONDUCT_SYSTEM };
