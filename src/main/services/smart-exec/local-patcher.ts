/**
 * Executor local de edição. Monta o contrato estrito e chama o modelo local
 * (llama.cpp). Estratégia: o modelo emite SOMENTE blocos SEARCH/REPLACE
 * (estilo Aider/Cline) com o trecho EXATO a alterar — não reescreve o arquivo
 * inteiro (frágil para modelos pequenos). Quem parseia/aplica/valida é o app
 * (ver morph.ts + orchestrator + diff.ts). O modelo só produz texto.
 */
import { llamaChat } from './llama-runtime';
import { parseLineEdits, type LineEdit } from './line-edit';
import type { SmartExecConfig } from '../../../shared/types';
import { getPerformanceProfile } from '../performance-preset';

export interface LocalPatchConstraints {
  maxChangedLines: number;
  allowedFiles: string[];
  forbiddenFiles: string[];
  allowNewFiles: boolean;
  allowPublicApiChanges: boolean;
  allowArchitectureChanges: boolean;
}

export interface LocalPatchInput {
  taskId: string;
  filePath: string;
  instruction: string;
  /** Meta da issue — o GOAL do plano (premium), pra orientar a edição. */
  goal?: string;
  constraints: LocalPatchConstraints;
  fileContent: string;
  /** Dica de foco (linhas relevantes via WarpGrep) — onde no arquivo mexer. */
  focusHint?: string;
  /** Contexto recuperado da KB/memória operacional para grounding local. */
  contextPack?: string;
  /** Adapter LoRA aprovado/ativo para este workspace, quando existir. */
  loraPath?: string | null;
  /**
   * Quando setado, o gerador edita SÓ esta REGIÃO extraída (uma função/bloco),
   * não o arquivo inteiro — é o caminho seguro pro modelo pequeno em arquivo
   * grande (ele reproduz 30 linhas fiel, não 500). Ver generateLocalEditRegion.
   */
  regionText?: string;
  /**
   * Few-shot do RAG-de-edits: edits que o usuário JÁ ACEITOU neste repo, parecidos
   * com este. Ancoram o modelo no estilo REAL do usuário. Código fica LOCAL.
   */
  examples?: { file: string; symbol: string | null; instruction: string; acceptedEdit: string }[];
  /**
   * Arquivo EXISTENTE similar (mesmo tipo/diretório) passado como REFERÊNCIA de
   * estilo/estrutura ao CRIAR um arquivo novo — o modelo pequeno imita um exemplo
   * concreto do repo (imports, convenções) em vez de inventar do zero.
   */
  templateText?: string;
}

export type LocalEditResult =
  | { kind: 'edit'; update: string; raw: string }
  | { kind: 'cannot'; raw: string };

/** Resultado do edit ANCORADO POR LINHA — edits parseados (o app funde por nº de linha). */
export type LocalLineEditResult =
  | { kind: 'edit'; edits: LineEdit[]; raw: string }
  | { kind: 'cannot'; raw: string };

/**
 * Prompt de DIFF localizado. O modelo deve copiar EXATAMENTE as linhas
 * existentes no SEARCH e devolver só os blocos — sem reescrever o arquivo.
 * Modelos pequenos (0.5B/1.5B) não produzem unified diff válido (a matemática
 * dos hunks `@@ -x,y` quebra), mas conseguem copiar um trecho e propor a troca.
 */
/**
 * System prompt enviado como turno `system` da sessão de chat (instruct).
 * VERIFICADO no forge.gguf real (Qwen2.5-Coder-1.5B): com esta few-shot + chat
 * template, o modelo emite blocos SEARCH/REPLACE limpos e mínimos (4/4 nos
 * casos simples de teste). O exemplo é compacto e usa os marcadores EXATOS.
 */
export const EDIT_SYSTEM = `You edit code by emitting ONLY the snippet that changes (a "lazy" edit). NOTHING ELSE.

HOW TO RESPOND:
- Show only the changed lines, with A FEW real surrounding lines as an ANCHOR.
- For unchanged code (before, between, and after the snippets), write this EXACT line:
  // ... existing code ...
- GOLDEN RULE: every snippet MUST start and end with a line that ALREADY EXISTS in the file, copied IDENTICALLY (the anchor). The new code goes in the MIDDLE of the snippet. If the change is on the very 1st line of a block, include the unchanged line ABOVE it as the anchor.

RULES:
1. Respond ONLY with code (snippets + "// ... existing code ..." lines). No prose, no markdown, no \`\`\` fences.
2. DO NOT rewrite the whole file. DO NOT use SEARCH/REPLACE blocks.
3. Do not invent APIs/imports the instruction did not ask for. Do not touch authentication, payment, database, security, or infrastructure.

Example. File:
import { db } from './db';

export function soma(a, b) {
  const r = a + b;
  return r;
}

export default soma;
Instruction: multiply instead of adding.
You respond:
// ... existing code ...
export function soma(a, b) {
  const r = a * b;
  return r;
}
// ... existing code ...

(The line "export function soma(a, b) {" and the "}" exist in the file and anchor the snippet; only the middle changed.)

If it cannot be done safely, respond with only: CANNOT_PATCH_SAFELY`;

/** Limita o conteúdo do arquivo ao orçamento de prompt (aprox. 4 chars/token). */
function clampContent(content: string, maxPromptTokens: number): string {
  const maxChars = Math.max(1000, maxPromptTokens * 4 - 1200);
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '\n/* … (truncado pelo limite de contexto local) … */';
}

export function interpret(raw: string): LocalEditResult {
  let trimmed = raw.trim();
  // Remove cercas markdown (```lang … ```) que o modelo às vezes adiciona.
  const fence = trimmed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
  if (fence) trimmed = fence[1].trim();
  if (/^CANNOT_PATCH_SAFELY\b/.test(trimmed)) return { kind: 'cannot', raw: trimmed };
  if (trimmed.length === 0) return { kind: 'cannot', raw: trimmed };
  // Stub/no-op: saída só com marcadores de elisão (e linhas em branco), SEM nenhuma
  // linha de código real → não é um edit. Rejeita como 'cannot' pra disparar o retry
  // corretivo, em vez de "aplicar" um nada e cair no guard de 0-arquivos (bloqueio).
  const hasRealCode = trimmed.split('\n').some((l) => {
    const s = l.trim();
    return s.length > 0 && !/^\/\/\s*\.\.\.\s*existing code\s*\.\.\.\s*$/i.test(s);
  });
  if (!hasRealCode) return { kind: 'cannot', raw: trimmed };
  return { kind: 'edit', update: trimmed, raw: trimmed };
}

/** Teto DURO de chars por exemplo — independe do cap de 8000 do armazenamento; um
 * único edit gigante NÃO pode estourar o budget do few-shot. ~1500 ≈ 375 tokens. */
const EXAMPLE_MAX_CHARS = 1500;

/**
 * Renderiza os exemplos do RAG-de-edits (estilo aceito do usuário) como few-shot.
 * Limita a 3 exemplos e ao `budgetChars` TOTAL (orçamento já reservado pelo caller).
 * Cada exemplo é truncado a EXAMPLE_MAX_CHARS e NENHUM fura o budget (nem o 1º) —
 * o arquivo é o que importa, o few-shot nunca pode empurrar o prompt além do limite.
 */
export function renderExamplesBlock(
  examples: LocalPatchInput['examples'],
  budgetChars: number,
): string {
  if (!examples || examples.length === 0 || budgetChars <= 0) return '';
  const lines: string[] = ['ACCEPTED EDITS IN THIS REPO (match this style; do NOT copy verbatim):'];
  let used = 0;
  let shown = 0;
  for (const ex of examples) {
    if (shown >= 3) break;
    const edit =
      ex.acceptedEdit.length > EXAMPLE_MAX_CHARS
        ? ex.acceptedEdit.slice(0, EXAMPLE_MAX_CHARS) + '\n// … (truncado)'
        : ex.acceptedEdit;
    const block = `--- example (${ex.file}${ex.symbol ? ` · ${ex.symbol}` : ''})\nINSTRUCTION: ${ex.instruction}\nEDIT:\n${edit}`;
    // NENHUM exemplo fura o budget (inclusive o 1º): se não cabe, para.
    if (used + block.length > budgetChars) break;
    lines.push(block);
    used += block.length;
    shown += 1;
  }
  return shown > 0 ? lines.join('\n') + '\n' : '';
}

/** Monta o turno `user` do prompt de edição (mesmo formato pro local e pro premium). */
export function buildEditUserPrompt(input: LocalPatchInput, maxPromptTokens: number): string {
  // Budget COMPARTILHADO: os exemplos (≤15% do total) e o arquivo dividem o mesmo
  // teto. Reservamos o que os exemplos usaram ANTES de clampar o arquivo, senão
  // file(98%) + examples(15%) estouraria o contexto e truncaria a SAÍDA (o edit não
  // casaria no merge — exatamente a falha que o RAG deve evitar).
  const exampleBudget = Math.floor(maxPromptTokens * 4 * 0.15);
  const examplesBlock = renderExamplesBlock(input.examples, exampleBudget);
  const fileBudgetTokens = maxPromptTokens - Math.ceil(examplesBlock.length / 4);
  return [
    input.goal ? `GOAL: ${input.goal}` : '',
    `INSTRUCTION: ${input.instruction}`,
    input.contextPack
      ? `\nORKestral RAG CONTEXT (use only when relevant):\n${input.contextPack}`
      : '',
    input.focusHint ? `FOCUS: the change is most likely around ${input.focusHint}.` : '',
    examplesBlock ? `\n${examplesBlock}` : '',
    `\nFILE (${input.filePath}):`,
    clampContent(input.fileContent, fileBudgetTokens),
    `\nRespond with the lazy edit for ${input.filePath} (snippets + "// ... existing code ...").`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function generateLocalEdit(
  cfg: SmartExecConfig,
  input: LocalPatchInput,
): Promise<LocalEditResult> {
  const user = buildEditUserPrompt(input, cfg.local.maxPromptTokens);
  const out = await llamaChat(cfg, EDIT_SYSTEM, user, { loraPath: input.loraPath });
  return interpret(out);
}

/**
 * Reescrita de ARQUIVO INTEIRO (sem âncoras). Usado como último recurso LOCAL
 * antes de escalar: serve pra CRIAR arquivo novo (lazy-edit não tem âncora num
 * arquivo vazio) e pra quando o merge por âncora não casou. O app escreve o
 * conteúdo direto (applyWholeFile) e a validação + rollback protegem contra lixo.
 */
export const WHOLE_FILE_SYSTEM = `You write the COMPLETE content of ONE source file. Output ONLY the file's raw content — no prose, no explanations, NO markdown fences.

RULES:
1. Output the ENTIRE file, ready to save as-is (all imports, the full body, exports).
2. Match the project's existing style, imports and conventions shown in any reference/current content.
3. Implement EXACTLY what the instruction asks — do not invent extra features. Do not touch authentication, payment, database credentials, or infrastructure config.
4. If you cannot produce a safe, complete file, output only: CANNOT_WRITE_SAFELY`;

// Prompt DEDICADO pra CRIAÇÃO de arquivo novo. Diferente do rewrite: um arquivo que
// NÃO existe não tem nada pra quebrar, então o modelo pequeno NUNCA deve recusar (era
// a causa do "Forge não conseguiu gerar" → escalava). Sem a saída CANNOT, forçando a
// produzir o arquivo completo, e ancorando no template quando há um.
export const CREATE_FILE_SYSTEM = `You write the COMPLETE content of ONE BRAND-NEW source file, from scratch. The file does not exist yet — there is NOTHING to break — so you must ALWAYS produce it.

RULES:
1. Output ONLY the file's raw content: every import, the full body, the exports. NO prose, NO explanations, NO markdown fences, NO backticks.
2. Implement EXACTLY what the instruction asks. If a SIMILAR EXISTING FILE is shown, match its style, imports and conventions closely.
3. Do NOT refuse and do NOT output CANNOT_WRITE_SAFELY — a brand-new file is always safe to create. Write your best complete, working implementation.
4. Begin your answer with the first real line of code (an import or an \`export\`).`;

export function interpretWholeFile(raw: string): LocalEditResult {
  let trimmed = raw.trim();
  const fence = trimmed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
  if (fence) trimmed = fence[1].trim();
  if (/^CANNOT_WRITE_SAFELY\b/.test(trimmed) || trimmed.length === 0) {
    return { kind: 'cannot', raw: trimmed };
  }
  return { kind: 'edit', update: trimmed, raw: trimmed };
}

export async function generateLocalWholeFile(
  cfg: SmartExecConfig,
  input: LocalPatchInput,
  /** Override de temperatura (best-of-N por geração: criar/reescrever com diversidade). */
  temperature?: number,
): Promise<LocalEditResult> {
  const hasContent = input.fileContent.trim().length > 0;
  const user = [
    input.goal ? `GOAL: ${input.goal}` : '',
    `INSTRUCTION: ${input.instruction}`,
    input.contextPack
      ? `\nORKestral RAG CONTEXT (use only when relevant):\n${input.contextPack}`
      : '',
    !hasContent && input.templateText
      ? `\nSIMILAR EXISTING FILE in this repo (style/structure reference — ADAPT it to the instruction, do NOT copy verbatim):\n${clampContent(input.templateText, cfg.local.maxPromptTokens)}`
      : '',
    hasContent
      ? `\nCURRENT FILE (${input.filePath}):\n${clampContent(input.fileContent, cfg.local.maxPromptTokens)}`
      : '',
    hasContent
      ? `\nOutput the COMPLETE updated content of ${input.filePath} (the whole file, with the change applied).`
      : `\nOutput the COMPLETE content of the NEW file ${input.filePath}.`,
  ]
    .filter(Boolean)
    .join('\n');
  // Criação (arquivo vazio) usa o prompt FORÇADO sem saída de recusa; rewrite usa o
  // genérico (que permite CANNOT pra mudança arriscada num arquivo existente).
  const system = hasContent ? WHOLE_FILE_SYSTEM : CREATE_FILE_SYSTEM;
  const out = await llamaChat(cfg, system, user, {
    loraPath: input.loraPath,
    ...(temperature !== undefined ? { temperature } : {}),
  });
  return interpretWholeFile(out);
}

// ── Deliverable NON-CODE (Design/QA): TEXTO em markdown, não diff ──────────────
export const DESIGN_SPEC_SYSTEM = `You are a product designer. Write a concise DESIGN SPECIFICATION in markdown for the task below. Cover: purpose, layout/structure, the component breakdown, the relevant states (default, loading, empty, error), the key interactions, responsiveness, and accessibility notes. Be concrete and practical. Output ONLY the markdown spec — no preamble, no code, no fences.`;

export const QA_REPORT_SYSTEM = `You are a QA engineer. Write a concise QA VALIDATION REPORT in markdown for the task below. Produce a checklist of the acceptance criteria, each marked PASS / FAIL / TODO (TODO = cannot be verified yet) with a one-line note, then an overall verdict line. Output ONLY the markdown report — no preamble, no code, no fences.`;

/**
 * Gera o deliverable de uma issue NON-CODE (Design/QA) — um texto markdown (spec
 * de design / relatório de QA), não um patch. Roda 100% local (sem premium).
 */
export async function generateLocalDeliverable(
  cfg: SmartExecConfig,
  input: {
    kind: 'design' | 'qa';
    title: string;
    description: string;
    done?: string | null;
    contextPack?: string | null;
  },
): Promise<string> {
  const system = input.kind === 'design' ? DESIGN_SPEC_SYSTEM : QA_REPORT_SYSTEM;
  const user = [
    `TASK: ${input.title}`,
    input.description ? `\nDETAILS:\n${input.description}` : '',
    input.done ? `\nDONE CRITERION: ${input.done}` : '',
    input.contextPack ? `\nCONTEXT:\n${input.contextPack}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (await llamaChat(cfg, system, user)).trim();
}

export const REGION_SYSTEM = `You are given ONE function/method/block extracted from a larger source file. Rewrite ONLY this snippet to satisfy the instruction.

RULES:
1. Output ONLY the COMPLETE rewritten version of THIS SNIPPET — same first line (the signature) and same last line (the closing brace/dedent). Nothing before it, nothing after it.
2. Do NOT output the rest of the file. Do NOT add imports or code that belongs OUTSIDE this block.
3. Keep everything you are not explicitly asked to change EXACTLY as-is. Make the SMALLEST change that satisfies the instruction.
4. Match the existing style. Do not touch authentication, payment, database credentials, or infrastructure config.
5. NO markdown fences, no prose, no explanations. If you cannot do it safely, output only: CANNOT_WRITE_SAFELY`;

/**
 * Edita SÓ a REGIÃO extraída (uma função/bloco curto). O modelo pequeno reescreve
 * o trecho INTEIRO (sem âncoras — a forma mais confiável num snippet curto) e o app
 * funde de volta determinístico (spliceRegion). É o caminho que torna o Forge
 * confiável em arquivo grande sem nunca dropar código fora da região.
 */
export async function generateLocalEditRegion(
  cfg: SmartExecConfig,
  input: LocalPatchInput,
): Promise<LocalEditResult> {
  const region = input.regionText ?? '';
  if (!region.trim()) return { kind: 'cannot', raw: '' };
  const user = [
    input.goal ? `GOAL: ${input.goal}` : '',
    `INSTRUCTION: ${input.instruction}`,
    input.focusHint ? `FOCUS: ${input.focusHint}` : '',
    `\nSNIPPET to rewrite (from ${input.filePath}):\n${clampContent(region, cfg.local.maxPromptTokens)}`,
    `\nOutput ONLY the complete rewritten snippet (same signature first line, same closing last line).`,
  ]
    .filter(Boolean)
    .join('\n');
  const out = await llamaChat(cfg, REGION_SYSTEM, user);
  return interpretWholeFile(out);
}

/**
 * FAST-APPLY (estilo kortix-ai/fast-apply, Apache-2.0): em vez de casar a âncora do
 * lazy-edit (que falha quando o modelo varia um detalhe — `import { x }` vs `import x`),
 * o modelo MESCLA o `<update>` dentro do `<code>` e devolve o ARQUIVO INTEIRO mesclado
 * em `<updated-code>`. Sem âncora pra errar. Formato idêntico ao dataset de fast-apply,
 * então um Forge fine-tunado nesse dataset (próximo passo) fica EXCELENTE nessa tarefa.
 */
export const FAST_APPLY_SYSTEM = `You merge code updates into a file. Merge ALL changes from the <update> snippet into the <code> below, producing the COMPLETE updated file.

RULES:
1. Preserve the file's structure, order, comments and indentation EXACTLY, except where <update> changes it.
2. "// ... existing code ..." (and similar ellipsis markers) in <update> mean "keep the surrounding ORIGINAL code unchanged" — expand them back to the real original lines.
3. NEVER drop imports, exports, or any code that <update> did not explicitly change.
4. Output ONLY the complete updated file wrapped in <updated-code> and </updated-code>. No prose, no explanations, no markdown fences, no placeholders, no ellipses in the output.
5. Do not touch authentication, payment, database credentials or infrastructure config. If you cannot merge safely, output only: CANNOT_WRITE_SAFELY`;

/** Extrai o arquivo mesclado de `<updated-code>…</updated-code>` (tolera fim ausente
 *  por truncamento) e reusa o parser de arquivo-inteiro. Exportado para teste. */
export function parseFastApplyOutput(raw: string): LocalEditResult {
  const m = raw.match(/<updated-code>\s*([\s\S]*?)\s*(?:<\/updated-code>|$)/i);
  return interpretWholeFile(m ? m[1] : raw);
}

/**
 * Mescla um `updateSnippet` (o lazy-edit que o modelo já gerou) no arquivo e devolve o
 * arquivo INTEIRO mesclado. Usado quando a fusão por âncora falhou — em vez de escalar.
 * Só vale pra arquivo PEQUENO: a saída precisa caber em maxOutputTokens (o caller gateia).
 */
export async function generateLocalFastApply(
  cfg: SmartExecConfig,
  input: LocalPatchInput,
  updateSnippet: string,
  /** Caminho do modelo DEDICADO de fast-apply (o "morph" próprio). Quando setado, esta
   *  chamada carrega ESSE modelo (sem a LoRA do Forge); ausente → usa o Forge geral. */
  modelPathOverride?: string | null,
): Promise<LocalEditResult> {
  if (!input.fileContent.trim() || !updateSnippet.trim()) return { kind: 'cannot', raw: '' };
  const user = [
    input.instruction ? `INSTRUCTION: ${input.instruction}` : '',
    `\n<code>\n${clampContent(input.fileContent, cfg.local.maxPromptTokens)}\n</code>`,
    `\n<update>\n${updateSnippet}\n</update>`,
    `\nProvide the complete updated code wrapped in <updated-code> … </updated-code>.`,
  ]
    .filter(Boolean)
    .join('\n');
  // Modelo dedicado de fast-apply: roda em PARALELO ao Forge (o runtime cacheia por path,
  // não faz swap) e SEM a LoRA do Forge (já é especialista). idleUnloadSeconds CURTO e
  // por PRESET de memória (economic 6s / moderate 8s / high 15s): é usado em rajadas
  // (quando a âncora falha), então libera RAM rápido após a run — mais rápido em
  // máquina apertada.
  const useCfg: SmartExecConfig = modelPathOverride
    ? {
        ...cfg,
        local: {
          ...cfg.local,
          modelPath: modelPathOverride,
          idleUnloadSeconds: getPerformanceProfile().fastApplyIdleSeconds,
        },
      }
    : cfg;
  // Com o modelo dedicado, o merge roda mesmo com o Forge desligado (kill-switch):
  // fast-apply só mescla código que o premium já escreveu — não é o Forge.
  const opts = modelPathOverride ? { allowWhenDisabled: true } : { loraPath: input.loraPath };
  const out = await llamaChat(useCfg, FAST_APPLY_SYSTEM, user, opts);
  return parseFastApplyOutput(out);
}

export const LINE_EDIT_SYSTEM = `You edit code by choosing WHICH LINES to change, BY NUMBER. The file is shown with a line number and a TAB before each line.

HOW TO RESPOND — one or more edit blocks, NOTHING else:
@@REPLACE a-b
<the new code for lines a..b>
@@END@@
@@INSERT n
<code to insert AFTER line n>
@@END@@

RULES:
1. a, b, n are line numbers FROM THE FILE SHOWN (1-based; b inclusive). Use the SMALLEST range that covers the change.
2. The new code is RAW code only — do NOT include the "number<tab>" prefix.
3. REPLACE ranges must NOT overlap each other. Leave every other line EXACTLY as-is.
4. Output ONLY edit blocks (@@REPLACE/@@INSERT … @@END@@). No prose, no markdown fences.
5. Do not touch authentication, payment, database, security or infrastructure. If you cannot do it safely, output only: CANNOT_WRITE_SAFELY`;

/**
 * Edit ANCORADO POR LINHA — o caminho mais confiável: o modelo recebe o arquivo
 * NUMERADO e responde QUAIS linhas mexer (@@REPLACE a-b / @@INSERT n), sem âncora de
 * texto pra errar. Constrangido pela grammar de linha (formato garantido no decode).
 * O app funde determinístico por nº de linha (applyLineEdits). Retorna os edits
 * parseados; 'cannot' se o modelo não emitiu nenhum bloco válido.
 */
export async function generateLocalLineEdit(
  cfg: SmartExecConfig,
  input: LocalPatchInput,
  /** Override de temperatura (best-of-N por geração: tentativas diversas no MESMO tier). */
  temperature?: number,
): Promise<LocalLineEditResult> {
  if (!input.fileContent.trim()) return { kind: 'cannot', raw: '' };
  const numbered = clampContent(withLineNumbers(input.fileContent), cfg.local.maxPromptTokens);
  const user = [
    input.goal ? `GOAL: ${input.goal}` : '',
    `INSTRUCTION: ${input.instruction}`,
    input.focusHint ? `FOCUS: ${input.focusHint}` : '',
    `\nFILE (numbered) ${input.filePath}:\n${numbered}`,
    `\nRespond with @@REPLACE/@@INSERT blocks targeting the line numbers above.`,
  ]
    .filter(Boolean)
    .join('\n');
  const out = await llamaChat(cfg, LINE_EDIT_SYSTEM, user, {
    lineEditGrammar: true,
    loraPath: input.loraPath,
    ...(temperature !== undefined ? { temperature } : {}),
  });
  const edits = parseLineEdits(out).map((e) => ({
    ...e,
    // Defensivo: se o modelo copiou o prefixo "N<tab>" pra dentro do código novo.
    lines: stripLineNumberPrefixes(e.lines.join('\n')).split('\n'),
  }));
  return edits.length > 0 ? { kind: 'edit', edits, raw: out } : { kind: 'cannot', raw: out };
}

/** Prefixa cada linha com seu nº (1-based) — ajuda o modelo a copiar EXATO. */
function withLineNumbers(content: string): string {
  return content
    .split('\n')
    .map((l, i) => `${i + 1}\t${l}`)
    .join('\n');
}

/**
 * Desfaz o `withLineNumbers` no edit que o modelo devolve: o Forge (modelo
 * pequeno) às vezes COPIA o prefixo `N<tab>`/`N ` da linha numerada pra dentro da
 * âncora — daí ela vira "3<tab>}" em vez de "}", a fusão por âncora não casa e a
 * issue escala à toa. Tira só esse prefixo de início de linha; o resto da
 * tolerância de whitespace fica com normAnchor no merge. Seguro: linha de código
 * de verdade não começa com dígitos colados num tab (a indentação vem antes).
 */
function stripLineNumberPrefixes(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^\d+\t/, '').replace(/^\d+ {1,}(?=\S)/, ''))
    .join('\n');
}

/**
 * Retry CORRETIVO quando o modelo NÃO emitiu nenhum bloco no formato. Reenfatiza
 * o contrato e reinclui o arquivo. Não escreve nada — só gera texto; o app
 * decide aplicar (com as mesmas garantias de morph) ou escalar.
 */
export async function generateLocalEditNoBlocksRetry(
  cfg: SmartExecConfig,
  input: LocalPatchInput,
): Promise<LocalEditResult> {
  const user = [
    'You did NOT respond in the right format. Respond ONLY with the lazy edit: the changed',
    'snippets + the "// ... existing code ..." line for the rest. No prose, no markdown.',
    'Each snippet starts and ends with a line that EXISTS in the file (the anchor).',
    input.goal ? `GOAL: ${input.goal}` : '',
    `INSTRUCTION: ${input.instruction}`,
    input.contextPack
      ? `\nORKestral RAG CONTEXT (use only when relevant):\n${input.contextPack}`
      : '',
    `\nHere is the file again (${input.filePath}):`,
    clampContent(input.fileContent, cfg.local.maxPromptTokens),
    `\nRespond with ONLY the lazy edit for ${input.filePath}.`,
  ]
    .filter(Boolean)
    .join('\n');
  const out = await llamaChat(cfg, EDIT_SYSTEM, user, { loraPath: input.loraPath });
  return interpret(out);
}

/**
 * Retry CORRETIVO quando o SEARCH de um bloco NÃO casou com o arquivo (whitespace
 * /aspas/conteúdo novo no lugar do existente). Mostra o arquivo COM números de
 * linha e o erro específico, e exige cópia exata das linhas existentes. Não
 * escreve nada — só gera texto; aplicação/segurança seguem em morph.
 */
export async function generateLocalEditNoMatchRetry(
  cfg: SmartExecConfig,
  input: LocalPatchInput,
  matchError: string,
): Promise<LocalEditResult> {
  const user = [
    'The ANCHORS in your edit did not match the file. The 1st and last line of each',
    'snippet must be an EXACT copy of lines that EXIST in the file (without changing',
    'whitespace/quotes). Use the real lines below (without the number) as anchors and keep',
    'the new code ONLY in the middle of the snippet.',
    `\nFAILURE REASON: ${matchError.slice(0, 500)}`,
    input.goal ? `GOAL: ${input.goal}` : '',
    `INSTRUCTION: ${input.instruction}`,
    input.contextPack
      ? `\nORKestral RAG CONTEXT (use only when relevant):\n${input.contextPack}`
      : '',
    `\nCURRENT FILE with line numbers (${input.filePath}) — copy the EXACT lines (without the number):`,
    clampContent(withLineNumbers(input.fileContent), cfg.local.maxPromptTokens),
    `\nRespond with ONLY the corrected lazy edit for ${input.filePath}.`,
  ]
    .filter(Boolean)
    .join('\n');
  const out = await llamaChat(cfg, EDIT_SYSTEM, user, { loraPath: input.loraPath });
  const res = interpret(out);
  // O arquivo foi mostrado COM números de linha; tira o prefixo "N<tab>"/"N " que
  // o modelo às vezes copia pra dentro da âncora (evita o merge falhar à toa).
  return res.kind === 'edit' ? { ...res, update: stripLineNumberPrefixes(res.update) } : res;
}

export async function generateLocalEditFix(
  cfg: SmartExecConfig,
  input: LocalPatchInput,
  validationError: string,
): Promise<LocalEditResult> {
  const user = [
    'The previous edit failed validation. Fix it and respond again with the lazy',
    'edit (snippets with real anchors + "// ... existing code ...").',
    input.goal ? `GOAL: ${input.goal}` : '',
    `INSTRUCTION: ${input.instruction}`,
    input.contextPack
      ? `\nORKestral RAG CONTEXT (use only when relevant):\n${input.contextPack}`
      : '',
    `\nVALIDATION ERROR:\n${validationError.slice(0, 1500)}`,
    `\nCURRENT FILE (${input.filePath}):`,
    clampContent(input.fileContent, cfg.local.maxPromptTokens),
    `\nRespond with the corrected lazy edit for ${input.filePath}.`,
  ]
    .filter(Boolean)
    .join('\n');
  const out = await llamaChat(cfg, EDIT_SYSTEM, user, { loraPath: input.loraPath });
  return interpret(out);
}
