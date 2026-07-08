import { describe, it, expect } from 'vitest';
import { extractEditableRegion, spliceRegion, detectLangKind } from './region';

describe('region — isola a menor região editável (pro Forge não reescrever o arquivo inteiro)', () => {
  function bigFile(fnBody: string): string {
    const head = Array.from({ length: 60 }, (_, i) => `const head${i} = ${i};`);
    const tail = Array.from({ length: 60 }, (_, i) => `const tail${i} = ${i};`);
    return [...head, fnBody, ...tail].join('\n') + '\n';
  }

  it('isola uma função TS no meio de um arquivo grande, dado o foco no corpo', () => {
    const fn = [
      'export function compute(a: number, b: number): number {',
      '  const x = a + b;',
      '  const y = x * 2;',
      '  return y;',
      '}',
    ].join('\n');
    const content = bigFile(fn);
    const anchor = 60 + 3; // 1-based: a linha "const y = x * 2;"
    const region = extractEditableRegion(content, [anchor], 'src/Foo.ts');
    expect(region).not.toBeNull();
    expect(region!.text).toContain('export function compute');
    expect(region!.text.trim().endsWith('}')).toBe(true);
    expect(region!.text).not.toContain('head0');
    expect(region!.text).not.toContain('tail0');
    // a região tem só as ~5 linhas da função, não o arquivo inteiro
    expect(region!.endLine - region!.startLine + 1).toBeLessThanOrEqual(6);
  });

  it('ignora chaves dentro de string/comentário (não fecha o bloco cedo)', () => {
    const fn = [
      'function f() {',
      "  const s = '}';   // chave em string",
      '  const t = "{ not a block }";',
      '  return s + t;',
      '}',
    ].join('\n');
    const content = bigFile(fn);
    const anchor = 60 + 4; // "return s + t;"
    const region = extractEditableRegion(content, [anchor], 'a.ts');
    expect(region).not.toBeNull();
    expect(region!.text).toContain('function f()');
    expect(region!.text).toContain('return s + t;');
    expect(region!.text.trim().endsWith('}')).toBe(true);
  });

  it('isola um método de classe PHP (não a classe inteira)', () => {
    const content = [
      '<?php',
      'class Controller {',
      '  public function index() {',
      '    return 1;',
      '  }',
      '  public function store($req) {',
      '    $x = $req->all();',
      '    return $x;',
      '  }',
      '}',
    ].join('\n');
    const anchor = 7; // "$x = $req->all();"
    const region = extractEditableRegion(content, [anchor], 'app/Http/Controller.php');
    expect(region).not.toBeNull();
    expect(region!.text).toContain('public function store');
    expect(region!.text).not.toContain('public function index');
  });

  it('isola por indentação em Python', () => {
    const content = [
      'import os',
      'x = 1',
      'def handler(req):',
      '    a = req.get("a")',
      '    b = a + 1',
      '    return b',
      'y = 2',
    ].join('\n');
    const anchor = 5; // "b = a + 1"
    const region = extractEditableRegion(content, [anchor], 'app/handler.py');
    expect(region).not.toBeNull();
    expect(region!.text).toContain('def handler(req):');
    expect(region!.text).toContain('return b');
    expect(region!.text).not.toContain('y = 2');
    expect(region!.text).not.toContain('import os');
  });

  it('região grande demais (>40% de um arquivo grande) → null (deixa o fallback decidir)', () => {
    // arquivo de ~110 linhas com uma função de ~52 (>40% e total>60 → ratio aplica)
    const content = [
      ...Array.from({ length: 30 }, (_, i) => `const a${i} = ${i};`),
      'function huge() {',
      ...Array.from({ length: 50 }, (_, i) => `  x${i}();`),
      '}',
      ...Array.from({ length: 30 }, (_, i) => `const b${i} = ${i};`),
    ].join('\n');
    const region = extractEditableRegion(content, [30 + 25], 'a.ts'); // foco no corpo da huge
    expect(region).toBeNull();
  });

  it('foco em top-level sem assinatura → null', () => {
    const content = bigFile('const standalone = 42;');
    const region = extractEditableRegion(content, [60 + 1], 'a.ts');
    expect(region).toBeNull();
  });

  it('linguagem desconhecida → null', () => {
    expect(detectLangKind('a.json')).toBeNull();
    expect(extractEditableRegion('{"a":1}', [1], 'a.json')).toBeNull();
  });

  it('foco DENTRO de um if/for não anchora no bloco de controle — isola a FUNÇÃO', () => {
    const fn = [
      'export function handle(order: Order): number {',
      '  let total = 0;',
      '  if (order.total > 100) {',
      '    total = order.total * 0.9;',
      '  }',
      '  return total;',
      '}',
    ].join('\n');
    const content = bigFile(fn);
    const anchor = 60 + 4; // "total = order.total * 0.9;" — dentro do if
    const region = extractEditableRegion(content, [anchor], 'src/Foo.ts');
    expect(region).not.toBeNull();
    // Deve pegar a função inteira, não só o `if (...) { ... }`.
    expect(region!.text).toContain('export function handle');
    expect(region!.text.trim().endsWith('}')).toBe(true);
    expect(region!.text).toContain('return total;');
  });

  it('âncoras não-rankeadas: escolhe a MENOR região válida entre os focos', () => {
    // foco[0] = um import lá em cima (sem assinatura → sem região); foco[1] = dentro
    // da função real. O resultado não pode depender da ordem (warpgrep reordena).
    const fn = ['export function real(x: number) {', '  const y = x + 1;', '  return y;', '}'].join(
      '\n',
    );
    const content = ['import { a } from "./a";', '', ...bigFile(fn).split('\n')].join('\n');
    const importLine = 1; // sem assinatura acima
    const bodyLine = 2 + 60 + 2; // dentro de real()
    const region = extractEditableRegion(content, [importLine, bodyLine], 'src/Foo.ts');
    expect(region).not.toBeNull();
    expect(region!.text).toContain('export function real');
    expect(region!.text).not.toContain('head0');
  });

  it('RESGATE JSX: componente React gigante (1 função) → isola o menor bloco {…} interno, não o componente todo', () => {
    // Uma função-componente maior que REGION_MAX_LINES: a região por ASSINATURA
    // seria o componente INTEIRO (rejeitada). O resgate por menor-bloco pega o
    // callback do .map() onde o foco cai — o caminho que destrava edit de frontend.
    const body = Array.from({ length: 170 }, (_, i) => `  const v${i} = ${i};`);
    const content =
      [
        'import React from "react";',
        'export function TicketPreviewModal({ ticket, onClose }: Props) {',
        ...body,
        '  return (',
        '    <ul>',
        '      {ticket.items.map((it) => {',
        '        const label = it.name;',
        '        return <li key={it.id}>{label}</li>;',
        '      })}',
        '    </ul>',
        '  );',
        '}',
      ].join('\n') + '\n';
    const anchor = content.split('\n').findIndex((l) => l.includes('const label = it.name;')) + 1;
    const region = extractEditableRegion(
      content,
      [anchor],
      'src/components/Chat/Tickets/TicketPreviewModal.tsx',
    );
    expect(region).not.toBeNull();
    expect(region!.text).toContain('const label = it.name;');
    // NÃO pegou o componente inteiro (sem a linha de assinatura).
    expect(region!.text).not.toContain('export function TicketPreviewModal');
    expect(region!.endLine - region!.startLine + 1).toBeLessThanOrEqual(10);
  });

  it('spliceRegion substitui só o span e preserva before/after byte-a-byte', () => {
    const fn = ['function f() {', '  return 1;', '}'].join('\n');
    const content = bigFile(fn);
    const region = extractEditableRegion(content, [60 + 2], 'a.ts')!;
    const merged = spliceRegion(content, region, 'function f() {\n  return 2;\n}');
    expect(merged).toContain('return 2;');
    expect(merged).not.toContain('return 1;');
    expect(merged).toContain('head0 = 0;'); // before intacto
    expect(merged).toContain('tail59 = 59;'); // after intacto
    // só a região mudou: total de linhas igual (mesmo número de linhas na região nova)
    expect(merged.split('\n').length).toBe(content.split('\n').length);
  });
});
