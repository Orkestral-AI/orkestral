/**
 * Motor v2: validador de import (rede anti-alucinacao).
 *
 * Dado um trecho de codigo PROPOSTO (ainda nao escrito no disco), confere que TODO import
 * resolve pra um modulo real e que TODO symbol nomeado existe de fato no modulo. Barra os
 * dois modos de falha que afundaram o chatbot_v3:
 *   1. modulo inventado            -> `@trello/use-workspace-delete-dialog-cancel-mutation`
 *   2. export inexistente          -> `import { Label } from "@base-ui/react"` (nao exporta Label)
 *
 * E deterministico (sem modelo), entao o loop de execucao chama isso ANTES de aplicar a
 * edicao: violou, rejeita e regenera. O Forge fica incapaz de shipar import fantasma.
 *
 * Ver docs/MOTOR-FATIAS-VERTICAIS.md, secao 4 (loop de execucao por checkbox).
 */
import * as ts from 'typescript';
import * as path from 'node:path';

export type ImportViolationKind = 'unresolved-module' | 'missing-export';

export interface ImportViolation {
  /** O specifier do modulo, ex: "@base-ui/react" ou "@/lib/validate". */
  source: string;
  kind: ImportViolationKind;
  /** Mensagem legivel pro humano E pro modelo (vai no feedback de regeneracao). */
  detail: string;
  /** Quando kind === 'missing-export', os nomes que nao existem no modulo. */
  missingExports?: string[];
}

export interface ValidateImportsInput {
  /** Caminho absoluto do arquivo sendo validado (define a base de resolucao relativa). */
  filePath: string;
  /** O codigo proposto (pode ainda nao estar no disco). */
  code: string;
  /** Raiz do projeto alvo (tem package.json, tsconfig.json, node_modules). */
  projectRoot: string;
}

interface ParsedImport {
  source: string;
  /** Nomes importados nomeadamente: `import { A, B as C }` -> ['A','B']. */
  named: string[];
  hasDefault: boolean;
  /** `import * as X` -> nao checa export nomeado (uso e validado depois). */
  namespace: boolean;
}

/** Extrai os imports estaticos do codigo via AST (robusto, nao regex). */
function parseImports(code: string, fileName: string): ParsedImport[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: ParsedImport[] = [];

  const collect = (source: string, clause?: ts.ImportClause) => {
    const named: string[] = [];
    let hasDefault = false;
    let namespace = false;
    if (clause) {
      if (clause.name) hasDefault = true;
      const b = clause.namedBindings;
      if (b && ts.isNamespaceImport(b)) namespace = true;
      if (b && ts.isNamedImports(b)) {
        for (const el of b.elements) {
          // `B as C` -> o nome real importado e propertyName (B); senao o proprio name.
          named.push((el.propertyName ?? el.name).text);
        }
      }
    }
    out.push({ source, named, hasDefault, namespace });
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      collect(node.moduleSpecifier.text, node.importClause);
    }
    // `export { x } from '...'` re-exporta de um modulo: tambem pode alucinar.
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const named: string[] = [];
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          named.push((el.propertyName ?? el.name).text);
        }
      }
      out.push({ source: node.moduleSpecifier.text, named, hasDefault: false, namespace: false });
    }
    // import('x') dinamico e require('x') tambem alucinam modulo: valida a resolucao.
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const isDynImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynImport || isRequire) {
        out.push({
          source: node.arguments[0].text,
          named: [],
          hasDefault: false,
          namespace: false,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Carrega as compilerOptions do tsconfig do projeto (pega paths/baseUrl pro `@/...`). */
function loadCompilerOptions(projectRoot: string): ts.CompilerOptions {
  const cfgPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!cfgPath) {
    return {
      baseUrl: projectRoot,
      allowJs: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
  }
  const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, path.dirname(cfgPath));
  return parsed.options;
}

/** Os builtins do Node nao tem .d.ts resolvivel por padrao; nao sao alucinacao. */
const NODE_BUILTINS = new Set(
  [
    'fs',
    'path',
    'os',
    'crypto',
    'http',
    'https',
    'url',
    'util',
    'stream',
    'events',
    'buffer',
    'child_process',
    'net',
    'tls',
    'zlib',
    'querystring',
    'assert',
    'process',
  ].flatMap((m) => [m, `node:${m}`]),
);

/** Cache de exports por arquivo resolvido (Program e caro; nao refaz por import). */
const exportsCache = new Map<string, Set<string>>();

function getModuleExports(resolvedFileName: string, options: ts.CompilerOptions): Set<string> {
  const cached = exportsCache.get(resolvedFileName);
  if (cached) return cached;
  const program = ts.createProgram([resolvedFileName], { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(resolvedFileName);
  const names = new Set<string>();
  if (sf) {
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (moduleSymbol) {
      for (const exp of checker.getExportsOfModule(moduleSymbol)) names.add(exp.getName());
    }
  }
  exportsCache.set(resolvedFileName, names);
  return names;
}

/**
 * Valida os imports de um codigo proposto contra o estado real do projeto.
 * Retorna a lista de violacoes (vazia = limpo). Nunca lanca: erro de infra vira [].
 */
export function validateImports(input: ValidateImportsInput): ImportViolation[] {
  const { filePath, code, projectRoot } = input;
  const violations: ImportViolation[] = [];
  let options: ts.CompilerOptions;
  try {
    options = loadCompilerOptions(projectRoot);
  } catch {
    return [];
  }
  const host = ts.createCompilerHost(options);
  const imports = parseImports(code, filePath);

  for (const imp of imports) {
    if (NODE_BUILTINS.has(imp.source)) continue;

    const resolved = ts.resolveModuleName(imp.source, filePath, options, host);
    const mod = resolved.resolvedModule;

    if (!mod) {
      violations.push({
        source: imp.source,
        kind: 'unresolved-module',
        detail:
          `o modulo "${imp.source}" nao existe no projeto (nao esta no package.json nem e ` +
          `um arquivo local). Use um pacote instalado de verdade ou um caminho que exista.`,
      });
      continue;
    }

    // So checa export nomeado quando ha named imports e o alvo tem .d.ts utilizavel.
    if (imp.named.length > 0 && !imp.namespace) {
      let exportsSet: Set<string>;
      try {
        exportsSet = getModuleExports(mod.resolvedFileName, options);
      } catch {
        continue; // sem declaracoes legiveis: nao acusa falso positivo.
      }
      if (exportsSet.size === 0) continue; // nao deu pra ler exports: nao acusa.
      const missing = imp.named.filter((n) => !exportsSet.has(n));
      if (missing.length > 0) {
        violations.push({
          source: imp.source,
          kind: 'missing-export',
          detail:
            `o modulo "${imp.source}" nao exporta ${missing.map((m) => `"${m}"`).join(', ')}. ` +
            `Exports validos incluem: ${[...exportsSet].slice(0, 12).join(', ')}.`,
          missingExports: missing,
        });
      }
    }
  }
  return violations;
}

/** Limpa o cache de exports (usar quando o node_modules do projeto muda). */
export function clearImportValidatorCache(): void {
  exportsCache.clear();
}
