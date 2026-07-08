import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Copy, FolderOpen, ListTree, MessageSquarePlus } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { getFileIconUrl } from '@renderer/lib/materialIcons';
import { useCodeTabsStore, type CodeTab } from '@renderer/stores/codeTabsStore';
import { useCodeIdeStore } from '@renderer/stores/codeIdeStore';
import {
  useContextMenu,
  ContextMenu,
  type ContextMenuItem,
} from '@renderer/components/ui/context-menu';
import { useT } from '@renderer/i18n';
import { toast } from '@renderer/stores/toastStore';
import { addFileToChat } from '@renderer/lib/addFileToChat';

export function EditorTabs({ sourceId, sourceRoot }: { sourceId: string; sourceRoot: string }) {
  const tabs = useCodeTabsStore((s) => s.tabs);
  const active = useCodeTabsStore((s) => s.active);
  const setActive = useCodeTabsStore((s) => s.setActive);
  const closeTab = useCodeTabsStore((s) => s.closeTab);
  const closeOthers = useCodeTabsStore((s) => s.closeOthers);
  const closeToRight = useCodeTabsStore((s) => s.closeToRight);
  const closeSaved = useCodeTabsStore((s) => s.closeSaved);
  const closeAll = useCodeTabsStore((s) => s.closeAll);

  const { t } = useT();
  const navigate = useNavigate();
  const menu = useContextMenu();
  const [menuTab, setMenuTab] = useState<CodeTab | null>(null);

  if (tabs.length === 0) return null;

  const isActive = (tab: CodeTab) =>
    active?.sourceId === tab.sourceId && active?.relPath === tab.relPath;

  const handleClose = (tab: CodeTab) => {
    if (tab.dirty && !window.confirm(t('layout.codeIde.tabCloseDirtyConfirm'))) return;
    closeTab(tab.sourceId, tab.relPath);
  };

  // Confirms once if a bulk close would discard dirty tabs.
  const guardedBulkClose = (affected: CodeTab[], action: () => void) => {
    if (
      affected.some((tab) => tab.dirty) &&
      !window.confirm(t('layout.codeIde.tabCloseDirtyConfirm'))
    )
      return;
    action();
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => undefined);
    toast.success(t('layout.codeIde.copiedPath'));
  };

  const items: ContextMenuItem[] = menuTab
    ? [
        {
          label: t('layout.codeIde.tabClose'),
          icon: <X className="h-3.5 w-3.5" />,
          onSelect: () => handleClose(menuTab),
        },
        {
          label: t('layout.codeIde.tabCloseOthers'),
          onSelect: () =>
            guardedBulkClose(
              tabs.filter(
                (tab) => !(tab.sourceId === menuTab.sourceId && tab.relPath === menuTab.relPath),
              ),
              () => closeOthers(menuTab.sourceId, menuTab.relPath),
            ),
        },
        {
          label: t('layout.codeIde.tabCloseRight'),
          onSelect: () => {
            const idx = tabs.findIndex(
              (tab) => tab.sourceId === menuTab.sourceId && tab.relPath === menuTab.relPath,
            );
            guardedBulkClose(idx >= 0 ? tabs.slice(idx + 1) : [], () =>
              closeToRight(menuTab.sourceId, menuTab.relPath),
            );
          },
        },
        {
          label: t('layout.codeIde.tabCloseSaved'),
          onSelect: () => closeSaved(),
        },
        {
          label: t('layout.codeIde.tabCloseAll'),
          onSelect: () => guardedBulkClose(tabs, () => closeAll()),
        },
        { type: 'separator' },
        {
          label: t('layout.codeIde.ctxCopyPath'),
          icon: <Copy className="h-3.5 w-3.5" />,
          onSelect: () => copy(`${sourceRoot}/${menuTab.relPath}`),
        },
        {
          label: t('layout.codeIde.ctxCopyRelPath'),
          icon: <Copy className="h-3.5 w-3.5" />,
          onSelect: () => copy(menuTab.relPath),
        },
        { type: 'separator' },
        {
          label: t('layout.codeIde.ctxRevealFinder'),
          icon: <FolderOpen className="h-3.5 w-3.5" />,
          onSelect: () =>
            window.orkestral['source:reveal']({ sourceId, relPath: menuTab.relPath }).catch(() =>
              toast.error(t('layout.codeIde.revealError')),
            ),
        },
        {
          label: t('layout.codeIde.ctxRevealTree'),
          icon: <ListTree className="h-3.5 w-3.5" />,
          onSelect: () =>
            useCodeIdeStore.getState().requestReveal(menuTab.sourceId, menuTab.relPath),
        },
        {
          label: t('layout.codeIde.ctxAddToChat'),
          icon: <MessageSquarePlus className="h-3.5 w-3.5" />,
          onSelect: () => {
            addFileToChat(menuTab.relPath, t('layout.codeIde.openedInChat'));
            navigate('/');
          },
        },
      ]
    : [];

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-hairline-soft">
      {tabs.map((tab) => (
        <div
          key={`${tab.sourceId}:${tab.relPath}`}
          onContextMenu={(e) => {
            menu.open(e);
            setMenuTab(tab);
          }}
          className={cn(
            'group flex items-center gap-1.5 border-r border-hairline-faint px-3 text-[12px] transition-colors',
            {
              'bg-surface-1 text-text-primary': isActive(tab),
              'text-text-muted hover:bg-surface-subtle hover:text-text-secondary': !isActive(tab),
            },
          )}
        >
          <button
            type="button"
            onClick={() => setActive(tab.sourceId, tab.relPath)}
            className="flex items-center gap-1.5 truncate"
          >
            {(() => {
              const iconUrl = getFileIconUrl(tab.name);
              return iconUrl ? <img src={iconUrl} className="h-4 w-4 shrink-0" alt="" /> : null;
            })()}
            <span className="truncate">{tab.name}</span>
          </button>
          {tab.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary" />}
          <button
            type="button"
            onClick={() => handleClose(tab)}
            className="ml-0.5 grid h-4 w-4 place-items-center rounded text-text-faint opacity-0 transition-opacity hover:bg-surface-strong hover:text-text-primary group-hover:opacity-100"
            aria-label={t('layout.codeIde.tabCloseAria')}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      {menu.state && menuTab && (
        <ContextMenu x={menu.state.x} y={menu.state.y} items={items} onClose={menu.close} />
      )}
    </div>
  );
}
