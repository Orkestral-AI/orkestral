/**
 * Background skill-review fork — a auto-melhoria do Hermes adaptada ao Orkestral.
 *
 * Depois que uma execução de issue conclui (com sucesso e não-trivial), rodamos
 * um review LEVE e fire-and-forget: o modelo premium olha o que foi feito e
 * decide se uma técnica REUTILIZÁVEL emergiu — criando uma skill nova ou
 * melhorando uma existente. Roda FORA do turno principal (não polui o contexto
 * do executor nem bloqueia a conclusão da issue). Custo: uma chamada barata de
 * `claude --print` por run não-trivial. Desligável via ORKESTRAL_SKILL_REVIEW_DISABLE=1.
 */
import { spawnCapture } from './smart-exec/premium-edit';
import { SkillRepository } from '../db/repositories/skill.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import { trace } from './log-bus';
import type { AdapterType, Issue } from '../../shared/types';

const skillRepo = new SkillRepository();
const agentRepo = new AgentRepository();

const REVIEW_SYSTEM = `You review a just-completed coding task and decide whether a REUSABLE skill (a short
procedural playbook future tasks would benefit from) should be created or improved. Be conservative:
most routine tasks need NO skill. Only propose one for a non-obvious technique, a tricky setup, a
recurring pattern, or a gotcha + its fix.

Respond in EXACTLY one of these formats and NOTHING else:

DECISION: NONE

or

DECISION: CREATE
NAME: <short imperative skill name>
DESCRIPTION: <one line: when to use it>
---
<concise markdown playbook: steps, pitfalls, how to verify>

or

DECISION: IMPROVE
NAME: <exact name of an existing skill listed below>
---
<the extra note/step to append to that skill>

Rules: no prose outside the format; never include secrets; keep the playbook generic (reusable across
tasks, not specific to this one issue's numbers/paths); if unsure, choose NONE.`;

export interface SkillReviewInput {
  issue: Issue;
  agentName: string;
  summary: string;
  filesChanged: string[];
  premium: { adapterType: AdapterType; model: string | null };
  /** Marca um run premium não-trivial (sem lista de arquivos, mas com trabalho real). */
  nonTrivial?: boolean;
}

interface ParsedReview {
  decision: 'CREATE' | 'IMPROVE' | 'NONE';
  name?: string;
  description?: string;
  content?: string;
}

function parseReview(raw: string): ParsedReview {
  const text = raw.trim();
  const decMatch = text.match(/DECISION:\s*(CREATE|IMPROVE|NONE)/i);
  const decision = (decMatch?.[1]?.toUpperCase() as ParsedReview['decision']) ?? 'NONE';
  if (decision === 'NONE') return { decision: 'NONE' };
  const name = text.match(/NAME:\s*(.+)/i)?.[1]?.trim();
  const description = text.match(/DESCRIPTION:\s*(.+)/i)?.[1]?.trim();
  const sep = text.indexOf('\n---');
  const content = sep >= 0 ? text.slice(sep + 4).trim() : '';
  if (!name || !content) return { decision: 'NONE' };
  return { decision, name, description, content };
}

/**
 * Roda o review e aplica a decisão (CREATE/IMPROVE/NONE). Fire-and-forget — nunca
 * lança (o caller chama com void/.catch). Só roda com premium=claude.
 */
export async function maybeReviewForSkill(input: SkillReviewInput): Promise<void> {
  if (process.env.ORKESTRAL_SKILL_REVIEW_DISABLE === '1') return;
  // Só suportamos o handoff via claude --print (saída texto). Codex → pula.
  if (input.premium.adapterType !== 'claude_local') return;
  if (input.filesChanged.length === 0 && !input.nonTrivial) return; // trivial → não vale review

  const { issue } = input;
  const existing = skillRepo
    .listByWorkspace(issue.workspaceId)
    .filter((s) => s.kind === 'instruction' && s.state === 'active')
    .map((s) => `- ${s.name}: ${s.description ?? ''}`)
    .slice(0, 30)
    .join('\n');

  const user = [
    `TASK COMPLETED: ${issue.title}`,
    issue.description ? `Goal: ${issue.description.slice(0, 400)}` : '',
    `Files changed: ${input.filesChanged.join(', ') || '(none)'}`,
    `Outcome summary: ${input.summary.slice(0, 600)}`,
    '',
    existing
      ? `Existing skills (prefer IMPROVE over a near-duplicate):\n${existing}`
      : 'No skills exist yet.',
    '',
    'Decide: should a reusable skill be created or improved? Respond in the exact format.',
  ]
    .filter(Boolean)
    .join('\n');

  let raw: string;
  try {
    const args = ['--print', '-'];
    if (input.premium.model && input.premium.model !== 'default')
      args.push('--model', input.premium.model);
    raw = await spawnCapture('claude', args, `${REVIEW_SYSTEM}\n\n${user}`, 60_000);
  } catch {
    return; // review é best-effort
  }

  const parsed = parseReview(raw);
  if (parsed.decision === 'NONE' || !parsed.name || !parsed.content) return;
  if (parsed.content.length > 8000) parsed.content = parsed.content.slice(0, 8000);

  try {
    if (parsed.decision === 'CREATE') {
      const created = skillRepo.create({
        workspaceId: issue.workspaceId,
        name: parsed.name.slice(0, 100),
        kind: 'instruction',
        description: parsed.description ?? null,
        content: parsed.content,
        createdBy: 'agent',
      });
      for (const a of agentRepo.listByWorkspace(issue.workspaceId))
        skillRepo.attach(a.id, created.id);
      trace({
        level: 'success',
        source: 'issue',
        scope: 'run',
        issueKey: issue.issueKey,
        workspaceId: issue.workspaceId,
        message: `skill-review: criou a skill "${created.name}" a partir desta execução`,
      });
    } else if (parsed.decision === 'IMPROVE') {
      const ref = parsed.name.toLowerCase();
      const target = skillRepo
        .listByWorkspace(issue.workspaceId)
        .find((s) => s.name.toLowerCase() === ref || s.slug.toLowerCase() === ref);
      // Só melhora skills criadas pelo agente (protege as do usuário/marketplace).
      if (target && target.createdBy === 'agent') {
        const merged = `${target.content.trim()}\n\n${parsed.content}`.trim().slice(0, 8000);
        skillRepo.update(target.id, { content: merged });
        skillRepo.bumpUse(target.id);
        trace({
          level: 'success',
          source: 'issue',
          scope: 'run',
          issueKey: issue.issueKey,
          workspaceId: issue.workspaceId,
          message: `skill-review: melhorou a skill "${target.name}"`,
        });
      }
    }
  } catch (err) {
    console.warn('[skill-review] falha ao aplicar decisão:', err);
  }
}
