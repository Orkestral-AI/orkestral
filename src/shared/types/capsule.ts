/**
 * OEP — Orkestral Execution Protocol. A **Cápsula de Execução** é a tecnologia própria
 * do Orkestral: a camada entre o PENSAMENTO CARO (premium) e a EXECUÇÃO BARATA (Forge).
 *
 * O premium COMPILA uma intenção grande/confusa numa Cápsula compacta e OPERACIONAL —
 * não um resumo, mas uma ordem que o modelo local executa sem re-inferir: intenção
 * destilada + alvo por coordenada + contrato VERIFICÁVEL + restrições aplicadas +
 * padrões do projeto + 1 exemplar (RAG) + pitfalls aprendidos. O Forge executa a Cápsula
 * como uma VM executa bytecode: pequeno, rápido, fiel. Falhou? o erro vira pitfall e
 * re-alimenta. Persistiu? escala pro premium — que aprende de volta.
 *
 * INVARIANTE DE SEGURANÇA (da crítica adversarial): o premium NUNCA emite estrutura
 * frágil (linhas de região, asserts, hash). Ele só fornece TEXTO LIVRE curto
 * (goal/delta/done) e um BUILDER DETERMINÍSTICO monta o resto a partir de sinais que o
 * pipeline já produz (classifier, region, RAG, validators). Por isso a Cápsula entrega
 * valor ANTES de qualquer token premium — e o premium só ELEVA a fidelidade.
 */

export const OEP_VERSION = 'oep-1' as const;

/** Coordenada da região editável (não o texto) — materializada no executor. */
export interface RegionRef {
  symbol: string | null;
  /** 1-based inclusivo (Region.startLine/endLine). */
  lines: [number, number];
  kind: 'brace' | 'indent';
}

/** Um alvo (1 por arquivo). */
export interface CapsuleTarget {
  taskId: string;
  file: string;
  op: 'edit' | 'create';
  /** Região por coordenada; null = arquivo inteiro / criação. */
  region: RegionRef | null;
  /** Instrução curta ESPECÍFICA do arquivo (não repete o goal/contract). */
  delta: string;
  maxChangedLines: number;
}

/** Restrições APLICADAS de verdade (não só ditas) — anti-fora-de-escopo. */
export interface CapsuleScope {
  /** Globs que o executor BLOQUEIA (migrations/auth/secret…). */
  lockedPaths: string[];
  allowNewFiles: boolean;
  /** Teto de arquivos que a issue pode tocar. */
  touchBudgetFiles: number;
}

/**
 * Predicado de aceite MÁQUINA-verificável. GUARD-RAIL anti-regressão (não prova de
 * comportamento — a crítica é explícita: verifica sintoma, não que o "done" foi cumprido).
 */
export type ContractAssert =
  | { kind: 'file_contains'; file: string; needle: string }
  | { kind: 'file_absent_of'; file: string; needle: string }
  | { kind: 'symbol_exists'; file: string; symbol: string }
  | { kind: 'imports_intact'; file: string }
  | { kind: 'no_shrink_gt'; file: string; ratio: number };

export interface AcceptanceContract {
  /** Critério humano-legível (== metadata.done), preservado pro reviewer. */
  done: string;
  /** Predicados determinísticos derivados do done/delta. */
  asserts: ContractAssert[];
}

/** Padrão do projeto destilado (curto, com peso). */
export interface DistilledPattern {
  rule: string;
  /** Quantas execuções confirmaram (peso). */
  freq: number;
}

/** Erro aprendido NESTE repo + como evitar (gatilho → evitar → porquê). */
export interface Pitfall {
  when: string;
  avoid: string;
  because: string;
  freq: number;
}

/** Ponteiro pra um exemplar do forge-edit-examples (resolvido no executor). */
export interface ExemplarRef {
  exampleId: string;
  forFile: string;
  score: number;
}

/** Resultado de UMA tentativa — o LEDGER que dá rastreabilidade e re-alimenta o premium. */
export interface AttemptLedgerEntry {
  taskId: string;
  tier: string;
  outcome:
    | 'applied'
    | 'format_invalid'
    | 'anchor_mismatch'
    | 'shrink_guard'
    | 'import_drop'
    | 'scope_violation'
    | 'timeout'
    | 'validation_failed'
    | 'assert_failed';
  detail?: string;
  ms: number;
}

export interface CapsuleProvenance {
  compiledBy: 'premium' | 'deterministic-builder';
  compiledAt: string;
  capsuleHash: string;
  ledger: AttemptLedgerEntry[];
}

/** A Cápsula — a representação compacta e operacional de UMA tarefa. */
export interface TaskCapsule {
  v: typeof OEP_VERSION;
  capsuleId: string;
  issueId: string;
  workspaceId: string;
  /** Intenção DESTILADA (≤140 chars) — o "o quê", não a issue crua. */
  goal: string;
  /** Termos canônicos pra ranquear exemplares/pitfalls. */
  keywords: string[];
  targets: CapsuleTarget[];
  scope: CapsuleScope;
  contract: AcceptanceContract;
  patterns: DistilledPattern[];
  pitfalls: Pitfall[];
  exemplarRefs: ExemplarRef[];
  provenance: CapsuleProvenance;
}
