import { Fragment, useMemo } from 'react';
import { Keyboard } from 'lucide-react';
import { PanelShell } from './PanelShell';
import {
  SHORTCUTS,
  SHORTCUT_GROUP_ORDER,
  type ShortcutDef,
  type ShortcutGroup,
} from '@renderer/hooks/useKeyboardShortcuts';
import { useT } from '@renderer/i18n';

/**
 * Atalhos — derivado 100% do registry `SHORTCUTS` (a mesma lista que o hook
 * realmente registra). Não há atalho hardcoded aqui: o que aparece é o que
 * existe. Agrupado por Navegação / Chat / Geral.
 */
export function ShortcutsPanel() {
  const { t } = useT();
  const groups = useMemo(() => {
    const map = new Map<ShortcutGroup, ShortcutDef[]>();
    for (const g of SHORTCUT_GROUP_ORDER) map.set(g, []);
    for (const s of SHORTCUTS) map.get(s.group)?.push(s);
    return SHORTCUT_GROUP_ORDER.map((g) => ({ group: g, items: map.get(g) ?? [] })).filter(
      (row) => row.items.length > 0,
    );
  }, []);

  return (
    <PanelShell
      icon={Keyboard}
      title={t('settings.shortcuts.title')}
      description={t('settings.shortcuts.description')}
    >
      {groups.map((row) => (
        <div key={row.group}>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
            {row.group}
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-surface/40">
            {row.items.map((s, i) => (
              <div
                key={s.id}
                className={`flex items-center justify-between gap-4 px-3.5 py-2.5 ${
                  i > 0 ? 'border-t border-border' : ''
                }`}
              >
                <span className="text-[12.5px] text-text-secondary">{s.label}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {s.keys.map((k, ki) => (
                    <Fragment key={k}>
                      {ki > 0 && <span className="text-[10px] text-text-faint">+</span>}
                      <kbd className="rounded border border-hairline bg-surface-hover px-1.5 py-0.5 font-mono text-[10.5px] text-text-muted">
                        {k}
                      </kbd>
                    </Fragment>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </PanelShell>
  );
}
