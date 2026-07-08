/**
 * Motor v2: o loop de execucao de UM checkbox.
 *
 * Amarra o validador de import + o compilador no loop num ciclo unico:
 *   gera -> valida import -> compila (overlay) -> vermelho? realimenta e regenera -> verde: pronto.
 *
 * O modelo fica atras da interface `GenerateFn`, entao o loop e testavel sem GPU e o mesmo
 * codigo serve pro Forge local de verdade depois. O checkbox so "fica verde" quando o
 * codigo passou import + typecheck. Verde = prova, nao afirmacao.
 *
 * Ver docs/MOTOR-FATIAS-VERTICAIS.md, secoes 4 e 5.
 */
import { validateImports, type ImportViolation } from './import-validator';
import {
  typecheckProject,
  formatDiagnosticsForModel,
  hasCodeSubstance,
  type CompilerDiagnostic,
} from './compiler-check';
import { auditUiUsage, type DesignContract } from './design-system';

export interface Checkbox {
  id: string;
  /** Instrucao curta do passo (vem da checklist que o premium escreveu). */
  instruction: string;
  /** Caminho absoluto do arquivo que esse checkbox produz/altera. */
  targetFile: string;
  done: boolean;
}

export interface GenerateInput {
  instruction: string;
  targetFile: string;
  /** Conteudo atual do arquivo no disco (null se for novo). */
  currentCode: string | null;
  /** Feedback do erro da tentativa anterior (null na primeira). */
  feedback: string | null;
  attempt: number;
  /** ATERRA (secao 4.1): componentes do design system congelado que ele DEVE compor. */
  availableComponents?: string[];
  /** ATERRA: arquivos que ja existem no projeto (pra importar dos certos, nao inventar). */
  existingFiles?: string[];
}

export interface GenerateOutput {
  code: string;
  /** Tokens gastos pelo modelo local nessa geracao (pra contabilidade premium vs local). */
  tokensLocal: number;
}

export type GenerateFn = (input: GenerateInput) => Promise<GenerateOutput>;

export type CheckboxFailureStage = 'import' | 'design' | 'typecheck' | 'exhausted';

export interface ExecuteCheckboxResult {
  ok: boolean;
  attempts: number;
  /** Codigo final aprovado (pronto pra escrever + commitar) quando ok. */
  finalCode: string | null;
  /** Em que estagio falhou na ultima tentativa (quando !ok). */
  failedAt: CheckboxFailureStage | null;
  /** Ultimas violacoes de import (quando a falha foi de import). */
  violations: ImportViolation[];
  /** Ultimos diagnosticos do compilador (quando a falha foi de typecheck). */
  diagnostics: CompilerDiagnostic[];
  /** Total de tokens locais gastos nas tentativas. */
  tokensLocal: number;
  /** Trilha das tentativas, pro snapshot compacto que vai pro premium no checkpoint. */
  trail: string[];
}

export interface ExecuteCheckboxInput {
  checkbox: Checkbox;
  projectRoot: string;
  generate: GenerateFn;
  /** Le o estado atual do arquivo no disco (null se nao existe). */
  readFile: (absPath: string) => string | null;
  maxAttempts?: number;
  /** Contrato de design congelado: se passado, output que viola o kit e rejeitado. */
  designContract?: DesignContract;
  /** ATERRA: componentes do kit pra compor + arquivos existentes (passados ao generate). */
  availableComponents?: string[];
  existingFiles?: string[];
}

function formatViolationsForModel(violations: ImportViolation[]): string {
  return violations.map((v) => `- import "${v.source}": ${v.detail}`).join('\n');
}

/**
 * Executa o ciclo de um checkbox ate verde ou esgotar as tentativas. Quando esgota, o
 * chamador escala SO esse checkbox pro premium (cirurgico), com `trail` + `failedAt` de
 * contexto. Nunca escreve no disco: devolve `finalCode` pro orquestrador aplicar e commitar.
 */
export async function executeCheckbox(input: ExecuteCheckboxInput): Promise<ExecuteCheckboxResult> {
  const {
    checkbox,
    projectRoot,
    generate,
    readFile,
    maxAttempts = 4,
    designContract,
    availableComponents,
    existingFiles,
  } = input;
  const currentCode = readFile(checkbox.targetFile);
  let feedback: string | null = null;
  let tokensLocal = 0;
  const trail: string[] = [];
  let lastViolations: ImportViolation[] = [];
  let lastDiagnostics: CompilerDiagnostic[] = [];
  let failedAt: CheckboxFailureStage | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const gen = await generate({
      instruction: checkbox.instruction,
      targetFile: checkbox.targetFile,
      currentCode,
      feedback,
      attempt,
      availableComponents,
      existingFiles,
    });
    tokensLocal += gen.tokensLocal;

    // Os gates de import/design/typecheck so fazem sentido pra TS/TSX. Arquivos nao-TS
    // (package.json, tsconfig.json, .css, .md) sao aceitos direto (nao ha o que compilar).
    const isTs = /\.(ts|tsx|mts|cts)$/.test(checkbox.targetFile);
    if (!isTs) {
      trail.push(`attempt ${attempt}: green (non-TS file, no compiler gate)`);
      return {
        ok: true,
        attempts: attempt,
        finalCode: gen.code,
        failedAt: null,
        violations: [],
        diagnostics: [],
        tokensLocal,
        trail,
      };
    }

    // 0) substancia: arquivo vazio / so string / so comentario nao conta como feito.
    if (!hasCodeSubstance(gen.code)) {
      lastViolations = [];
      lastDiagnostics = [];
      failedAt = 'typecheck';
      feedback =
        'The previous attempt produced a trivial file (empty, just a string, or just a comment). ' +
        'Generate the real code the task asks for.';
      trail.push(`attempt ${attempt}: rejected (file without substance)`);
      continue;
    }

    // 1) rede anti-alucinacao: import fantasma nem chega ao compilador.
    const violations = validateImports({
      filePath: checkbox.targetFile,
      code: gen.code,
      projectRoot,
    });
    if (violations.length > 0) {
      lastViolations = violations;
      lastDiagnostics = [];
      failedAt = 'import';
      feedback =
        `The previous attempt used imports that do not exist. Fix:\n` +
        formatViolationsForModel(violations);
      trail.push(
        `attempt ${attempt}: rejected (phantom import: ${violations.map((v) => v.source).join(', ')})`,
      );
      continue;
    }

    // 1b) gate de design: nao pode introduzir UI nova nem usar componente fora do kit.
    if (designContract) {
      const uiv = auditUiUsage(gen.code, designContract);
      if (uiv.length > 0) {
        lastViolations = [];
        lastDiagnostics = [];
        failedAt = 'design';
        feedback =
          `The previous attempt violated the design system. Use only the frozen kit. Fix:\n` +
          uiv.map((u) => `- "${u.source}": ${u.detail}`).join('\n');
        trail.push(`attempt ${attempt}: rejected (design: ${uiv.map((u) => u.source).join(', ')})`);
        continue;
      }
    }

    // 2) compilador no loop: typecheck do PROJETO INTEIRO via overlay (sem onlyFiles, pra
    // pegar quebra em cascata em outros arquivos, nao so o tocado).
    const tc = typecheckProject({
      projectRoot,
      overlay: { [checkbox.targetFile]: gen.code },
    });
    if (!tc.ok) {
      lastDiagnostics = tc.diagnostics;
      lastViolations = [];
      failedAt = 'typecheck';
      feedback =
        `The previous attempt did not compile. Fix the errors:\n` +
        formatDiagnosticsForModel(tc.diagnostics);
      trail.push(`attempt ${attempt}: rejected (typecheck: ${tc.diagnostics.length} error(s))`);
      continue;
    }

    // verde: passou import + typecheck.
    trail.push(`attempt ${attempt}: green`);
    return {
      ok: true,
      attempts: attempt,
      finalCode: gen.code,
      failedAt: null,
      violations: [],
      diagnostics: [],
      tokensLocal,
      trail,
    };
  }

  // esgotou: escala esse checkbox pro premium.
  return {
    ok: false,
    attempts: maxAttempts,
    finalCode: null,
    failedAt: failedAt ?? 'exhausted',
    violations: lastViolations,
    diagnostics: lastDiagnostics,
    tokensLocal,
    trail,
  };
}
