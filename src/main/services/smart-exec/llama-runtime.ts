/**
 * Runtime do modelo local "Orkestral Forge" — embutido via `node-llama-cpp`.
 *
 * O binário do llama.cpp vem PRÉ-COMPILADO no pacote npm `node-llama-cpp`
 * (Node-API, ABI-estável — funciona no Electron sem rebuild). O GGUF é
 * resolvido em `resources/forge` (ver `forgeDir()` em config.ts). Tudo é
 * gerenciado internamente: GPU, contexto, descarga por ociosidade. O usuário
 * não configura.
 *
 * Princípios (do spec):
 *  - carrega SOB DEMANDA, nunca no boot do app;
 *  - uma única instância de modelo;
 *  - descarrega após `idleUnloadSeconds` de ociosidade;
 *  - timeout em toda inferência;
 *  - falha graciosamente (modelo ausente, timeout) → caller faz fallback premium.
 *
 * O modelo só gera TEXTO (o diff). NUNCA edita arquivos — isso é do app.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { Llama, LlamaGrammar, LlamaModel } from 'node-llama-cpp';
import type { SmartExecConfig } from '../../../shared/types';
import { trace } from '../log-bus';
import { buildLineEditGrammar } from './grammar';

export class LlamaUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'LlamaUnavailableError';
  }
}

type LocalCfg = SmartExecConfig['local'];

interface LoadedModel {
  llama: Llama;
  model: LlamaModel;
  modelPath: string;
  allowGpu: boolean;
  /**
   * Cache LAZY da grammar de EDIT ANCORADO POR LINHA, atrelado a ESTA instância de
   * modelo (uma grammar é compilada uma vez e reusada por todas as sessões). É
   * descartada junto com o modelo no stopLlama. Pode ser:
   *   - undefined: ainda não tentamos materializar;
   *   - LlamaGrammar: pronta pra usar;
   *   - null: a versão do node-llama-cpp NÃO suporta grammar (fallback no-op).
   */
  lineEditGrammar?: LlamaGrammar | null;
  /** Idle-unload POR MODELO: cada modelo carregado tem o seu (o Forge e o Fast-Apply
   *  coexistem em paralelo e descarregam cada um quando ocioso). */
  idleTimer?: NodeJS.Timeout | null;
  /** Segundos de ociosidade ANTES de descarregar ESTE modelo (definido no load). O
   *  Fast-Apply usa um valor curto (usado em rajadas → libera RAM rápido); o Forge usa
   *  o default. Independente por modelo. */
  idleUnloadSeconds: number;
  /** Inferências EM VOO neste modelo. >0 impede o idle-unload de dispor o modelo nativo
   *  no meio de um session.prompt (use-after-free → crash). Incrementa antes da geração,
   *  decrementa no finally. */
  inFlight?: number;
}

/**
 * SAFETY — logamos UMA única vez quando a grammar não pôde ser materializada
 * (API ausente nesta versão do node-llama-cpp ou erro de compilação), pra não
 * poluir os traces. O fluxo segue normalmente com a few-shot — a grammar é só
 * uma camada extra de robustez por cima do prompt, nunca um substituto.
 */
let grammarUnsupportedLogged = false;

// Cache MULTI-MODELO: cada GGUF (Forge, Fast-Apply…) carrega como uma instância PRÓPRIA
// e coexiste em paralelo — chamar o Fast-Apply NÃO descarrega o Forge (sem swap/churn).
// Cada um faz spawn LAZY (só quando é usado) e idle-unload independente. Chave = path|gpu.
const loadedModels = new Map<string, LoadedModel>();
const loadingPromises = new Map<string, Promise<LoadedModel>>();
function modelKey(cfg: LocalCfg): string {
  return `${cfg.modelPath}|${cfg.allowGpu ? 'gpu' : 'cpu'}`;
}
// WIN 3 — Nº de execuções (issues) ativas. Enquanto > 0, o modelo fica QUENTE:
// o timer de ociosidade não descarrega entre os arquivos de uma mesma run (o
// caro é o load ~600ms; a sessão/contexto por chamada é barata). Só após a run
// terminar (contador volta a 0) o idle-unload pode disparar.
let activeRuns = 0;

/** Há um GGUF empacotado e presente pra rodar o modelo local? */
export function isLocalConfigured(cfg: LocalCfg): boolean {
  return !!cfg.modelPath && existsSync(cfg.modelPath);
}

/** Modelos locais residentes na RAM AGORA (Forge, Fast-Apply…) — pro monitor de
 *  memória nos Logs. Read-only do Map privado; basename detecta o fast-apply. */
export function getLoadedLocalModels(): {
  modelPath: string;
  basename: string;
  isFastApply: boolean;
}[] {
  return Array.from(loadedModels.keys()).map((key) => {
    const modelPath = key.split('|')[0] ?? '';
    const base = modelPath.split(/[\\/]/).pop() ?? modelPath;
    return { modelPath, basename: base, isFastApply: /fast-apply|morph/i.test(base) };
  });
}

/**
 * WIN 3 — Marca o início de uma run multi-arquivo: mantém o modelo carregado
 * entre arquivos. SEMPRE pareie com `endRun()` (use try/finally no caller).
 */
export function beginRun(): void {
  activeRuns++;
  // Mantém TODOS os modelos quentes durante a run (sem reload entre arquivos/tiers).
  for (const lm of loadedModels.values()) {
    if (lm.idleTimer) {
      clearTimeout(lm.idleTimer);
      lm.idleTimer = null;
    }
  }
}

/** WIN 3 — Fim da run: se não houver mais runs ativas, rearma o idle-unload de cada modelo. */
export function endRun(cfg: LocalCfg): void {
  if (activeRuns > 0) activeRuns--;
  if (activeRuns === 0) for (const lm of loadedModels.values()) resetIdleTimer(lm, cfg);
}

function resetIdleTimer(lm: LoadedModel, cfg: LocalCfg): void {
  if (lm.idleTimer) clearTimeout(lm.idleTimer);
  lm.idleTimer = null;
  // Durante uma run ativa, NÃO armamos o timer — o modelo permanece quente até
  // o fim da run (endRun). Evita reload por arquivo no meio de uma issue.
  if (activeRuns > 0) return;
  // Inferência em voo neste modelo → NÃO arma (senão o timer disporia o modelo nativo
  // no meio do session.prompt = use-after-free). endInfer re-arma quando inFlight zera.
  if ((lm.inFlight ?? 0) > 0) return;
  // Idle do PRÓPRIO modelo (Fast-Apply curto, Forge default) — não do cfg do caller.
  const ms = Math.max(5, lm.idleUnloadSeconds ?? cfg.idleUnloadSeconds) * 1000;
  lm.idleTimer = setTimeout(() => {
    void disposeModel(lm);
  }, ms);
  // Não segura o event loop / não impede o app de fechar.
  if (typeof lm.idleTimer.unref === 'function') lm.idleTimer.unref();
}

/** Marca o início de uma inferência neste modelo (impede o idle-unload de dispor o
 *  modelo nativo no meio dela). Pareie SEMPRE com endInfer no finally. */
function beginInfer(lm: LoadedModel): void {
  lm.inFlight = (lm.inFlight ?? 0) + 1;
  if (lm.idleTimer) {
    clearTimeout(lm.idleTimer);
    lm.idleTimer = null;
  }
}

/** Fim de uma inferência: decrementa e, ao zerar, re-arma o idle-unload. */
function endInfer(lm: LoadedModel, cfg: LocalCfg): void {
  lm.inFlight = Math.max(0, (lm.inFlight ?? 0) - 1);
  resetIdleTimer(lm, cfg);
}

/** Descarrega UM modelo da memória (ociosidade). Remove do cache + libera grammar/modelo. */
async function disposeModel(lm: LoadedModel): Promise<void> {
  // NUNCA dispõe com inferência em voo (use-after-free do contexto nativo). endInfer
  // re-arma o idle-unload quando a geração termina.
  if ((lm.inFlight ?? 0) > 0) return;
  if (lm.idleTimer) {
    clearTimeout(lm.idleTimer);
    lm.idleTimer = null;
  }
  for (const [k, v] of loadedModels) if (v === lm) loadedModels.delete(k);
  // A grammar é atrelada à instância do modelo; ao soltar, vira lixo coletável junto.
  lm.lineEditGrammar = undefined;
  try {
    await lm.model.dispose();
    trace({
      level: 'debug',
      source: 'forge',
      scope: 'unload',
      message: `modelo descarregado (ocioso): ${basename(lm.modelPath)}`,
    });
  } catch {
    /* já liberado */
  }
}

/** Descarrega TODOS os modelos (shutdown). */
export async function stopLlama(): Promise<void> {
  const all = [...loadedModels.values()];
  loadedModels.clear();
  await Promise.all(all.map((lm) => disposeModel(lm)));
}

async function loadModel(cfg: LocalCfg): Promise<LoadedModel> {
  if (!isLocalConfigured(cfg)) {
    throw new LlamaUnavailableError('Modelo local não empacotado neste build');
  }
  // ESM-only com top-level await → import dinâmico (e mantém o runtime lazy).
  const { getLlama } = await import('node-llama-cpp');
  const t0 = Date.now();
  // Watchdog: getLlama/loadModel podem travar indefinidamente (GPU indisponível,
  // GGUF corrompido). Sem timeout, o agente fica preso pra sempre. Em timeout,
  // lança LlamaUnavailableError → o orquestrador escala pro premium.
  const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new LlamaUnavailableError(`Timeout ao ${what} (${ms}ms)`)), ms),
      ),
    ]);
  const llama = await withTimeout(
    getLlama({ gpu: cfg.allowGpu ? 'auto' : false }),
    60_000,
    'inicializar runtime local',
  );
  const model = await withTimeout(
    llama.loadModel({
      modelPath: cfg.modelPath,
      // 'auto' deixa o node-llama-cpp decidir o offload de camadas pra GPU.
      gpuLayers: cfg.allowGpu ? 'auto' : 0,
    }),
    120_000,
    'carregar o modelo local',
  );
  trace({
    level: 'success',
    source: 'forge',
    scope: 'load',
    message: `modelo carregado: ${basename(cfg.modelPath)} · GPU=${llama.gpu || 'cpu'}`,
    durationMs: Date.now() - t0,
  });
  return {
    llama,
    model,
    modelPath: cfg.modelPath,
    allowGpu: cfg.allowGpu,
    idleUnloadSeconds: cfg.idleUnloadSeconds,
  };
}

async function ensureModel(cfg: LocalCfg): Promise<LoadedModel> {
  const key = modelKey(cfg);
  // Já carregado? Reusa (NÃO descarrega outros modelos — coexistem em paralelo).
  const existing = loadedModels.get(key);
  if (existing) {
    resetIdleTimer(existing, cfg);
    return existing;
  }
  // Já está carregando este mesmo modelo? Compartilha a Promise (sem load duplicado).
  const inflight = loadingPromises.get(key);
  if (inflight) return inflight;

  const p = loadModel(cfg)
    .then((m) => {
      loadedModels.set(key, m);
      resetIdleTimer(m, cfg);
      return m;
    })
    .catch((err) => {
      throw err instanceof LlamaUnavailableError
        ? err
        : new LlamaUnavailableError(
            `Falha ao carregar modelo local: ${err instanceof Error ? err.message : String(err)}`,
          );
    })
    .finally(() => {
      loadingPromises.delete(key);
    });
  loadingPromises.set(key, p);
  return p;
}

/**
 * Materializa (e cacheia) a LlamaGrammar para ESTE modelo.
 *
 * SAFETY: se a versão instalada do node-llama-cpp não expuser createGrammar
 * (API ausente), NÃO falhamos nem fingimos — retornamos null (cacheado) e
 * logamos uma vez; o caller cai pro comportamento few-shot atual. Idem se a
 * compilação da grammar falhar. A grammar é robustez por cima do prompt.
 */
async function materializeGrammar(
  lm: LoadedModel,
  slot: 'lineEditGrammar',
  build: () => string,
  label: string,
): Promise<LlamaGrammar | null> {
  const cached = lm[slot];
  if (cached !== undefined) return cached;
  try {
    // `createGrammar` existe no Llama em node-llama-cpp v3+. Checamos em runtime
    // pra não quebrar caso a versão empacotada não o tenha.
    const llamaApi = lm.llama as unknown as {
      createGrammar?: (opts: { grammar: string }) => Promise<LlamaGrammar>;
    };
    if (typeof llamaApi.createGrammar !== 'function') {
      if (!grammarUnsupportedLogged) {
        grammarUnsupportedLogged = true;
        trace({
          level: 'warn',
          source: 'forge',
          scope: 'grammar',
          message:
            'node-llama-cpp sem createGrammar nesta versão — seguindo com few-shot (sem grammar)',
        });
      }
      lm[slot] = null;
      return null;
    }
    const grammar = await llamaApi.createGrammar({ grammar: build() });
    lm[slot] = grammar;
    trace({
      level: 'debug',
      source: 'forge',
      scope: 'grammar',
      message: `grammar ${label} compilada e cacheada`,
    });
    return grammar;
  } catch (err) {
    // Grammar inválida/erro de compilação NÃO pode derrubar a inferência.
    if (!grammarUnsupportedLogged) {
      grammarUnsupportedLogged = true;
      trace({
        level: 'warn',
        source: 'forge',
        scope: 'grammar',
        message: `falha ao compilar grammar — seguindo com few-shot: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
    lm[slot] = null;
    return null;
  }
}

const getLineEditGrammar = (lm: LoadedModel): Promise<LlamaGrammar | null> =>
  materializeGrammar(lm, 'lineEditGrammar', buildLineEditGrammar, 'line-edit');

/**
 * Chat instruct no modelo local (Qwen2.5-Coder-Instruct via chat template).
 *
 * Usamos LlamaChatSession (NÃO LlamaCompletion). Isso é crítico: o forge.gguf é
 * um modelo *instruct* e só se comporta quando recebe o chat template correto
 * (turnos system/user/assistant com EOS). Com completion cru, o modelo trata o
 * prompt como documento a continuar — ele repete o scaffold, alucina novas
 * instruções/arquivos e enche os tokens de lixo, e os blocos SEARCH/REPLACE
 * nunca saem limpos (medido no forge.gguf real: 1/4 com completion → 3/4 com
 * chat em edições simples). A sessão também para sozinha no fim do turno do
 * assistant (EOS), em vez de divagar até maxTokens — saídas ~800 chars em ~2s
 * em vez de ~7700 chars em ~19s.
 *
 * Lança LlamaUnavailableError em falha → o orquestrador escala pro premium.
 */
export interface LlamaChatOptions {
  /**
   * Constranger à grammar de EDIT ANCORADO POR LINHA (@@REPLACE/@@INSERT) —
   * garantia estrutural no sampler. Use SÓ para chamadas de edição. Se a versão
   * do node-llama-cpp não suportar grammar, vira no-op (cai pro few-shot).
   */
  lineEditGrammar?: boolean;
  /** Adapter LoRA aprovado/ativo para este workspace. */
  loraPath?: string | null;
  /** Override de temperatura desta chamada (senão usa cfg.local.samplingTemperature). */
  temperature?: number;
  /** Override de seed desta chamada (senão usa cfg.local.samplingSeed). */
  seed?: number;
  /** Streaming token-a-token: recebe cada pedaço de texto conforme é gerado (pro
   *  chat conversacional pintar a resposta ao vivo). O retorno ainda é o texto completo. */
  onChunk?: (chunk: string) => void;
  /**
   * Ignora o kill-switch `cfg.enabled` NESTA chamada. Uso exclusivo do modelo
   * DEDICADO de fast-apply (tool edit_file): ele só mescla código já escrito pelo
   * premium, não é o Forge conversacional que o kill-switch desliga.
   */
  allowWhenDisabled?: boolean;
}

export async function llamaChat(
  cfg: SmartExecConfig,
  systemPrompt: string,
  userPrompt: string,
  options?: LlamaChatOptions,
): Promise<string> {
  // Forge desligado (premium-only): no-op duro ANTES de carregar o modelo — sem load,
  // sem inferência, sem log forge. Callers tratam (git/heartbeat: try/catch→fallback;
  // chat: forgeReady=false; orchestrator: nem é chamado pelo issue-execution).
  // Exceção única: o modelo dedicado de fast-apply (allowWhenDisabled) segue vivo —
  // merge de edit não é o Forge conversacional.
  if (!cfg.enabled && !options?.allowWhenDisabled) {
    throw new LlamaUnavailableError('Forge desligado (premium-only)');
  }
  const local = cfg.local;
  const loadedModel = await ensureModel(local);
  const { model } = loadedModel;
  // Marca a inferência em voo: o idle-unload não pode dispor o modelo nativo durante o
  // session.prompt abaixo (que pode durar mais que idleUnloadSeconds) — seria use-after-free.
  beginInfer(loadedModel);

  // Materializa a grammar (cacheada por modelo) só quando pedida. null = versão
  // sem suporte → seguimos sem grammar (few-shot), sem quebrar o fluxo.
  const grammar = options?.lineEditGrammar ? await getLineEditGrammar(loadedModel) : null;

  const { LlamaChatSession } = await import('node-llama-cpp');
  const contextSize = Math.min(
    model.trainContextSize,
    Math.max(512, local.maxPromptTokens + local.maxOutputTokens),
  );

  // Timeout ESCALA com o tamanho do prompt (prefill + geração). Capado em 3 min: o
  // timeout agora é SOFT (cai pro próximo tier menor/mais rápido em vez de abortar a
  // issue), então é melhor falhar RÁPIDO e seguir task-a-task do que esperar 6 min num
  // único call lento. Base (config) + ~1.5 ms/char.
  const promptChars = systemPrompt.length + userPrompt.length;
  const timeoutMs = Math.min(local.timeoutMs + Math.round(promptChars * 1.5), 180_000);

  let context: Awaited<ReturnType<LlamaModel['createContext']>> | null = null;
  const t0 = Date.now();
  const loraPath = options?.loraPath || null;
  trace({
    level: 'info',
    source: 'forge',
    scope: 'inference',
    message: `inferência iniciada · prompt≈${promptChars} chars · ctx=${contextSize} · timeout=${Math.round(timeoutMs / 1000)}s${grammar ? ' · grammar=on' : ''}${loraPath ? ' · lora=on' : ''}`,
  });
  try {
    context = await model.createContext({
      contextSize,
      ...(loraPath ? { lora: loraPath } : {}),
    });
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt,
    });
    // BEST-OF-N: a tentativa 1 é greedy (temp 0, determinística); os retries sobem
    // a temperatura (via cfg.local.samplingTemperature) pra produzir candidatos
    // DIVERSOS. options.temperature tem prioridade (chamada específica). Com temp>0
    // adicionamos top-p/top-k/min-p sãos pra cortar a cauda ruim do modelo pequeno.
    const temperature = options?.temperature ?? local.samplingTemperature ?? 0;
    const seed = options?.seed ?? local.samplingSeed;
    const text = await session.prompt(userPrompt, {
      maxTokens: local.maxOutputTokens,
      temperature,
      ...(temperature > 0 ? { topP: 0.95, topK: 40, minP: 0.05 } : {}),
      ...(seed !== undefined ? { seed } : {}),
      signal: AbortSignal.timeout(timeoutMs),
      // Garantia estrutural: quando presente, o sampler só pode emitir tokens
      // que avancem o formato SEARCH/REPLACE. Ausente (null) → geração livre.
      ...(grammar ? { grammar } : {}),
      // Streaming opcional (chat conversacional): pinta a resposta token-a-token.
      ...(options?.onChunk ? { onTextChunk: options.onChunk } : {}),
    });
    trace({
      level: 'success',
      source: 'forge',
      scope: 'inference',
      message: `inferência concluída · saída≈${text.trim().length} chars`,
      durationMs: Date.now() - t0,
    });
    return text.trim();
  } catch (err) {
    // TIMEOUT é SOFT: o modelo está presente mas a geração estourou o tempo (3B em
    // prompt grande). NÃO aborta a issue — devolve vazio pra o caller cair no PRÓXIMO
    // tier (menor/mais rápido) e seguir task-a-task. Só erro REAL de runtime
    // (modelo não carrega) escala. Assim o Forge "continua fazendo por trás" em vez
    // de jogar tudo fora num único call lento.
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || /abort|timeout|timed out/i.test(err.message));
    if (isTimeout) {
      trace({
        level: 'warn',
        source: 'forge',
        scope: 'inference',
        message: `inferência estourou o tempo (${Math.round(timeoutMs / 1000)}s) — caindo pro próximo tier`,
        durationMs: Date.now() - t0,
      });
      return '';
    }
    throw new LlamaUnavailableError(
      `Runtime local indisponível: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (context) {
      try {
        await context.dispose();
      } catch {
        /* ignore */
      }
    }
    endInfer(loadedModel, local);
  }
}

/**
 * Wrapper de compat: aceita um prompt único (system+user já concatenados) e o
 * roteia pela sessão de chat como mensagem do usuário (sem system). Preferir
 * `llamaChat(cfg, system, user)` quando houver separação clara de papéis.
 */
export async function llamaComplete(
  cfg: SmartExecConfig,
  prompt: string,
  options?: LlamaChatOptions,
): Promise<string> {
  return llamaChat(cfg, '', prompt, options);
}

/**
 * Resultado de uma fase analítica rodada no modelo local (sumarização /
 * classificação pura, sem tool-calling). `tokensIn/tokensOut` são ESTIMATIVAS
 * (chars/4) do trabalho que o premium teria gasto nesta fase — o runtime local
 * não expõe contagem de tokens por chamada, então a economia medida é honesta
 * mas estimada (rotulada como tal em quem grava o ledger).
 */
export interface LocalPhaseResult<T> {
  /** Texto bruto retornado pelo modelo (já trimado). */
  raw: string;
  /** Valor parseado/validado (igual a `raw` quando não há parser). */
  value: T;
  /** Estimativa (chars/4) de tokens de entrada que o premium teria consumido. */
  tokensIn: number;
  /** Estimativa (chars/4) de tokens de saída que o premium teria gerado. */
  tokensOut: number;
}

/** Estimativa grosseira de tokens a partir de chars (≈4 chars/token). */
function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

/**
 * Roda uma FASE ANALÍTICA pura (sumarização/classificação com input já pronto em
 * memória) no modelo local. NÃO é para edição de código nem para tarefas que
 * precisem de tool-calling/exploração de filesystem — essas continuam premium.
 *
 * Contrato de segurança: NUNCA lança. Em QUALQUER falha (modelo ausente, timeout,
 * inferência inválida, parser/validador rejeitou o output) retorna `null` — o
 * caller cai no caminho premium/heurística existente. O fluxo feliz nunca regride.
 *
 * Quando passado, `parse` recebe o texto bruto e deve retornar o valor validado
 * ou `null` se o output não for utilizável (não parseável, fora do enum, etc.).
 */
export async function runLocalPhase<T = string>(
  cfg: SmartExecConfig,
  input: {
    system: string;
    user: string;
    /** Valida/parseia a saída; retornar null = output inválido → fallback. */
    parse?: (raw: string) => T | null;
    scope?: string;
  },
): Promise<LocalPhaseResult<T> | null> {
  // Forge desligado: no-op silencioso (sem o log debug de fallback do catch abaixo).
  if (!cfg.enabled) return null;
  if (!isLocalConfigured(cfg.local)) return null;
  let raw: string;
  try {
    raw = await llamaChat(cfg, input.system, input.user);
  } catch (err) {
    trace({
      level: 'debug',
      source: 'forge',
      scope: input.scope ?? 'local-phase',
      message: `fase local indisponível → fallback: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return null;
  }
  if (!raw) return null;

  let value: T;
  if (input.parse) {
    const parsed = input.parse(raw);
    if (parsed === null || parsed === undefined) {
      trace({
        level: 'debug',
        source: 'forge',
        scope: input.scope ?? 'local-phase',
        message: 'output local inválido (parser rejeitou) → fallback',
      });
      return null;
    }
    value = parsed;
  } else {
    value = raw as unknown as T;
  }

  return {
    raw,
    value,
    tokensIn: estimateTokens(input.system.length + input.user.length),
    tokensOut: estimateTokens(raw.length),
  };
}

/**
 * Extrai o primeiro objeto JSON `{...}` de uma resposta do modelo e o parseia.
 * O modelo às vezes envolve o JSON em prosa ou cercas markdown — pegamos o
 * primeiro bloco balanceado. Retorna null se não houver JSON válido.
 */
export function parseFirstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(raw.slice(start, i + 1)) as unknown;
          return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
