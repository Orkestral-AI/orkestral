/**
 * Enforce de escopo da Cápsula — a SEGURANÇA anti-fora-de-escopo aplicada de VERDADE
 * (não só dita no prompt, como hoje). O Forge só produz texto; o app aplica — então
 * BLOQUEAMOS aqui, antes de escrever: caminho fora dos alvos da cápsula, ou casando
 * `lockedPaths` (migrations/auth/secret), nunca persiste. Determinístico, sem modelo.
 */
import type { TaskCapsule } from '../../../shared/types/capsule';

/** Globs padrão sempre bloqueados (sobrescrita acidental em área sensível). */
export const DEFAULT_LOCKED_GLOBS = [
  '**/migrations.ts',
  '**/migrations/**',
  '**/*secret*',
  '**/auth/**',
  '**/.env*',
  '**/credentials*',
];

/** Converte um glob simples (`**`, `*`) num RegExp ancorado, char a char (sem control chars). */
function globToRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` = zero-ou-mais segmentos de diretório (casa arquivo na RAIZ também:
        // `**/.env*` precisa pegar `.env`). `**` solto = qualquer coisa.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i++;
        }
      } else {
        re += '[^/]*';
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * Decide se ESCREVER em `file` viola o escopo da cápsula. Retorna o motivo (string) ou
 * null se permitido. `file` é relativo ao repo.
 */
export function scopeViolation(capsule: TaskCapsule, file: string): string | null {
  const rel = file.replace(/^\.?\//, '');
  // 1) lockedPaths (da cápsula + defaults) — área sensível, bloqueia sempre.
  const locked = [...DEFAULT_LOCKED_GLOBS, ...capsule.scope.lockedPaths];
  for (const g of locked) {
    if (globToRe(g).test(rel)) return `caminho bloqueado por escopo (${g}): ${rel}`;
  }
  // 2) Não pode tocar arquivo fora dos alvos declarados (a menos que seja criação permitida).
  const isTarget = capsule.targets.some((t) => t.file.replace(/^\.?\//, '') === rel);
  if (!isTarget && !capsule.scope.allowNewFiles) {
    return `arquivo fora dos alvos da cápsula: ${rel}`;
  }
  return null;
}
