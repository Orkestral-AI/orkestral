/**
 * Adapter de GERAÇÃO de código do motor v2.
 *
 * Forge removido: a geração roda no modelo PREMIUM do app, injetado via `chat`. A
 * GenerateFn fica atrás de uma função `chat` pura (system, user) -> texto, então o
 * loop continua testável sem modelo real e o app pluga o premium real.
 */
import type { GenerateFn, GenerateInput } from './execute-checkbox';

export interface GenerateAdapterDeps {
  /** Chamada ao modelo (system, user) -> texto. O app pluga o premium. */
  chat: (system: string, user: string) => Promise<string>;
}

/** Estima tokens de forma barata (~4 chars/token) a partir do texto. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Remove cercas de código markdown e texto fora do conteúdo do arquivo. */
export function cleanModelOutput(text: string): string {
  // Remove a cerca de abertura (```lang) e a de fechamento (```), preservando o
  // conteúdo do arquivo como está (inclusive a quebra de linha final).
  return text.replace(/^\s*```[a-zA-Z0-9]*\n/, '').replace(/```\s*$/, '');
}

const GENERATE_SYSTEM = [
  'You produce the COMPLETE updated content of a SINGLE file.',
  'Output ONLY the file content: no prose, no explanation, no markdown fences.',
  'Implement the task fully. Never leave a stub, a placeholder or a "// ..." gap.',
  'Import only from files that exist in the project; never invent a package or module.',
].join(' ');

/** Monta o prompt do usuário a partir do input de geração. */
export function buildGenerateUserPrompt(input: GenerateInput): string {
  const parts: string[] = [];
  parts.push(`Task: ${input.instruction}`);
  parts.push(`Target file: ${input.targetFile}`);
  if (input.availableComponents?.length) {
    parts.push(`Prefer these existing components: ${input.availableComponents.join(', ')}`);
  }
  if (input.existingFiles?.length) {
    parts.push(
      `Files that exist in the project:\n${input.existingFiles.map((f) => `- ${f}`).join('\n')}`,
    );
  }
  if (input.currentCode) {
    parts.push(`Current content of ${input.targetFile}:\n${input.currentCode}`);
  }
  if (input.feedback) {
    parts.push(`The previous attempt was rejected. Fix this and try again:\n${input.feedback}`);
  }
  parts.push(`Output the COMPLETE new content of ${input.targetFile}.`);
  return parts.join('\n\n');
}

/** Cria a GenerateFn do motor v2 usando o chat injetado (premium). */
export function createGenerate(deps: GenerateAdapterDeps): GenerateFn {
  return async (input) => {
    const user = buildGenerateUserPrompt(input);
    const raw = await deps.chat(GENERATE_SYSTEM, user);
    return { code: cleanModelOutput(raw), tokensLocal: estimateTokens(user + raw) };
  };
}
