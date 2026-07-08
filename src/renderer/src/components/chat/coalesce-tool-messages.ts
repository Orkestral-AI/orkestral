import type { ChatMessage } from '../../../../shared/types';

/** Mensagem assistant cujo único conteúdo são tool-calls (sem texto real, thinking,
 *  anexo, erro): é uma das que vira um card "Explorou N arquivos…". */
function isToolOnlyAssistant(m: ChatMessage): boolean {
  if (m.role !== 'assistant') return false;
  let hasTool = false;
  for (const p of m.parts) {
    if (p.type === 'tool-call') {
      hasTool = true;
    } else if (p.type === 'text') {
      if (p.text.trim().length > 0) return false; // texto de verdade → não é só-tool
    } else {
      return false; // thinking/anexo/erro/context-compact = conteúdo que importa
    }
  }
  return hasTool;
}

/**
 * Funde mensagens assistant SÓ-tool CONSECUTIVAS num único card agregado — em vez de
 * um muro de cards "Explorou N arquivos…" repetidos, o chat mostra UM resumo da
 * exploração. Mantém id/horário da PRIMEIRA (key estável + início) e o status mais
 * recente (se a última ainda streama, o card fica vivo). Qualquer mensagem com texto
 * real no meio quebra o grupo (a conversa volta a aparecer normal).
 */
export function coalesceToolOnlyMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && isToolOnlyAssistant(prev) && isToolOnlyAssistant(m)) {
      out[out.length - 1] = { ...prev, parts: [...prev.parts, ...m.parts], status: m.status };
    } else {
      out.push(m);
    }
  }
  return out;
}
