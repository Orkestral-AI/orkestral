/**
 * Guard anti-degeneração de saída do modelo. Modelos (sobretudo os pequenos/locais)
 * às vezes entram num LOOP e repetem a mesma linha/import dezenas de vezes — gerando
 * um arquivo "grande" que NÃO compila (o caso real: um `page.tsx` de 17KB com a mesma
 * linha de import ~30x). Sem este guard, o conteúdo era gravado e marcado como entregue.
 *
 * Função PURA (sem IO) pra ser testável e barata. Retorna o MOTIVO se o conteúdo é
 * degenerado, ou `null` se está OK. Os limiares são conservadores de propósito —
 * o objetivo é pegar degeneração CLARA, não código legítimo repetitivo.
 */

const IMPORT_RE = /^(import\b|export\s+\*|export\s+\{|from\s+['"]|const\s+\w+\s*=\s*require\()/;

export function detectDegenerateContent(content: string, _filePath?: string): string | null {
  const lines = content.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  // Arquivos pequenos não têm massa pra "degeneração" — ignora (evita falso positivo).
  if (nonEmpty.length < 8) return null;

  // 1) Import/linha-de-topo IDÊNTICA repetida. Um arquivo válido jamais repete o MESMO
  //    statement de import — 3x já é loop claro (o caso real tinha ~30x).
  const importCounts = new Map<string, number>();
  for (const l of lines) {
    const t = l.trim();
    if (t.length >= 12 && IMPORT_RE.test(t)) {
      importCounts.set(t, (importCounts.get(t) ?? 0) + 1);
    }
  }
  for (const [imp, n] of importCounts) {
    if (n >= 3) return `import idêntico repetido ${n}x — "${imp.slice(0, 70)}"`;
  }

  // 2) Qualquer linha SUBSTANCIAL (≥12 chars, não-brace) repetida muitas vezes.
  const lineCounts = new Map<string, number>();
  for (const l of lines) {
    const t = l.trim();
    if (t.length < 12) continue; // ignora `}`, `)`, `},`, linhas triviais
    lineCounts.set(t, (lineCounts.get(t) ?? 0) + 1);
  }
  let maxN = 0;
  let maxLine = '';
  for (const [line, n] of lineCounts) {
    if (n > maxN) {
      maxN = n;
      maxLine = line;
    }
  }
  if (maxN >= 10) return `linha substancial repetida ${maxN}x — "${maxLine.slice(0, 70)}"`;

  // 3) Repetição DOMINANTE: uma única linha ocupa boa parte do arquivo (loop suave).
  if (maxN >= 4 && maxN / nonEmpty.length > 0.4) {
    return `conteúdo dominado por uma linha repetida (${maxN}/${nonEmpty.length} linhas)`;
  }

  return null;
}
