import darkLogo from '@renderer/assets/orkestral-o-dark.svg';
import lightLogo from '@renderer/assets/orkestral-o-light.svg';
import { cn } from '@renderer/lib/utils';

/**
 * Logo "O" facetada do Orkestral, THEME-AWARE: o SVG de polígonos CLAROS no tema dark
 * e o de polígonos ESCUROS no tema light. O swap é por CSS ([data-theme='light'] no
 * <html>) — robusto a como o tema é resolvido (inclui o modo system). Renderiza os
 * dois <img>; só um fica visível (o outro é display:none, sem custo de layout).
 */
export function OrkestralMark({ className }: { className?: string }) {
  return (
    <>
      <img
        src={darkLogo}
        alt="Orkestral"
        draggable={false}
        className={cn('orkestral-o orkestral-o--dark', className)}
      />
      <img
        src={lightLogo}
        alt="Orkestral"
        draggable={false}
        className={cn('orkestral-o orkestral-o--light', className)}
      />
    </>
  );
}
