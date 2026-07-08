/**
 * Render da Cápsula → bloco OPERACIONAL compacto pro Forge. Não é resumo: é a destilação
 * do que o modelo precisa pra NÃO re-inferir — o objetivo, os pitfalls aprendidos (o que
 * já deu errado neste repo) e as regras do projeto. Curto de propósito (o contexto do
 * Forge é pequeno; cada token de moldura é token tirado do código).
 */
import type { TaskCapsule } from '../../../shared/types/capsule';

/**
 * Bloco compacto pra anexar à instrução do Forge. Vazio se não há sinal operacional
 * (não polui o prompt à toa). Os pitfalls são o diferencial: re-alimentam o erro
 * aprendido pra o modelo convergir em vez de repeti-lo.
 */
export function renderCapsuleGuidance(capsule: TaskCapsule): string {
  const lines: string[] = [];
  if (capsule.pitfalls.length > 0) {
    lines.push('## AVOID (learned from past failures in THIS project — do not repeat):');
    for (const p of capsule.pitfalls.slice(0, 2)) {
      lines.push(`- When ${p.when}: avoid ${p.avoid} (${p.because}).`);
    }
  }
  if (capsule.patterns.length > 0) {
    lines.push('## PROJECT RULES (follow):');
    for (const pat of capsule.patterns.slice(0, 2)) lines.push(`- ${pat.rule}`);
  }
  return lines.length > 0 ? '\n\n' + lines.join('\n') : '';
}

/** Mapeia um motivo de falha de aplicação/validação num Pitfall pra gravar no RAG de erros. */
export function pitfallFromFailure(
  outcome: string,
  detail: string,
): { when: string; avoid: string; because: string } | null {
  switch (outcome) {
    case 'anchor_mismatch':
      return {
        when: 'editar via SEARCH/REPLACE numa região com structure que muda',
        avoid: 'ancorar em linha ambígua/genérica',
        because: 'a âncora não casa (fuzzy baixo) e o edit é descartado',
      };
    case 'import_drop':
      return {
        when: 'reescrever o topo do arquivo',
        avoid: 'omitir/duplicar imports existentes',
        because: 'imports de topo somem e o arquivo quebra',
      };
    case 'validation_failed':
      return {
        // `when` carrega a ASSINATURA do erro (1ª linha) pra distinguir instâncias —
        // senão 100 erros distintos colapsam num pitfall genérico com freq inflado.
        when: `finalizar o edit (${errSignature(detail)})`,
        avoid: 'deixar erro de sintaxe/typo',
        because: `a validação reprovou: ${detail.slice(0, 120)}`,
      };
    case 'assert_failed':
      return {
        when: `cumprir o contrato (${errSignature(detail)})`,
        avoid: 'gravar sem o símbolo/comportamento pedido',
        because: `o contrato falhou: ${detail.slice(0, 120)}`,
      };
    case 'degenerate_content':
      return {
        when: 'gerar um arquivo novo/grande',
        avoid: 'repetir o mesmo import/linha em loop',
        because: 'a saída degenera (loop) e não compila — o arquivo é descartado',
      };
    default:
      return null;
  }
}

/** Assinatura curta e estável de um erro (1ª linha relevante) pra dedup granular. */
function errSignature(detail: string): string {
  const line = detail.split('\n').find((l) => l.trim().length > 3) ?? detail;
  return line.trim().slice(0, 48) || 'erro';
}
