/**
 * Motor v2: gate de saida pro engine VIVO (smart-exec).
 *
 * Esta e a troca minima e reversivel: depois que o Forge (smart-exec) aplica um patch, os
 * arquivos mudados passam pelos gates do engine-v2 (import fantasma + substancia + compila o
 * projeto). Reprovou = o engine vivo NAO aceita como "feito" (escala pro premium em vez de
 * shipar lixo). E o que faltava no chatbot_v3: o engine aceitava codigo alucinado/que nao
 * compila.
 *
 * So checa arquivos TS/TSX. Nunca lanca: erro de infra vira ok=true (nao bloqueia por bug
 * do gate, so por problema real comprovado).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateImports } from './import-validator';
import { typecheckProject, hasCodeSubstance } from './compiler-check';

const TS_RE = /\.(ts|tsx|mts|cts)$/;

export interface ForgeGateVerdict {
  ok: boolean;
  reasons: string[];
}

/**
 * Valida os arquivos que o Forge mudou (ja aplicados no disco) contra os gates do engine-v2.
 * `projectRoot` = o cwd do repo; `changedFiles` = caminhos (abs ou relativos ao root).
 */
export function validateForgeOutput(projectRoot: string, changedFiles: string[]): ForgeGateVerdict {
  const reasons: string[] = [];
  const tsFiles = changedFiles.filter((f) => TS_RE.test(f));
  if (tsFiles.length === 0) return { ok: true, reasons: [] };

  // Precisa de tsconfig pra checar; sem ele, nao da pra validar com seguranca -> nao bloqueia.
  if (!fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) return { ok: true, reasons: [] };

  for (const f of tsFiles) {
    const abs = path.isAbsolute(f) ? f : path.join(projectRoot, f);
    let code: string;
    try {
      code = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // arquivo sumiu (ex: deletado de proposito): nao acusa.
    }
    try {
      const viol = validateImports({ filePath: abs, code, projectRoot });
      if (viol.length > 0) {
        reasons.push(
          `${path.basename(f)}: import inexistente (${viol.map((v) => v.source).join(', ')})`,
        );
      }
      if (!hasCodeSubstance(code)) {
        reasons.push(`${path.basename(f)}: arquivo trivial (vazio/so string/so comentario)`);
      }
    } catch {
      // erro de parse do validador: ignora (nao bloqueia por bug do gate).
    }
  }

  // Compila o projeto inteiro no estado atual do disco (pega quebra em cascata).
  try {
    const tc = typecheckProject({ projectRoot });
    if (!tc.ok) {
      const head = tc.diagnostics
        .slice(0, 3)
        .map((d) => `TS${d.code} ${d.message}`)
        .join('; ');
      reasons.push(`build quebrado: ${head}`);
    }
  } catch {
    // erro de infra do typecheck: nao bloqueia.
  }

  return { ok: reasons.length === 0, reasons };
}
