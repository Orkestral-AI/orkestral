/**
 * Motor v2: o orquestrador de uma issue (a checklist de checkboxes).
 *
 * Roda cada checkbox pelo loop (executeCheckbox). Verde: escreve o arquivo no disco e marca
 * o box (verde = build verde, prova). Esgotou: escala SO aquele checkbox pro premium
 * (conduct), que reve com o estado real; o codigo do premium tambem passa por import +
 * typecheck antes de aplicar. Acumula a contabilidade premium vs local e emite um snapshot
 * compacto a cada checkpoint (o que o premium veria na conducao adaptativa).
 *
 * Ver docs/MOTOR-FATIAS-VERTICAIS.md, secoes 3, 4 e 5.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { executeCheckbox, type Checkbox, type GenerateFn } from './execute-checkbox';
import { validateImports, type ImportViolation } from './import-validator';
import type { DesignContract } from './design-system';
import { typecheckProject, type CompilerDiagnostic } from './compiler-check';
import {
  emptyLedger,
  addPremium,
  addLocal,
  economyReport,
  type TokenLedger,
  type EconomyReport,
} from './token-ledger';

export interface Issue {
  id: string;
  title: string;
  checkboxes: Checkbox[];
}

export interface ConductInput {
  checkbox: Checkbox;
  /** Trilha das tentativas locais (o snapshot compacto). */
  trail: string[];
  violations: ImportViolation[];
  diagnostics: CompilerDiagnostic[];
  currentCode: string | null;
}

export interface ConductOutput {
  /** O codigo que o premium propoe pro arquivo. */
  code: string;
  premiumIn: number;
  premiumOut: number;
}

/** O premium entra so no checkpoint/escalada, olhando o estado real e devolvendo uma correcao. */
export type ConductFn = (input: ConductInput) => Promise<ConductOutput>;

export interface CheckpointSnapshot {
  checkboxId: string;
  instruction: string;
  status: 'done' | 'blocked';
  attempts: number;
  escalated: boolean;
  buildGreen: boolean;
  remaining: number;
}

export interface CheckboxRunResult {
  checkbox: Checkbox;
  status: 'done' | 'blocked';
  attempts: number;
  escalated: boolean;
  fileWritten: string | null;
}

export interface RunIssueResult {
  issueId: string;
  results: CheckboxRunResult[];
  doneCount: number;
  blockedCount: number;
  ledger: TokenLedger;
  economy: EconomyReport;
  snapshots: CheckpointSnapshot[];
}

export interface RunIssueInput {
  issue: Issue;
  projectRoot: string;
  /** Forge local (atras da interface; o adapter real chama o llamaChat). */
  generate: GenerateFn;
  /** Premium no checkpoint/escalada. */
  conduct: ConductFn;
  ledger?: TokenLedger;
  maxAttempts?: number;
  /** Contrato de design congelado, repassado a cada checkbox como gate. */
  designContract?: DesignContract;
  /** Arquivos que ja existem no projeto (ATERRA: passados ao generate). */
  existingFiles?: string[];
  /** Cancelamento: aborta entre checkboxes. */
  signal?: AbortSignal;
  /** Injetaveis pra teste; default = fs real. */
  writeFile?: (absPath: string, content: string) => void;
  readFile?: (absPath: string) => string | null;
  /** Callback de progresso em tempo real (o "3/6" enchendo). */
  onCheckpoint?: (snapshot: CheckpointSnapshot) => void;
}

/** Containment: o alvo tem que estar DENTRO do projeto (o path vem do JSON do premium). */
function isWithinRoot(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function defaultRead(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function defaultWrite(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
}

/**
 * Executa a issue inteira, checkbox por checkbox. Verde aplica + marca; esgotado escala pro
 * premium (que tambem e validado); o que nem o premium resolve fica `blocked` (honesto, nao
 * "concluido" falso). Devolve os boxes, o ledger e a economia liquida.
 */
export async function runIssue(input: RunIssueInput): Promise<RunIssueResult> {
  const {
    issue,
    projectRoot,
    generate,
    conduct,
    maxAttempts = 4,
    designContract,
    writeFile = defaultWrite,
    readFile = defaultRead,
    onCheckpoint,
  } = input;
  const ledger = input.ledger ?? emptyLedger();
  const results: CheckboxRunResult[] = [];
  const snapshots: CheckpointSnapshot[] = [];

  for (let i = 0; i < issue.checkboxes.length; i++) {
    if (input.signal?.aborted) break;
    const checkbox = issue.checkboxes[i];

    // 0) containment: alvo fora do projeto = bloqueia, nunca escreve (path do premium).
    if (!isWithinRoot(projectRoot, checkbox.targetFile)) {
      results.push({
        checkbox,
        status: 'blocked',
        attempts: 0,
        escalated: false,
        fileWritten: null,
      });
      const snapshot: CheckpointSnapshot = {
        checkboxId: checkbox.id,
        instruction: checkbox.instruction,
        status: 'blocked',
        attempts: 0,
        escalated: false,
        buildGreen: false,
        remaining: issue.checkboxes.length - (i + 1),
      };
      snapshots.push(snapshot);
      onCheckpoint?.(snapshot);
      continue;
    }

    // 1) tenta resolver local no loop (gera -> valida import -> compila -> ate verde).
    const local = await executeCheckbox({
      checkbox,
      projectRoot,
      generate,
      readFile,
      maxAttempts,
      designContract,
      availableComponents: designContract?.components,
      existingFiles: input.existingFiles,
    });
    addLocal(ledger, local.tokensLocal);

    let status: 'done' | 'blocked' = 'blocked';
    let escalated = false;
    let fileWritten: string | null = null;

    if (local.ok && local.finalCode != null) {
      writeFile(checkbox.targetFile, local.finalCode);
      checkbox.done = true;
      status = 'done';
      fileWritten = checkbox.targetFile;
    } else {
      // 2) escala SO esse checkbox pro premium, com o estado real (trail + diagnosticos).
      escalated = true;
      const verdict = await conduct({
        checkbox,
        trail: local.trail,
        violations: local.violations,
        diagnostics: local.diagnostics,
        currentCode: readFile(checkbox.targetFile),
      });
      addPremium(ledger, verdict.premiumIn, verdict.premiumOut);

      // o codigo do premium TAMBEM passa pela rede: import + typecheck. Premium tambem erra.
      const pv = validateImports({
        filePath: checkbox.targetFile,
        code: verdict.code,
        projectRoot,
      });
      const ptc =
        pv.length === 0
          ? typecheckProject({
              projectRoot,
              overlay: { [checkbox.targetFile]: verdict.code },
              onlyFiles: [checkbox.targetFile],
            })
          : { ok: false, diagnostics: [] as CompilerDiagnostic[] };

      if (pv.length === 0 && ptc.ok) {
        writeFile(checkbox.targetFile, verdict.code);
        checkbox.done = true;
        status = 'done';
        fileWritten = checkbox.targetFile;
      } else {
        // nem o premium resolveu: fica bloqueado, honestamente. Nao marca "concluido".
        status = 'blocked';
      }
    }

    results.push({ checkbox, status, attempts: local.attempts, escalated, fileWritten });

    const snapshot: CheckpointSnapshot = {
      checkboxId: checkbox.id,
      instruction: checkbox.instruction,
      status,
      attempts: local.attempts,
      escalated,
      buildGreen: status === 'done',
      remaining: issue.checkboxes.length - (i + 1),
    };
    snapshots.push(snapshot);
    onCheckpoint?.(snapshot);
  }

  const doneCount = results.filter((r) => r.status === 'done').length;
  return {
    issueId: issue.id,
    results,
    doneCount,
    blockedCount: results.length - doneCount,
    ledger,
    economy: economyReport(ledger),
    snapshots,
  };
}
