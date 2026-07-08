import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { FolderGit2, GitBranch, Plus, Trash2 } from 'lucide-react';
import { TopToolbar } from '@renderer/components/chat/TopToolbar';
import { useT } from '@renderer/i18n';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useUIStore } from '@renderer/stores/uiStore';
import type { Project } from '@shared/types';

/**
 * Lista de projetos do workspace ativo. Card "card sobre fundo" igual ao
 * resto do app, com top toolbar + header + grid de projetos.
 */
export function ProjectsPage() {
  const { t } = useT();
  const workspace = useWorkspaceStore((s) => s.active);
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  const activeProject = useWorkspaceStore((s) => s.activeProject);
  const queryClient = useQueryClient();
  const openNewProject = useUIStore((s) => s.openNewProject);

  const projectsQuery = useQuery({
    queryKey: ['projects', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['project:list']({ workspaceId: workspace!.id }),
  });
  const projects = projectsQuery.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: (projectId: string) => window.orkestral['project:delete']({ projectId }),
    onSuccess: (_data, projectId) => {
      if (activeProject?.id === projectId) setActiveProject(null);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <TopToolbar />

        <div className="no-scrollbar flex-1 overflow-y-auto px-8 pb-10 pt-6">
          {/* Header */}
          <div className="mb-8 flex items-center justify-between gap-6">
            <div>
              <h1 className="text-[20px] font-medium tracking-tight text-text-primary">
                {t('workspace.projects.title')}
              </h1>
              <p className="mt-0.5 text-[13px] text-text-secondary">
                {t('workspace.projects.subtitle')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => openNewProject()}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-text-primary px-3.5 text-[13px] font-medium text-background transition-colors hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('workspace.projects.newProject')}
            </button>
          </div>

          {/* Lista */}
          {projects.length === 0 ? (
            <EmptyState onCreate={() => openNewProject()} />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {projects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  active={activeProject?.id === p.id}
                  onSelect={() => setActiveProject(p)}
                  onDelete={() => {
                    if (confirm(t('workspace.projects.confirmRemove', { name: p.name }))) {
                      deleteMutation.mutate(p.id);
                    }
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  active,
  onSelect,
  onDelete,
}: {
  project: Project;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  return (
    <div
      className={
        'group relative flex flex-col gap-3 rounded-xl border p-4 transition-all ' +
        (active
          ? 'border-white/20 bg-white/[0.045]'
          : 'border-hairline-med bg-surface-faint hover:border-hairline-bright hover:bg-surface-1')
      }
    >
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface-1 text-text-primary">
          <FolderGit2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-text-primary">{project.name}</div>
          {project.path && (
            <div className="truncate font-mono text-[11px] text-text-muted">{project.path}</div>
          )}
        </div>
      </div>
      {project.description && (
        <div className="text-[12px] leading-relaxed text-text-secondary line-clamp-2">
          {project.description}
        </div>
      )}
      <div className="flex items-center gap-3 text-[10.5px] text-text-muted">
        <div className="inline-flex items-center gap-1">
          <GitBranch className="h-3 w-3" />
          {project.provider === 'github'
            ? t('workspace.projects.providerGithub')
            : t('workspace.projects.providerLocal')}
        </div>
        {project.gitRemote && <div className="truncate font-mono">{project.gitRemote}</div>}
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-hairline-soft pt-3">
        <button
          type="button"
          onClick={onSelect}
          className="text-[12px] font-medium text-text-primary transition-colors hover:text-white"
        >
          {active ? t('workspace.projects.activeProject') : t('workspace.projects.makeActive')}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="grid h-7 w-7 place-items-center rounded text-text-muted opacity-0 transition-all hover:bg-accent-red/10 hover:text-accent-red group-hover:opacity-100"
          title={t('workspace.projects.remove')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useT();
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-hairline-faint bg-surface-ghost px-6 py-16">
      <div className="grid h-12 w-12 place-items-center rounded-xl border border-hairline bg-surface-subtle">
        <FolderGit2 className="h-5 w-5 text-text-faint" />
      </div>
      <div className="text-center">
        <div className="text-[14.5px] font-medium text-text-primary">
          {t('workspace.projects.emptyTitle')}
        </div>
        <div className="mt-1 max-w-[320px] text-[12.5px] text-text-muted">
          {t('workspace.projects.emptyDescription')}
        </div>
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-md bg-text-primary px-3.5 text-[13px] font-medium text-background transition-colors hover:opacity-90"
      >
        <Plus className="h-3.5 w-3.5" />
        {t('workspace.projects.createFirst')}
      </button>
    </div>
  );
}
