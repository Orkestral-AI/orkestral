/**
 * Roda uma fatia do motor v2 VIVA, num terminal, sem Electron.
 *
 * O provider premium configurado (claude/codex) faz o plano E a execucao. Isso prova o
 * engine de ponta a ponta com modelo real num repo real, e te da o BASELINE de economia
 * (premium fazendo tudo, sem o Forge local). Depois, dentro do app, o Forge entra como
 * executor e a gente compara o numero.
 *
 * Uso:
 *   npx tsx scripts/engine-v2-slice.ts --repo /caminho/do/projeto --intent "cria uma tela /status com um card"
 *   (opcional) --adapter claude_local|codex_local  --model <modelo>
 *
 * ATENCAO: cada chamada premium custa (o CLI injeta contexto sozinho, ~11k tokens/chamada).
 * Uma fatia pequena = algumas chamadas. Comece com um intent pequeno.
 */
import { createEngineV2 } from '../src/main/services/engine-v2/entry';
import { createAdapterPremiumChat } from '../src/main/services/engine-v2/premium-runner';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const repo = arg('repo');
  const intent = arg('intent');
  const adapterType = arg('adapter', 'claude_local')!;
  const model = arg('model', 'default')!;

  if (!repo || !intent) {
    console.error('uso: npx tsx scripts/engine-v2-slice.ts --repo <dir> --intent "<o que fazer>"');
    process.exit(1);
  }

  console.log(`\n engine-v2 fatia viva`);
  console.log(`  repo:    ${repo}`);
  console.log(`  intent:  ${intent}`);
  console.log(
    `  premium: ${adapterType} (${model}) — faz plano + execucao (baseline, sem Forge)\n`,
  );

  const premium = createAdapterPremiumChat({ adapterType, model, cwd: repo });
  const motor = createEngineV2({
    premiumChat: premium,
    // baseline: o premium tambem executa (no app, isso vira o Forge local).
    forgeChat: (system, user) => premium(system, user).then((r) => r.text),
  });

  const res = await motor.run({
    intent,
    projectRoot: repo,
    onCheckpoint: (s) =>
      console.log(
        `  [${s.status === 'done' ? 'ok' : 'BLOCKED'}] ${s.checkboxId}: ${s.instruction} (${s.remaining} restantes)`,
      ),
    onPreviewReady: (p) => console.log(`\n  preview: ${p.mode} ${p.url ?? ''} — ${p.reason}\n`),
  });

  console.log(`\n===== RESULTADO =====`);
  if (!res.planned) {
    console.log(`plano REJEITADO (nao rodou nada):`);
    for (const v of res.planViolations) console.log(`  - ${v}`);
    return;
  }
  for (const i of res.issues) {
    console.log(
      `  issue ${i.issueId} "${i.title}"${i.isWalkingSkeleton ? ' [esqueleto]' : ''}: ${i.doneCount} ok, ${i.blockedCount} bloqueado`,
    );
  }
  console.log(`\n  total: ${res.totalDone} provados, ${res.totalBlocked} bloqueados`);
  console.log(`  ${res.economyLine}`);
  console.log(
    `  (este run e o BASELINE: premium fez tudo. No app, o Forge executa e a gente compara.)\n`,
  );
}

main().catch((e) => {
  console.error('\nengine-v2 falhou:', e instanceof Error ? e.message : e);
  process.exit(1);
});
