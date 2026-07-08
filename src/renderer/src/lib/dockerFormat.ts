/** Helpers de formatação das views do Docker (separados dos componentes p/ não
 *  quebrar o fast-refresh — arquivo de componentes só deve exportar componentes). */

export function fmtBytes(bytes: number): string {
  if (bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / Math.pow(1024, i);
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/** Aceita ISO/string do docker OU unix-segundos (imagens). */
export function fmtDate(input: string | number): string {
  if (!input) return '—';
  const d = typeof input === 'number' ? new Date(input * 1000) : new Date(input);
  if (Number.isNaN(d.getTime())) return typeof input === 'string' ? input : '—';
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
