/**
 * Handoff premium→local de EDIÇÃO. Quando o modelo local (Forge) não consegue
 * produzir/aplicar um edit, em vez de escalar a issue inteira pra um run premium
 * completo (que relê o repo, usa MCP tools, etc.), o premium gera SÓ o lazy-edit
 * preciso pra UM arquivo (barato) e o app aplica de forma determinística
 * (mergeLazyEdit) — mantendo o trabalho no caminho smart-exec (apply + validação).
 *
 * É exatamente a "explicação específica do premium pro local": o premium produz o
 * edit no MESMO formato que o local produziria, então o merge determinístico (já
 * robusto) o aplica. Só cai pro run premium completo se ISSO também falhar.
 *
 * Suportado via CLI do `claude --print` (saída texto plana). Codex (saída JSON)
 * não é suportado aqui → deixa escalar pro caminho premium completo.
 */
import { spawn } from 'node:child_process';
import {
  EDIT_SYSTEM,
  buildEditUserPrompt,
  interpret,
  type LocalEditResult,
  type LocalPatchInput,
} from './local-patcher';
import type { AdapterType, SmartExecConfig } from '../../../shared/types';
import { scrubSpawnEnv } from '../spawn-policy';

/** Orçamento de contexto pro premium (aguenta o arquivo inteiro). ~127 KB. */
const PREMIUM_EDIT_PROMPT_TOKENS = 32_000;

export function spawnCapture(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      // Scrub de secrets não-relacionados (mantém a auth do agente via SCRUB_KEEP) — o
      // spawn roda o claude real (gera edits aplicados ao repo), não vaza GITHUB_TOKEN/*_SECRET.
      child = spawn(command, args, { shell: false, env: scrubSpawnEnv(process.env) });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`premium edit: timeout após ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (out.trim().length > 0) resolve(out);
      else reject(new Error(err.trim() || `premium edit: saiu com código ${code}`));
    });
    // Escreve o prompt e só fecha o stdin DEPOIS do flush — prompts grandes
    // (~128 KB) podem não drenar antes do end(), truncando a entrada do CLI.
    if (child.stdin) {
      // EPIPE quando o child já fechou stdin — logar e ignorar, não derrubar o main.
      child.stdin.on('error', (e) =>
        console.warn('[premium-edit] stdin error (ignorado):', e?.message),
      );
      child.stdin.write(stdin, () => child.stdin?.end());
    }
  });
}

/**
 * Gera o lazy-edit pra UM arquivo usando o modelo premium (claude). Retorna no
 * mesmo shape do executor local — o caller aplica via applyLazyEdit. Em qualquer
 * falha (binário ausente, timeout, adapter não suportado), devolve `cannot` e o
 * caller escala pro run premium completo.
 */
export async function generatePremiumEdit(
  cfg: SmartExecConfig,
  input: LocalPatchInput,
  adapter: AdapterType,
  model: string | null,
): Promise<LocalEditResult> {
  if (adapter !== 'claude_local') return { kind: 'cannot', raw: '' };
  const user = buildEditUserPrompt(input, PREMIUM_EDIT_PROMPT_TOKENS);
  const prompt = `${EDIT_SYSTEM}\n\n${user}`;
  const args = ['--print', '-'];
  if (model && model !== 'default') args.push('--model', model);
  try {
    const out = await spawnCapture('claude', args, prompt, cfg.local.timeoutMs);
    return interpret(out);
  } catch {
    return { kind: 'cannot', raw: '' };
  }
}
