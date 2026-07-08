import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting, StreamLanguage } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
// --- pacotes oficiais (LanguageSupport) ---
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { php } from '@codemirror/lang-php';
import { java } from '@codemirror/lang-java';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { go } from '@codemirror/lang-go';
import { vue } from '@codemirror/lang-vue';
// --- legacy stream modes (@codemirror/legacy-modes) ---
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { r } from '@codemirror/legacy-modes/mode/r';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { kotlin, scala, csharp, dart, objectiveC } from '@codemirror/legacy-modes/mode/clike';
import { oCaml, fSharp } from '@codemirror/legacy-modes/mode/mllike';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { clojure } from '@codemirror/legacy-modes/mode/clojure';
import { commonLisp } from '@codemirror/legacy-modes/mode/commonlisp';
import { scheme } from '@codemirror/legacy-modes/mode/scheme';
import { erlang } from '@codemirror/legacy-modes/mode/erlang';
import { elm } from '@codemirror/legacy-modes/mode/elm';
import { groovy } from '@codemirror/legacy-modes/mode/groovy';
import { pascal } from '@codemirror/legacy-modes/mode/pascal';
import { fortran } from '@codemirror/legacy-modes/mode/fortran';
import { julia } from '@codemirror/legacy-modes/mode/julia';
import { crystal } from '@codemirror/legacy-modes/mode/crystal';
import { d } from '@codemirror/legacy-modes/mode/d';
import { vb } from '@codemirror/legacy-modes/mode/vb';
import { vbScript } from '@codemirror/legacy-modes/mode/vbscript';
import { tcl } from '@codemirror/legacy-modes/mode/tcl';
import { verilog } from '@codemirror/legacy-modes/mode/verilog';
import { vhdl } from '@codemirror/legacy-modes/mode/vhdl';
import { pug } from '@codemirror/legacy-modes/mode/pug';
import { jinja2 } from '@codemirror/legacy-modes/mode/jinja2';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { mathematica } from '@codemirror/legacy-modes/mode/mathematica';
import { octave } from '@codemirror/legacy-modes/mode/octave';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
import { textile } from '@codemirror/legacy-modes/mode/textile';
import { turtle } from '@codemirror/legacy-modes/mode/turtle';
import { sparql } from '@codemirror/legacy-modes/mode/sparql';
import { cypher } from '@codemirror/legacy-modes/mode/cypher';
import { http } from '@codemirror/legacy-modes/mode/http';
import { gas } from '@codemirror/legacy-modes/mode/gas';
import { z80 } from '@codemirror/legacy-modes/mode/z80';
import { wast } from '@codemirror/legacy-modes/mode/wast';
import { xQuery } from '@codemirror/legacy-modes/mode/xquery';
import { smalltalk } from '@codemirror/legacy-modes/mode/smalltalk';
import { liveScript } from '@codemirror/legacy-modes/mode/livescript';
import { sass } from '@codemirror/legacy-modes/mode/sass';
import { stylus } from '@codemirror/legacy-modes/mode/stylus';
import { coffeeScript } from '@codemirror/legacy-modes/mode/coffeescript';
import type { Extension } from '@codemirror/state';
import type { CodeThemeColors } from '@renderer/lib/codeThemes';

// Parser mínimo de .env: COMENTA (#...), CHAVE=, e valor. Dá cor real às 3 partes.
const dotenvLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^#.*/)) return 'comment';
    if (stream.sol() && stream.match(/^(export\s+)?[A-Za-z_][A-Za-z0-9_.]*/)) return 'def';
    if (stream.match(/^=/)) return 'operator';
    if (stream.match(/^"(?:[^"\\]|\\.)*"/) || stream.match(/^'(?:[^'\\]|\\.)*'/)) return 'string';
    if (stream.match(/^[^\s#]+/)) return 'string';
    stream.next();
    return null;
  },
});

/** Constrói as extensões de tema (UI + highlight) do CodeMirror a partir dos
 *  tokens do tema ativo do app. */
export function buildCmTheme(c: CodeThemeColors): Extension {
  const view = EditorView.theme(
    {
      // height 100% + scroller overflow:auto fazem o editor preencher o container
      // flex e rolar internamente (sem isso o conteúdo cresce e não gera scroll).
      // Fundo transparente de propósito: o editor herda o fundo do card do app
      // (--color-background), unificando sidebar + busca + editor num tom só. O tema
      // de código segue mandando na SINTAXE (c.fg + highlight), não no fundo.
      '&': { backgroundColor: 'transparent', color: c.fg, height: '100%' },
      '.cm-content': { caretColor: c.fg },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.fg },
      '.cm-gutters': { backgroundColor: 'transparent', color: c.lineNum, border: 'none' },
      '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)' },
      '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(120,150,255,0.25)' },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(120,150,255,0.3)' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
    },
    { dark: true },
  );

  const highlight = HighlightStyle.define([
    // comentários / meta
    {
      tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
      color: c.comment,
      fontStyle: 'italic',
    },
    { tag: [t.meta, t.processingInstruction, t.documentMeta], color: c.comment },
    // keywords / controle / modificadores
    {
      tag: [
        t.keyword,
        t.controlKeyword,
        t.operatorKeyword,
        t.definitionKeyword,
        t.moduleKeyword,
        t.modifier,
        t.self,
      ],
      color: c.keyword,
    },
    // strings / regex / char / escapes
    {
      tag: [t.string, t.special(t.string), t.docString, t.character, t.regexp, t.escape],
      color: c.string,
    },
    // números / constantes / atoms / booleans
    { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit], color: c.number },
    // funções / labels
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName],
      color: c.function,
    },
    // variáveis / propriedades / atributos / definições (cobre key de .env/properties)
    {
      tag: [
        t.variableName,
        t.propertyName,
        t.attributeName,
        t.definition(t.variableName),
        t.definition(t.propertyName),
        t.definition(t.name),
      ],
      color: c.variable,
    },
    // tipos / classes / namespaces / tags / annotations
    {
      tag: [
        t.typeName,
        t.className,
        t.namespace,
        t.tagName,
        t.annotation,
        t.typeOperator,
        t.standard(t.tagName),
      ],
      color: c.type,
    },
    // headings/links de markdown
    { tag: [t.heading, t.strong], color: c.keyword, fontWeight: 'bold' },
    { tag: [t.link, t.url], color: c.function },
    { tag: t.emphasis, fontStyle: 'italic' },
    // pontuação/operadores: deixa na cor base (fg) — não mapear
  ]);

  return [view, syntaxHighlighting(highlight)];
}

/**
 * Mapas de resolução de linguagem (data-driven). Cada valor é uma factory
 * lazy `() => Extension` para que toda chamada de `languageForPath` produza
 * uma extensão nova (igual ao padrão de `javascript()` chamado por arquivo).
 */

/** Açúcar para encurtar os muitos `StreamLanguage.define(...)`. */
const sl = (mode: Parameters<typeof StreamLanguage.define>[0]) => () => StreamLanguage.define(mode);

/**
 * Resolução por NOME de arquivo (sem extensão usável, ou extensão irrelevante).
 * Conferido antes do mapa por extensão.
 */
const BY_NAME: Record<string, () => Extension> = {
  dockerfile: sl(dockerFile),
  // Gerenciadores Ruby / DSLs em Ruby sem extensão.
  gemfile: sl(ruby),
  rakefile: sl(ruby),
  podfile: sl(ruby),
  brewfile: sl(ruby),
  vagrantfile: sl(ruby),
  // Arquivos de shell sem extensão.
  '.bashrc': sl(shell),
  '.zshrc': sl(shell),
  '.bash_profile': sl(shell),
  '.profile': sl(shell),
  '.zshenv': sl(shell),
  '.bash_aliases': sl(shell),
  // Configs estilo KEY=value / INI.
  '.gitconfig': sl(properties),
  '.editorconfig': sl(properties),
  '.npmrc': sl(properties),
  '.yarnrc': sl(properties),
  // Nginx por nome de arquivo comum.
  'nginx.conf': sl(nginx),
};

/**
 * Resolução por EXTENSÃO (a cauda longa). Pacotes oficiais quando existem,
 * legacy stream modes para o resto.
 */
const BY_EXT: Record<string, () => Extension> = {
  // --- pacotes oficiais (LanguageSupport) ---
  js: () => javascript({ jsx: true }),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript({ jsx: true }),
  cjs: () => javascript({ jsx: true }),
  es6: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  jsonc: () => json(),
  json5: () => json(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  html: () => html(),
  htm: () => html(),
  xhtml: () => html(),
  vue: () => vue(),
  py: () => python(),
  pyw: () => python(),
  pyi: () => python(),
  md: () => markdown(),
  markdown: () => markdown(),
  mdx: () => markdown(),
  sql: () => sql(),
  mysql: () => sql(),
  pgsql: () => sql(),
  ddl: () => sql(),
  yaml: () => yaml(),
  yml: () => yaml(),
  xml: () => xml(),
  svg: () => xml(),
  xsd: () => xml(),
  xsl: () => xml(),
  xslt: () => xml(),
  plist: () => xml(),
  rss: () => xml(),
  wsdl: () => xml(),
  storyboard: () => xml(),
  php: () => php(),
  phtml: () => php(),
  php5: () => php(),
  php7: () => php(),
  java: () => java(),
  rs: () => rust(),
  c: () => cpp(),
  h: () => cpp(),
  cpp: () => cpp(),
  cc: () => cpp(),
  cxx: () => cpp(),
  'c++': () => cpp(),
  hpp: () => cpp(),
  hh: () => cpp(),
  hxx: () => cpp(),
  ino: () => cpp(),
  go: () => go(),

  // --- legacy stream modes ---
  sh: sl(shell),
  bash: sl(shell),
  zsh: sl(shell),
  fish: sl(shell),
  ksh: sl(shell),
  toml: sl(toml),
  ini: sl(properties),
  conf: sl(properties),
  cfg: sl(properties),
  cnf: sl(properties),
  properties: sl(properties),
  prefs: sl(properties),
  rb: sl(ruby),
  rake: sl(ruby),
  gemspec: sl(ruby),
  ru: sl(ruby),
  pl: sl(perl),
  pm: sl(perl),
  pod: sl(perl),
  lua: sl(lua),
  r: sl(r),
  swift: sl(swift),
  ps1: sl(powerShell),
  psm1: sl(powerShell),
  psd1: sl(powerShell),
  kt: sl(kotlin),
  kts: sl(kotlin),
  scala: sl(scala),
  sc: sl(scala),
  cs: sl(csharp),
  csx: sl(csharp),
  dart: sl(dart),
  mm: sl(objectiveC),
  diff: sl(diff),
  patch: sl(diff),
  sass: sl(sass),
  styl: sl(stylus),
  coffee: sl(coffeeScript),
  hs: sl(haskell),
  lhs: sl(haskell),
  clj: sl(clojure),
  cljs: sl(clojure),
  cljc: sl(clojure),
  edn: sl(clojure),
  lisp: sl(commonLisp),
  cl: sl(commonLisp),
  el: sl(commonLisp),
  lsp: sl(commonLisp),
  scm: sl(scheme),
  ss: sl(scheme),
  rkt: sl(scheme),
  erl: sl(erlang),
  hrl: sl(erlang),
  elm: sl(elm),
  ml: sl(oCaml),
  mli: sl(oCaml),
  fs: sl(fSharp),
  fsi: sl(fSharp),
  fsx: sl(fSharp),
  groovy: sl(groovy),
  gradle: sl(groovy),
  gvy: sl(groovy),
  pas: sl(pascal),
  pp: sl(pascal),
  f: sl(fortran),
  for: sl(fortran),
  f90: sl(fortran),
  f95: sl(fortran),
  f03: sl(fortran),
  jl: sl(julia),
  cr: sl(crystal),
  d: sl(d),
  vb: sl(vb),
  bas: sl(vb),
  vbs: sl(vbScript),
  tcl: sl(tcl),
  v: sl(verilog),
  sv: sl(verilog),
  svh: sl(verilog),
  vhd: sl(vhdl),
  vhdl: sl(vhdl),
  pug: sl(pug),
  jade: sl(pug),
  j2: sl(jinja2),
  jinja: sl(jinja2),
  jinja2: sl(jinja2),
  tex: sl(stex),
  latex: sl(stex),
  sty: sl(stex),
  cls: sl(stex),
  ltx: sl(stex),
  nb: sl(mathematica),
  wl: sl(mathematica),
  wls: sl(mathematica),
  m: sl(octave),
  mat: sl(octave),
  proto: sl(protobuf),
  textile: sl(textile),
  ttl: sl(turtle),
  rq: sl(sparql),
  sparql: sl(sparql),
  cyp: sl(cypher),
  cypher: sl(cypher),
  http: sl(http),
  asm: sl(gas),
  s: sl(gas),
  z80: sl(z80),
  wat: sl(wast),
  wast: sl(wast),
  xq: sl(xQuery),
  xqy: sl(xQuery),
  xquery: sl(xQuery),
  xqm: sl(xQuery),
  st: sl(smalltalk),
  ls: sl(liveScript),
};

/** Escolhe a extensão de linguagem do CodeMirror pela extensão (ou nome) do
 *  arquivo. Usa os pacotes oficiais quando existem e os legacy stream modes
 *  para a cauda longa. Sem match = texto puro (só o tema). */
export function languageForPath(relPath: string): Extension | null {
  const base = relPath.split('/').pop()?.toLowerCase() ?? '';

  // Família .env (.env, .env.local, .env.production, ...) → KEY=value.
  if (base === '.env' || base.startsWith('.env.')) return dotenvLanguage;

  // Casos resolvidos por nome de arquivo (sem extensão usável).
  const byName = BY_NAME[base];
  if (byName) return byName();

  // Resolução por extensão.
  const ext = base.includes('.') ? base.split('.').pop()! : '';
  const byExt = BY_EXT[ext];
  if (byExt) return byExt();

  return null;
}
