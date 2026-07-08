/**
 * `orkestral doctor` — checagem de pré-requisitos do ambiente.
 *
 * Foco: os problemas que fazem o chat/canal parecer "travado" sem dizer por quê
 * (Node velho, CLI de agente ausente, sem credencial). Roda sem tocar no banco
 * e imprime um relatório com uma linha por check + veredito final.
 *
 * Chamado também no fim do `onboard`, pra o usuário não cair num chat mudo.
 */
import { which } from '../adapters/probe';

export interface DoctorCheck {
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean; // nenhum 'fail'
}

/** CLIs de agente que o Orkestral pilota. Pelo menos UM precisa existir + auth. */
const AGENT_CLIS: { bin: string; envKeys: string[]; install: string }[] = [
  {
    bin: 'claude',
    envKeys: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    install: 'npm i -g @anthropic-ai/claude-code',
  },
  { bin: 'codex', envKeys: ['OPENAI_API_KEY'], install: 'npm i -g @openai/codex' },
  {
    bin: 'gemini',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    install: 'npm i -g @google/gemini-cli',
  },
];

function checkNode(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major >= 22) {
    return { label: 'Node >= 22', status: 'pass', detail: `v${process.versions.node}` };
  }
  return {
    label: 'Node >= 22',
    status: 'fail',
    detail: `v${process.versions.node} — atualize (nativos e commander exigem 22+).`,
  };
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [checkNode()];

  // CLIs de agente: acha quais estão no PATH e se têm credencial.
  const found: string[] = [];
  for (const cli of AGENT_CLIS) {
    const path = await which(cli.bin);
    if (!path) continue;
    found.push(cli.bin);
    const hasKey = cli.envKeys.some((k) => !!process.env[k]);
    checks.push({
      label: `Agente \`${cli.bin}\``,
      status: hasKey ? 'pass' : 'warn',
      detail: hasKey
        ? `${path} (credencial via env ok)`
        : `${path} — sem ${cli.envKeys[0]} no ambiente; garanta login/API key (ou configure em Provedores).`,
    });
  }

  if (found.length === 0) {
    checks.push({
      label: 'CLI de agente no PATH',
      status: 'fail',
      detail:
        'Nenhum de claude/codex/gemini encontrado. O Orkestral NÃO é o modelo — ele pilota um desses. ' +
        `Instale ao menos um: ${AGENT_CLIS.map((c) => c.install).join('  |  ')}`,
    });
  }

  return { checks, ok: !checks.some((c) => c.status === 'fail') };
}

/** Imprime o relatório no stdout com ícones e retorna se passou (sem 'fail'). */
export function printDoctorReport(report: DoctorReport): boolean {
  const icon = { pass: '✓', warn: '!', fail: '✗' } as const;
  console.log('\nOrkestral doctor:');
  for (const c of report.checks) {
    console.log(`  ${icon[c.status]} ${c.label} — ${c.detail}`);
  }
  console.log(
    report.ok
      ? '\nTudo pronto pra rodar.\n'
      : '\nHá pendências acima que impedem o agente de responder — resolva antes de usar.\n',
  );
  return report.ok;
}
