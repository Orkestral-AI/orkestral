/**
 * Modo de permissão do spawn de adapter, controlado SÓ pela CLI.
 *
 * A GUI nunca chama `setPermissionMode`, então o modo fica `default` pra ela —
 * e `default` é um NO-OP (não adiciona nenhuma flag além do que a SpawnPolicy já
 * decidiu). Resultado: runs da GUI ficam byte-idênticos. Só a CLI, com
 * `--permission-mode`/`--dangerously-skip-permissions`, muda o modo.
 *
 * Módulo SEM imports de propósito: é estado de processo puro, importável tanto
 * pela CLI quanto pelo spawn-policy (no `applyClaude/CodexPolicy`) sem risco de
 * ciclo.
 */
export const PERMISSION_MODE_VALUES = [
  'default',
  'acceptEdits',
  'plan',
  'dangerously-skip',
] as const;

export type PermissionMode = (typeof PERMISSION_MODE_VALUES)[number];

/** Type guard pra valores vindos de fora (flag da CLI, valor persistido no DB). */
export const isPermissionMode = (value: string): value is PermissionMode =>
  (PERMISSION_MODE_VALUES as readonly string[]).includes(value);

let mode: PermissionMode = 'default';

export const getPermissionMode = (): PermissionMode => mode;

export const setPermissionMode = (m: PermissionMode): void => {
  mode = m;
};
