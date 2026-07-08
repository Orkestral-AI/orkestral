import type { ChatStreamEvent, MessagePart } from '../../../shared/types';

/**
 * Bloco renderizável do transcript do REPL. O stream vira uma lista ORDENADA de
 * blocos: texto corrido intercalado com linhas de tool (`⏺ name(args)`), na
 * ordem em que aconteceram — assim as tools não somem do transcript quando o
 * texto continua depois delas.
 */
export type StreamBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      /** Resumo humano curto dos args (path de arquivo ou 1º valor string, ~40 chars). */
      argsSummary: string;
      status: 'pending' | 'done' | 'error';
      /** Primeiras 3 linhas do `output` da tool (cada uma cortada em ~100 cols),
       *  preenchidas no re-emit de conclusão — só quando a part trouxe output. */
      outputPreview?: string;
      /** O output tinha mais linhas/colunas do que o preview mostra. */
      outputTruncated?: boolean;
    };

/** Fallback de label quando o evento `phase` vem sem `label` explícito. */
const PHASE_LABELS: Record<string, string> = {
  starting: 'inicializando…',
  thinking: 'pensando…',
  tool: 'usando ferramenta…',
  writing: 'escrevendo…',
};

/** Chaves de args que costumam carregar um path — preferidas no resumo. */
const PATH_ARG_KEYS = ['file_path', 'path', 'filePath', 'filename', 'file'] as const;

const ARGS_SUMMARY_MAX = 40;

/** Colapsa whitespace e corta em ~40 chars (com reticência) pro resumo de tool. */
function truncateSummary(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= ARGS_SUMMARY_MAX) return oneLine;
  return `${oneLine.slice(0, ARGS_SUMMARY_MAX - 1)}…`;
}

/**
 * Extrai um resumo humano curto dos args de uma tool: prefere um path de
 * arquivo (chaves conhecidas), senão o primeiro valor string não-vazio.
 * Exportado: o modo print (`-p`) usa o MESMO resumo nas linhas `⏺ name(args)`.
 */
export function summarizeArgs(args?: Record<string, unknown>): string {
  if (!args) return '';
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return truncateSummary(value);
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return truncateSummary(value);
  }
  return '';
}

/** Limites do preview de output de tool (modo `preview` do Ctrl+O no REPL). */
const OUTPUT_PREVIEW_MAX_LINES = 3;
const OUTPUT_PREVIEW_MAX_COLS = 100;

/**
 * Preview do `output` de uma tool: primeiras 3 linhas, cada uma cortada em
 * ~100 colunas (com reticência); `truncated` liga quando sobrou linha ou coluna
 * de fora. Output vazio/só whitespace não gera preview (a linha da tool fica
 * limpa em vez de ganhar um bloco em branco).
 */
function buildOutputPreview(output: string): { preview: string; truncated: boolean } | null {
  const trimmed = output.replace(/\s+$/, '');
  if (!trimmed.trim()) return null;
  const allLines = trimmed.split('\n');
  let truncated = allLines.length > OUTPUT_PREVIEW_MAX_LINES;
  const lines = allLines.slice(0, OUTPUT_PREVIEW_MAX_LINES).map((line) => {
    if (line.length <= OUTPUT_PREVIEW_MAX_COLS) return line;
    truncated = true;
    return `${line.slice(0, OUTPUT_PREVIEW_MAX_COLS - 1)}…`;
  });
  return { preview: lines.join('\n'), truncated };
}

/** Campos de preview prontos pra espalhar num bloco de tool — `{}` sem output. */
function outputPreviewFields(
  output: unknown,
): Pick<Extract<StreamBlock, { kind: 'tool' }>, 'outputPreview' | 'outputTruncated'> {
  if (typeof output !== 'string') return {};
  const built = buildOutputPreview(output);
  if (!built) return {};
  return { outputPreview: built.preview, outputTruncated: built.truncated };
}

/**
 * Converte as parts PERSISTIDAS de uma mensagem (DB) em blocos do transcript —
 * usado pra renderizar o histórico ao RETOMAR uma sessão no boot. Mesmo layout
 * canônico de turn fechado do `message-final`: tools em cima (na ordem), texto
 * concatenado num único bloco no fim. Parts de erro viram texto `erro: …`
 * (igual ao turn de run falho); thinking/attachment/context-compact são pulados.
 * Tool sem status persiste como já-rodada → default `done` (não `pending`).
 */
export function messagePartsToBlocks(parts: MessagePart[]): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  const texts: string[] = [];
  let toolSeq = 0;
  for (const part of parts) {
    if (part.type === 'tool-call') {
      blocks.push({
        kind: 'tool',
        id: part.id ?? `tool-auto-${toolSeq++}`,
        name: part.toolName || 'tool',
        argsSummary: summarizeArgs(part.args),
        status: part.status ?? 'done',
        ...outputPreviewFields(part.output),
      });
    } else if (part.type === 'text' && part.text.trim()) {
      texts.push(part.text);
    } else if (part.type === 'error') {
      texts.push(`erro: ${part.message}`);
    }
  }
  if (texts.length > 0) blocks.push({ kind: 'text', text: texts.join('\n') });
  return blocks;
}

/**
 * Acumula os `ChatStreamEvent` de UM run numa lista ordenada de blocos
 * (texto + tools) pro REPL renderizar — ao vivo e no turn finalizado.
 *
 * Semântica de substituição de texto (text-set e message-final): todo o texto
 * da mensagem é tratado como UMA concatenação. Ao substituir, os blocos de
 * tool são mantidos (na ordem original) e o texto novo vira UM único bloco no
 * FIM da lista — tools rodaram antes da conclusão final, então "tools em cima,
 * resposta embaixo" é o layout canônico do turn fechado (o intercalado só
 * existe durante o streaming ao vivo).
 */
export class StreamAccumulator {
  private blockList: StreamBlock[] = [];
  private finished = false;
  private err: string | null = null;
  private currentPhase: string | null = null;
  private canonicalText: string | null = null;
  /** Fallback pra tool-call sem `part.id` (o serviço sempre manda id hoje). */
  private toolSeq = 0;

  apply(e: ChatStreamEvent): void {
    switch (e.type) {
      case 'text-delta':
        this.appendText(e.delta);
        break;
      case 'text-set':
        this.replaceText(e.text);
        break;
      case 'tool-call':
        this.upsertTool(e.part);
        break;
      case 'phase':
        this.currentPhase = e.label ?? PHASE_LABELS[e.phase] ?? e.phase;
        break;
      case 'message-final':
        this.applyFinal(e.parts);
        break;
      case 'error':
        // Guarda a mensagem de erro pro REPL mostrar em vez de "(sem resposta)".
        this.err = e.error || 'erro desconhecido';
        this.finished = true;
        break;
      case 'message-end':
        this.finished = true;
        break;
      default:
        break;
    }
  }

  /** Anexa no bloco de texto do FIM; se o último bloco é tool, abre um novo. */
  private appendText(delta: string): void {
    const last = this.blockList[this.blockList.length - 1];
    if (last?.kind === 'text') {
      this.blockList[this.blockList.length - 1] = { kind: 'text', text: last.text + delta };
    } else {
      this.blockList.push({ kind: 'text', text: delta });
    }
  }

  /** Substitui a concatenação de texto (mantém tools; ver doc da classe). */
  private replaceText(text: string): void {
    this.blockList = this.blockList.filter((b) => b.kind === 'tool');
    this.blockList.push({ kind: 'text', text });
  }

  /**
   * Upsert por `part.id` — o serviço RE-EMITE a mesma part quando a tool
   * completa (status/output atualizados); mesmo id = mesmo bloco, nunca duplica.
   * O `output` costuma chegar SÓ nesse re-emit de conclusão — é ele que
   * preenche o outputPreview do bloco.
   */
  private upsertTool(part: MessagePart): void {
    if (part.type !== 'tool-call') return;
    const id = part.id ?? `tool-auto-${this.toolSeq++}`;
    const next: StreamBlock = {
      kind: 'tool',
      id,
      name: part.toolName || 'tool',
      argsSummary: summarizeArgs(part.args),
      status: part.status ?? 'pending',
      ...outputPreviewFields(part.output),
    };
    const idx = this.blockList.findIndex((b) => b.kind === 'tool' && b.id === id);
    if (idx >= 0) {
      const prev = this.blockList[idx] as Extract<StreamBlock, { kind: 'tool' }>;
      // Re-emit sem args/output não apaga o que já conhecíamos do bloco.
      this.blockList[idx] = {
        ...next,
        argsSummary: next.argsSummary || prev.argsSummary,
        ...(next.outputPreview === undefined && prev.outputPreview !== undefined
          ? { outputPreview: prev.outputPreview, outputTruncated: prev.outputTruncated }
          : {}),
      };
    } else {
      this.blockList.push(next);
    }
  }

  /**
   * `message-final` = parts CANÔNICAS persistidas no DB (o finishRun reescreve
   * texto: refs de issues, restauração do textBuffer, avisos, fallback). Aqui:
   * substitui a concatenação de texto pelo canônico e faz upsert das tools
   * finais (status pending→done já vem virado do serviço).
   */
  private applyFinal(parts: MessagePart[]): void {
    for (const part of parts) {
      if (part.type === 'tool-call') this.upsertTool(part);
    }
    this.canonicalText = parts
      .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    this.replaceText(this.canonicalText);
  }

  /** Lista ordenada de blocos (cópia — referência nova a cada chamada). */
  blocks(): readonly StreamBlock[] {
    return [...this.blockList];
  }

  /** Concatenação dos blocos de texto (pra checagens tipo "(sem resposta)"). */
  text(): string {
    return this.blockList
      .filter((b): b is Extract<StreamBlock, { kind: 'text' }> => b.kind === 'text')
      .map((b) => b.text)
      .join('\n');
  }

  /** Label da fase atual do run (do evento `phase`), ou null antes da primeira. */
  phase(): string | null {
    return this.currentPhase;
  }

  /** Texto canônico do `message-final` (DB) — null se o evento não chegou. */
  finalText(): string | null {
    return this.canonicalText;
  }

  done(): boolean {
    return this.finished;
  }

  error(): string | null {
    return this.err;
  }
}
