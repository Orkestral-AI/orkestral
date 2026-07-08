/**
 * Motor v2: o planner (secoes 1 e 3 do plano).
 *
 * O premium transforma uma intencao de uma linha em poucas issues de FATIA VERTICAL, cada
 * uma uma checklist enxuta, com a issue 1 = esqueleto que anda (uma tela que abre cedo).
 * O premium fica atras da interface PlanModelFn; o valor deterministico e a VALIDACAO do
 * plano: enxuto (<= 8), skeleton primeiro, cada checkbox com alvo. Plano ruim = rejeitado
 * antes de gastar Forge executando lixo.
 */
export interface PlannedCheckbox {
  id: string;
  instruction: string;
  targetFile: string;
}

export interface PlannedIssue {
  id: string;
  title: string;
  /** Issue 1: sobe a base + UMA tela que abre. So a primeira deve ser true. */
  isWalkingSkeleton: boolean;
  checkboxes: PlannedCheckbox[];
}

export interface Plan {
  intent: string;
  /** Título curto e limpo do épico (gerado pelo modelo, não o prompt cru do usuário). */
  title: string;
  issues: PlannedIssue[];
  /**
   * Quando a mensagem NÃO é um pedido de construir/alterar software (pergunta, conversa,
   * esclarecimento), o modelo responde direto aqui em vez de planejar um build. Sem intent,
   * sem regex: o próprio modelo entende e decide.
   */
  reply?: string;
}

export const MAX_ISSUES = 8;
export const MAX_CHECKBOXES = 6;

/** Erros estruturais de um plano (vazio = valido). Sao acionaveis pra o premium corrigir. */
export function validatePlan(plan: Plan): string[] {
  // Resposta conversacional (não é build): nada a validar.
  if (plan.reply) return [];
  const v: string[] = [];
  const issues = plan.issues ?? [];

  if (issues.length === 0) {
    v.push('plano sem issues.');
    return v;
  }
  if (issues.length > MAX_ISSUES) {
    v.push(
      `plano com ${issues.length} issues; o maximo enxuto e ${MAX_ISSUES}. Agrupe em fatias verticais.`,
    );
  }

  const skeletons = issues.filter((i) => i.isWalkingSkeleton);
  if (skeletons.length !== 1) {
    v.push(`deve haver exatamente 1 issue esqueleto-que-anda; achei ${skeletons.length}.`);
  } else if (!issues[0].isWalkingSkeleton) {
    v.push('a issue esqueleto-que-anda tem que ser a PRIMEIRA (entrega algo que abre cedo).');
  }

  const ids = new Set<string>();
  for (const issue of issues) {
    if (!issue.id) v.push('issue sem id.');
    else if (ids.has(issue.id)) v.push(`id de issue duplicado: ${issue.id}.`);
    else ids.add(issue.id);

    const cbs = issue.checkboxes ?? [];
    if (cbs.length === 0) v.push(`issue "${issue.id}" sem checkboxes.`);
    if (cbs.length > MAX_CHECKBOXES) {
      v.push(`issue "${issue.id}" com ${cbs.length} checkboxes; o maximo e ${MAX_CHECKBOXES}.`);
    }
    const cbIds = new Set<string>();
    for (const cb of cbs) {
      if (!cb.instruction?.trim()) v.push(`checkbox sem instrucao na issue "${issue.id}".`);
      if (!cb.targetFile?.trim()) {
        v.push(
          `checkbox "${cb.id ?? '?'}" sem arquivo alvo (todo checkbox produz/altera um arquivo).`,
        );
      }
      if (cb.id && cbIds.has(cb.id))
        v.push(`id de checkbox duplicado: ${cb.id} na issue "${issue.id}".`);
      if (cb.id) cbIds.add(cb.id);
    }
  }
  return v;
}

/** Parseia o JSON do plano que o premium devolveu. Lanca com mensagem clara se malformado. */
export function parsePlan(intent: string, json: string): Plan {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFences(json));
  } catch (e) {
    throw new Error(`plano nao e JSON valido: ${String(e)}`);
  }
  const obj = raw as { issues?: unknown; title?: unknown; reply?: unknown };
  // Não é build: o modelo respondeu conversacionalmente. Retorna a resposta, sem issues.
  if (typeof obj?.reply === 'string' && obj.reply.trim() && !Array.isArray(obj.issues)) {
    return { intent, title: '', issues: [], reply: obj.reply.trim() };
  }
  if (!obj || !Array.isArray(obj.issues)) {
    throw new Error('plano sem o array "issues".');
  }
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const issues: PlannedIssue[] = obj.issues.map((i, idx) => {
    const it = i as Partial<PlannedIssue> & { checkboxes?: unknown };
    const checkboxes: PlannedCheckbox[] = Array.isArray(it.checkboxes)
      ? it.checkboxes.map((c, ci) => {
          const cb = c as Partial<PlannedCheckbox>;
          return {
            id: cb.id ?? `${it.id ?? `i${idx}`}-c${ci}`,
            instruction: cb.instruction ?? '',
            targetFile: cb.targetFile ?? '',
          };
        })
      : [];
    return {
      id: it.id ?? `i${idx}`,
      title: it.title ?? '',
      isWalkingSkeleton: !!it.isWalkingSkeleton,
      checkboxes,
    };
  });
  return { intent, title, issues };
}

function stripFences(s: string): string {
  const m = s.trim().match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/);
  return m ? m[1] : s;
}

export interface PlanModelOutput {
  planJson: string;
  premiumIn: number;
  premiumOut: number;
}
export type PlanModelFn = (input: { intent: string; context: string }) => Promise<PlanModelOutput>;

const PLANNER_SYSTEM = [
  'FIRST decide: is the user asking to BUILD, CREATE, or CHANGE software (a project, app, ' +
    'feature, screen, API, integration, fix, refactor) in this codebase? This applies to a new ' +
    'prompt, a new/empty project, or an existing/imported project alike.',
  'If it is NOT a build (a question, greeting, clarification, opinion, or general discussion), ' +
    'respond ONLY with JSON { "reply": "<a helpful, direct answer in the user\'s language>" } and STOP. ' +
    'Do not invent a build the user did not ask for.',
  'If it IS a build, plan it as VERTICAL SLICES (below) and return the issues JSON.',
  'You plan software as VERTICAL SLICES, not layers.',
  `Return up to ${MAX_ISSUES} issues; each one is a checklist of up to ${MAX_CHECKBOXES} steps.`,
  'Issue 1 is the walking skeleton: stand up the base + ONE screen that opens. isWalkingSkeleton: true only on it.',
  'In the skeleton (issue 1), FREEZE the design system: install/configure shadcn/ui + tokens and ' +
    'create the base components (button, card, input). Later screens ONLY compose those ' +
    'components, never invent new UI nor another UI library.',
  'Each checkbox produces/changes ONE file (targetFile) and has a short instruction. Do not put ' +
    'two checkboxes targeting the same file in the same issue.',
  'Each issue delivers something the user can see/use. No infra-only issues.',
  'The top-level "title" is a SHORT, clean epic name (max ~8 words) describing what is being built, ' +
    "in the user's language. Never echo the raw prompt.",
  'Respond ONLY with JSON: { "title": "<short epic name>", "issues": [ { "id","title","isWalkingSkeleton","checkboxes":[ {"id","instruction","targetFile"} ] } ] }',
].join('\n');

export interface PlanResult {
  plan: Plan;
  violations: string[];
  premiumIn: number;
  premiumOut: number;
}

/**
 * Gera e VALIDA o plano a partir da intencao. O premium escreve; a validacao deterministica
 * garante que e enxuto e em fatias verticais antes de qualquer Forge rodar.
 */
export async function planFromIntent(
  input: { intent: string; context?: string },
  model: PlanModelFn,
): Promise<PlanResult> {
  const out = await model({ intent: input.intent, context: input.context ?? '' });
  const plan = parsePlan(input.intent, out.planJson);
  return {
    plan,
    violations: validatePlan(plan),
    premiumIn: out.premiumIn,
    premiumOut: out.premiumOut,
  };
}

export { PLANNER_SYSTEM };
