/**
 * Motor v2: ponto de integracao com o app (a costura).
 *
 * O app pluga UMA coisa, o `premiumChat` (o adapter de agente premium real, que faz a
 * chamada ao modelo e devolve texto + tokens). Daqui montamos o planner, o conduct e o
 * Forge local real, e expomos `run({ intent, projectRoot })` que roda o plano de ponta a
 * ponta. O Forge fica injetavel (`forgeChat`) pra teste sem GPU.
 *
 * Uso no app:
 *   const motor = createEngineV2({ premiumChat: appPremiumAdapter });
 *   const result = await motor.run({ intent, projectRoot, onPreviewReady, onCheckpoint });
 */
import { createGenerate } from './generate-adapter';
import { createConduct, type PremiumChatFn } from './conduct-adapter';
import { PLANNER_SYSTEM, type PlanModelFn } from './planner';
import { runPlan, type RunPlanInput, type RunPlanResult } from './plan-runner';

/** Adapta o premiumChat do app na interface de planejamento (prompt do planner + JSON). */
export function createPlanModel(premiumChat: PremiumChatFn): PlanModelFn {
  return async ({ intent, context }) => {
    const user = `User intent: ${intent}\n\nProject context:\n${context || '(new, greenfield)'}`;
    const out = await premiumChat(PLANNER_SYSTEM, user);
    return { planJson: out.text, premiumIn: out.premiumIn, premiumOut: out.premiumOut };
  };
}

export interface EngineV2Deps {
  /** O adapter de agente premium do app (planejar + conduzir). */
  premiumChat: PremiumChatFn;
  /** Override da chamada ao Forge local (default = llamaChat real). Injetavel pra teste. */
  forgeChat?: (system: string, user: string) => Promise<string>;
}

export type EngineV2RunInput = Omit<RunPlanInput, 'planModel' | 'generate' | 'conduct'>;

export interface EngineV2 {
  run: (input: EngineV2RunInput) => Promise<RunPlanResult>;
}

/** Monta o motor v2 com o premium do app plugado. */
export function createEngineV2(deps: EngineV2Deps): EngineV2 {
  const planModel = createPlanModel(deps.premiumChat);
  const conduct = createConduct(deps.premiumChat);
  // Forge removido: sem override de forgeChat, a geração roda no PREMIUM do app.
  const genChat =
    deps.forgeChat ??
    (async (system: string, user: string) => (await deps.premiumChat(system, user)).text);
  const generate = createGenerate({ chat: genChat });
  return {
    run: (input) => runPlan({ ...input, planModel, generate, conduct }),
  };
}
