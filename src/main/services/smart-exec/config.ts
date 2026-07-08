/**
 * Config GERENCIADA da execução local — NÃO é configurável pelo usuário.
 *
 * O modelo local "Orkestral Forge":
 *   - runtime: binário llama.cpp PRÉ-COMPILADO no pacote npm `node-llama-cpp`
 *     (Node-API, ABI-estável — embutido no app sem rebuild por Electron);
 *   - pesos: primeiro `.gguf` achado em `resources/forge[/models]` (ver
 *     `forgeDir()`/`resolveModel()` abaixo).
 * O usuário não aponta caminho, porta, GPU nem limites — tudo é interno.
 *
 * Resolução do GGUF empacotado:
 *   - prod: <app>/resources/forge  (process.resourcesPath)
 *   - dev:  <repo>/app/resources/forge
 *   - override de dev: env ORKESTRAL_FORGE_DIR
 *
 * Se o GGUF não estiver presente (build sem Forge), o caminho fica vazio →
 * agentes Forge escalam pro premium automaticamente.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SmartExecConfig } from '../../../shared/types';
import { getPerformanceProfile } from '../performance-preset';

function forgeDir(): string {
  const candidates: string[] = [];
  if (process.env.ORKESTRAL_FORGE_DIR) candidates.push(process.env.ORKESTRAL_FORGE_DIR);
  const rp = process.resourcesPath;
  if (rp) {
    // O build empacota `app/resources/*` em `<resourcesPath>/resources/*`
    // (extraResources from:'resources' to:'resources'); cobrimos os dois layouts.
    candidates.push(join(rp, 'resources', 'forge'), join(rp, 'forge'));
  }
  candidates.push(join(process.cwd(), 'resources', 'forge'));
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1];
}

function resolveModel(dir: string): string {
  for (const sub of [join(dir, 'models'), dir]) {
    try {
      const gguf = readdirSync(sub).find((f) => f.toLowerCase().endsWith('.gguf'));
      if (gguf) return join(sub, gguf);
    } catch {
      /* diretório ausente — ignora */
    }
  }
  return '';
}

// Áreas genuinamente sensíveis (segurança/dinheiro/dados de schema). Preferimos
// DIRETÓRIOS reais a substrings de nome de arquivo — antes `**/*auth*` pegava
// `useAuth.ts`/`AuthButton.tsx` (UI inofensiva) e forçava premium à toa. Segredos
// e credenciais ficam por substring (raramente são nome de componente de UI).
// Sem "áreas críticas" pro Forge (decisão do dono): o Forge é o EXECUTOR de
// tudo — se o CEO detalhou o que fazer, o Forge faz, e quem valida o trabalho é
// o CEO/TechLead na cadeia de review (não um bloqueio de arquivo que mandava
// tudo pro premium e matava a economia). Lista vazia = nada escala por área.
const CRITICAL_GLOBS: string[] = [];

// Preço de REFERÊNCIA (Claude Sonnet, USD por 1M tokens) pra estimar a economia
// que o usuário vê — o que o premium TERIA gastado pelo trabalho que o Forge fez
// local. NÃO é cobrança real (o premium não roda numa resolução local). Constante
// (não hardcode espalhado): se a tabela de preços mudar, muda só aqui.
const REFERENCE_INPUT_USD_PER_MTOK = 3;
const REFERENCE_OUTPUT_USD_PER_MTOK = 15;
const REFERENCE_PRICE_LABEL = 'Claude Sonnet (ref.)';

export interface ReferencePricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  label: string;
}

// Preços de REFERÊNCIA (USD por 1M tokens) por TIER de modelo. A economia visível tem
// que refletir o MODELO do usuário (o premium = o modelo do CEO), não um baseline fixo:
// rodar local evitando Opus economiza ~5x mais que evitando Sonnet. Números de tier
// (ref., não cobrança real). Um lugar só — muda aqui se a tabela de preços mudar.
const MODEL_PRICING: ReadonlyArray<{
  match: RegExp;
  inUsd: number;
  outUsd: number;
  label: string;
}> = [
  { match: /opus/i, inUsd: 15, outUsd: 75, label: 'Claude Opus' },
  { match: /sonnet/i, inUsd: 3, outUsd: 15, label: 'Claude Sonnet' },
  { match: /haiku/i, inUsd: 0.8, outUsd: 4, label: 'Claude Haiku' },
  { match: /gpt-?5|codex|^o[0-9]/i, inUsd: 2.5, outUsd: 10, label: 'GPT/Codex' },
];
const DEFAULT_MODEL_PRICING = { inUsd: 3, outUsd: 15, label: 'Claude Sonnet' };

// Esforço de raciocínio aumenta o OUTPUT (mais tokens de pensamento): o premium NO
// MESMO esforço gastaria mais saída pelo mesmo trabalho. Fator aplicado só ao OUTPUT.
const EFFORT_OUTPUT_FACTOR: Record<string, number> = {
  minimal: 0.7,
  low: 0.85,
  medium: 1,
  high: 1.4,
  xhigh: 1.9,
  max: 2.4,
};

/** Preço de referência relativo ao MODELO + ESFORÇO configurados do usuário. Modelo
 *  desconhecido cai no default (Sonnet) — mantém o número conservador anterior. */
export function referencePricingForModel(
  model?: string | null,
  effort?: string | null,
): ReferencePricing {
  const row = (model && MODEL_PRICING.find((r) => r.match.test(model))) || null;
  const base = row ?? DEFAULT_MODEL_PRICING;
  const e = typeof effort === 'string' ? effort.toLowerCase() : '';
  const factor = EFFORT_OUTPUT_FACTOR[e] ?? 1;
  return {
    inputUsdPerMTok: base.inUsd,
    outputUsdPerMTok: base.outUsd * factor,
    label: `${base.label} (ref.${factor !== 1 ? ` · esforço ${e}` : ''})`,
  };
}

/**
 * Config interna. Mantém o shape de SmartExecConfig pra não mexer nos
 * consumidores, mas todos os valores são gerenciados pelo app (não há setter).
 */
export function getSmartExecConfig(): SmartExecConfig {
  const dir = forgeDir();
  // Limites locais conforme o preset de memória escolhido no onboarding
  // (economic/moderate/high). 'moderate' == os defaults históricos abaixo.
  const profile = getPerformanceProfile();
  return {
    // Forge DESLIGADO (premium-only, "por hora"): o modelo local foi retirado da UI
    // (usuário não baixa mais), então o subsistema não deve rodar nem logar. Mantido
    // dormente — flipar pra `true` reativa tudo quando o Forge voltar. Alinha com
    // model-routing-policy ("SEMPRE premium"). Gates: llamaChat lança quando false,
    // runLocalPhase retorna null, issue-execution pula `if (cfg.enabled ...)`.
    enabled: false,
    premium: {
      provider: 'agent',
      model: '',
      apiKeyRef: '',
      baseUrl: '',
      maxInputTokens: 0,
      maxOutputTokens: 0,
      temperature: 0,
      referencePricing: {
        inputUsdPerMTok: REFERENCE_INPUT_USD_PER_MTOK,
        outputUsdPerMTok: REFERENCE_OUTPUT_USD_PER_MTOK,
        label: REFERENCE_PRICE_LABEL,
      },
    },
    local: {
      runtime: 'llama.cpp',
      // Runtime vem do pacote npm node-llama-cpp; não há binário em resources.
      binaryPath: '',
      modelPath: resolveModel(dir),
      serverHost: '127.0.0.1',
      serverPort: 0, // auto
      // Descarrega o modelo (libera ~1-2GB) após N segundos ocioso — por PRESET:
      // economic 12s (libera rápido em máquina apertada), moderate 30s, high 120s
      // (máquina forte mantém quente pra rajada de issues).
      idleUnloadSeconds: profile.local.idleUnloadSeconds,
      // Forge é o EXECUTOR primário — usa o MÁXIMO de contexto que o modelo aguenta
      // pra arquivo grande caber e rodar LOCAL (em vez de bloquear). 24576 prompt
      // (~96 KB de arquivo, ≈ maxPromptTokens×4−1500) + 4096 output = 28672 tokens,
      // dentro do contexto de 32k do Qwen2.5-Coder (KV-cache com GQA cabe folgado em
      // 8 GB). O runtime faz min(model.trainContextSize, prompt+output) → nunca passa
      // do que o GGUF empacotado suporta (clampa pra baixo sozinho). Por PRESET:
      // economic 12288 (KV-cache menor em máquina apertada), moderate 24576, high 28672.
      maxPromptTokens: profile.local.maxPromptTokens,
      // Espaço de saída — edits maiores (arquivo grande) não truncam (bloco truncado
      // não casa no merge). Por PRESET: economic 3072, moderate/high 4096.
      maxOutputTokens: profile.local.maxOutputTokens,
      // Gerenciado: Metal no macOS (confiável); CPU nos demais por segurança.
      allowGpu: process.platform === 'darwin',
      timeoutMs: 120_000,
    },
    // Forge é o executor primário: limites generosos pra rodar local de verdade
    // (escala só em tarefas grandes ou área crítica de arquivo).
    thresholds: { maxChangedLines: 400, maxAffectedFiles: 8 },
    // maxLocalValidationRounds: o Forge revalida+corrige LOCALMENTE em até 3
    // rodadas antes de desistir — vai até o fim local em vez de bloquear na 1ª
    // falha. Nunca aciona premium (economia intacta).
    retry: {
      maxLocalPatchAttempts: 1,
      maxLocalFixAttempts: 1,
      maxLocalValidationRounds: 3,
      fallbackAfterLocalFailure: true,
    },
    criticalGlobs: CRITICAL_GLOBS,
    // true: o Forge executa local mesmo se algum arquivo casasse uma área
    // "crítica" — a validação fica com o CEO/TechLead no review, não num gate.
    allowLocalOnCritical: true,
  };
}

/** O GGUF do Forge está empacotado e pronto neste app? (runtime vem do npm) */
export function isForgeBundled(): boolean {
  const cfg = getSmartExecConfig();
  return !!cfg.local.modelPath;
}
