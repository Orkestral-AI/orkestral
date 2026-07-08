import { cn } from '@renderer/lib/utils';
import type { Workspace } from '@shared/types';

interface WorkspaceAvatarProps {
  workspace: Pick<Workspace, 'name' | 'color' | 'icon'> | null;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Avatar visual de um workspace — círculo com inicial e gradient baseado na cor.
 * Usado no WorkspaceSwitcher e na lista de workspaces.
 */
export function WorkspaceAvatar({ workspace, size = 'md', className }: WorkspaceAvatarProps) {
  const initial = (workspace?.name ?? 'O').trim().charAt(0).toUpperCase();
  const baseColor = workspace?.color ?? '#A78BFA';
  const gradient = `linear-gradient(135deg, ${baseColor}, ${baseColor}90)`;

  const dims = size === 'sm' ? 'h-5 w-5 text-[10px]' : 'h-6 w-6 text-[11px]';

  return (
    <div
      className={cn(
        'grid shrink-0 place-items-center rounded-md font-semibold text-white',
        dims,
        className,
      )}
      style={{ background: gradient }}
    >
      {initial}
    </div>
  );
}

export function workspaceCode(name: string): string {
  return name.trim().slice(0, 3).toUpperCase();
}
