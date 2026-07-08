/**
 * Motor v2: compilador no loop.
 *
 * Roda o typecheck do TypeScript sobre o projeto, com a opcao de **sobrepor** arquivos em
 * memoria (overlay) pra checar uma mudanca PROPOSTA antes de escrever no disco. Devolve os
 * diagnosticos estruturados (arquivo, linha, mensagem) pra realimentar o modelo no loop:
 * vermelho -> erro volta pro modelo, corrige, repete; verde -> marca o checkbox.
 *
 * Complementa o validador de import (import-validator.ts): o validador pega import fantasma
 * cedo e barato; o typecheck pega o resto (tipo errado, symbol inexistente em uso, etc).
 *
 * Ver docs/MOTOR-FATIAS-VERTICAIS.md, secao 4.
 */
import * as ts from 'typescript';
import * as path from 'node:path';

export interface CompilerDiagnostic {
  /** Caminho do arquivo (absoluto) ou null pra erro global. */
  file: string | null;
  /** Linha 1-based, ou null. */
  line: number | null;
  /** Codigo TSxxxx. */
  code: number;
  message: string;
}

export interface TypecheckInput {
  /** Raiz do projeto alvo (tem tsconfig.json). */
  projectRoot: string;
  /**
   * Overlay de arquivos PROPOSTOS: caminho absoluto -> conteudo. Sobrepoe o disco durante
   * a checagem (nao escreve nada). Use pra validar uma edicao antes de aplicar.
   */
  overlay?: Record<string, string>;
  /**
   * Se passado, filtra os diagnosticos pros arquivos tocados (caminhos absolutos). Mantem
   * o feedback enxuto e focado na mudanca do checkbox.
   */
  onlyFiles?: string[];
}

export interface TypecheckResult {
  ok: boolean;
  diagnostics: CompilerDiagnostic[];
}

function loadParsedConfig(projectRoot: string): ts.ParsedCommandLine {
  const cfgPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!cfgPath) {
    return {
      options: {
        noEmit: true,
        skipLibCheck: true,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      fileNames: [],
      errors: [],
    };
  }
  const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, path.dirname(cfgPath));
}

/** Normaliza um caminho pra comparacao estavel entre disco e overlay. */
function norm(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}

/**
 * Roda o typecheck. Nunca lanca: erro de infra vira ok=false com um diagnostico global.
 * skipLibCheck e forcado pra nao acusar erro dentro de .d.ts de libs (foco e o codigo do projeto).
 */
export function typecheckProject(input: TypecheckInput): TypecheckResult {
  const { projectRoot, overlay = {}, onlyFiles } = input;
  let parsed: ts.ParsedCommandLine;
  try {
    parsed = loadParsedConfig(projectRoot);
  } catch (e) {
    return {
      ok: false,
      diagnostics: [{ file: null, line: null, code: 0, message: `config: ${String(e)}` }],
    };
  }

  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, skipLibCheck: true };
  const overlayNorm = new Map<string, string>();
  for (const [k, v] of Object.entries(overlay)) overlayNorm.set(norm(k), v);

  // Garante que os arquivos do overlay entrem no Program mesmo se forem novos (nao no disco).
  const rootNames = Array.from(new Set([...parsed.fileNames.map(norm), ...overlayNorm.keys()]));

  const host = ts.createCompilerHost(options, true);
  const realGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const ov = overlayNorm.get(norm(fileName));
    if (ov !== undefined) {
      return ts.createSourceFile(fileName, ov, languageVersion, true, ts.ScriptKind.TSX);
    }
    return realGetSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  const realReadFile = host.readFile.bind(host);
  host.readFile = (fileName) => overlayNorm.get(norm(fileName)) ?? realReadFile(fileName);
  const realFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => overlayNorm.has(norm(fileName)) || realFileExists(fileName);

  let program: ts.Program;
  try {
    program = ts.createProgram(rootNames, options, host);
  } catch (e) {
    return {
      ok: false,
      diagnostics: [{ file: null, line: null, code: 0, message: `program: ${String(e)}` }],
    };
  }

  const raw = ts.getPreEmitDiagnostics(program);
  const onlySet = onlyFiles ? new Set(onlyFiles.map(norm)) : null;

  const diagnostics: CompilerDiagnostic[] = [];
  for (const d of raw) {
    const fileName = d.file ? norm(d.file.fileName) : null;
    if (onlySet && (!fileName || !onlySet.has(fileName))) continue;
    let line: number | null = null;
    if (d.file && typeof d.start === 'number') {
      line = d.file.getLineAndCharacterOfPosition(d.start).line + 1;
    }
    diagnostics.push({
      file: fileName,
      line,
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    });
  }

  return { ok: diagnostics.length === 0, diagnostics };
}

/**
 * Um arquivo TS "compila" mas e VAZIO de verdade quando nao tem statement, ou so tem
 * string/template solta, ou so comentario. O typecheck deixa isso passar como verde (P0).
 */
export function hasCodeSubstance(code: string): boolean {
  const sf = ts.createSourceFile('x.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (sf.statements.length === 0) return false;
  const allTrivial = sf.statements.every((s) => {
    if (ts.isExpressionStatement(s)) {
      const e = s.expression;
      return (
        ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)
      );
    }
    return false;
  });
  return !allTrivial;
}

/** Formata os diagnosticos num bloco curto pra realimentar o modelo no loop. */
export function formatDiagnosticsForModel(diagnostics: CompilerDiagnostic[]): string {
  if (diagnostics.length === 0) return 'build verde, sem erros.';
  return diagnostics
    .slice(0, 12)
    .map((d) => {
      const loc = d.file ? `${path.basename(d.file)}${d.line ? `:${d.line}` : ''}` : 'global';
      return `- ${loc}: TS${d.code} ${d.message}`;
    })
    .join('\n');
}
