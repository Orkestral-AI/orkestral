import { type ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { UpdateModal } from './UpdateModal';
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts';

export function AppShell({ children }: { children: ReactNode }) {
  useKeyboardShortcuts();
  // Navegação de DOIS TRILHOS (Sidebar): trilho fino de ícones + painel contextual de
  // largura fixa. Não há mais drag-to-resize (o SidebarResizer foi removido com isso).
  return (
    <div className="relative flex h-full w-full bg-sidebar text-text-primary">
      <Sidebar />
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
      </main>
      <UpdateModal />
    </div>
  );
}
