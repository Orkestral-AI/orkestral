import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Combina classes Tailwind com merge inteligente (resolve conflitos de utilitários).
 * Padrão usado em todos os componentes do design system.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Helper pra atrasar uma execução. Útil em loading/streaming simulado.
 */
export function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
