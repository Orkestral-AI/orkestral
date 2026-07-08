/**
 * GBNF do edit ANCORADO POR LINHA (ver line-edit.ts). Garante no sampler que a saída
 * é uma sequência de blocos `@@REPLACE a-b` / `@@INSERT n` … `@@END@@`. O modelo só
 * escolhe NÚMEROS (não há âncora de texto pra errar); o app funde pelo número da
 * linha. A estrutura/ordem é dura; o conteúdo entre os marcadores é livre (o código
 * novo). É robustez no decode, não pedido no prompt.
 */
export function buildLineEditGrammar(): string {
  return [
    'root ::= edit+',
    '',
    '# Cada edit: REPLACE de um intervalo a-b, ou INSERT depois da linha n.',
    'edit ::= replace-edit | insert-edit',
    'replace-edit ::= "@@REPLACE " num "-" num newline content end-line',
    'insert-edit ::= "@@INSERT " num newline content end-line',
    '',
    '# Número da linha (1+ dígitos). O range válido é checado pelo app (line-edit.ts).',
    'num ::= [0-9]+',
    '',
    '# Conteúdo (código novo): zero+ linhas quaisquer; o marcador @@END@@ encerra.',
    'content ::= line*',
    'line ::= line-text? newline',
    'line-text ::= [^\\n]+',
    'end-line ::= "@@END@@" newline',
    '',
    'newline ::= "\\n"',
  ].join('\n');
}
