import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Wand2,
  Plus,
  Search,
  Trash2,
  Save,
  Loader2,
  FileText,
  Server,
  Wrench,
  Store,
  Library,
  PencilLine,
  ChevronLeft,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { MarketplaceBrowser } from '@renderer/components/marketplace/MarketplaceBrowser';
import { SkillMarkdownEditor } from '@renderer/components/marketplace/SkillMarkdownEditor';
import { useT, type TFunction } from '@renderer/i18n';
import type { Skill, SkillKind } from '@shared/types';

const KIND_ICON: Record<SkillKind, typeof Wand2> = {
  instruction: FileText,
  mcp: Server,
  tool: Wrench,
};

function kindMeta(
  kind: SkillKind,
  t: TFunction,
): { label: string; icon: typeof Wand2; description: string } {
  const labelKey: Record<SkillKind, string> = {
    instruction: 'pages.skills.kindInstruction',
    mcp: 'pages.skills.kindMcp',
    tool: 'pages.skills.kindTool',
  };
  const descKey: Record<SkillKind, string> = {
    instruction: 'pages.skills.kindInstructionDesc',
    mcp: 'pages.skills.kindMcpDesc',
    tool: 'pages.skills.kindToolDesc',
  };
  return { label: t(labelKey[kind]), icon: KIND_ICON[kind], description: t(descKey[kind]) };
}

/** Tipos criáveis manualmente (MCPs vêm do marketplace na página de MCPs). */
const CREATABLE_KINDS: SkillKind[] = ['instruction', 'tool'];

type Tab = 'mine' | 'marketplace';

export function SkillsPage() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const [tab, setTab] = useState<Tab>('mine');

  if (!activeWorkspace) {
    return (
      <PageShell tab={tab} onTab={setTab}>
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('pages.skills.noActiveWorkspace')}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell tab={tab} onTab={setTab}>
      {tab === 'marketplace' ? (
        <MarketplaceBrowser kind="skill" workspaceId={activeWorkspace.id} />
      ) : (
        <MySkills workspaceId={activeWorkspace.id} />
      )}
    </PageShell>
  );
}

function MySkills({ workspaceId }: { workspaceId: string }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const skillsQuery = useQuery({
    queryKey: ['skills', workspaceId],
    queryFn: () => window.orkestral['skill:list']({ workspaceId }),
  });
  // Skills "editáveis": instruction/tool. MCPs vivem na página de MCPs.
  const skills = (skillsQuery.data ?? []).filter((s) => s.kind !== 'mcp');

  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q),
    );
  }, [skills, query]);

  const createMutation = useMutation({
    mutationFn: (input: { name: string; kind: SkillKind }) =>
      window.orkestral['skill:create']({
        workspaceId,
        name: input.name,
        kind: input.kind,
        // Sem `# nome` no corpo — o nome já é o título da página. O conteúdo é só
        // as instruções injetadas no prompt.
        content: '',
      }),
    onSuccess: (skill) => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      setCreating(false);
      setEditingId(skill.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => window.orkestral['skill:delete']({ skillId: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      setEditingId(null);
    },
  });

  // Edição = "página" dentro da área de Skills (com botão Voltar), sem modal.
  if (editingId) {
    return (
      <SkillDetail
        key={editingId}
        skillId={editingId}
        onBack={() => setEditingId(null)}
        onDelete={() => {
          const s = skills.find((x) => x.id === editingId);
          if (s && confirm(t('pages.skills.deleteConfirm', { name: s.name }))) {
            deleteMutation.mutate(editingId);
          }
        }}
      />
    );
  }

  if (creating) {
    return (
      <CreateSkillForm
        onBack={() => setCreating(false)}
        onCreate={(data) => createMutation.mutate(data)}
        busy={createMutation.isPending}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Busca + Nova skill */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-hairline-faint px-6 py-3.5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('pages.skills.searchPlaceholder')}
            className="h-10 w-full rounded-lg border border-hairline-strong bg-surface-subtle pl-10 pr-3 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
          />
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-accent/90"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('pages.skills.newSkill')}
        </button>
      </div>

      {/* Grid de cards */}
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {skillsQuery.isPending ? (
          <div className="py-16 text-center text-[12.5px] text-text-muted">
            {t('pages.skills.loading')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Wand2 className="h-8 w-8 text-text-faint" />
            <div className="mt-3 text-[13px] text-text-secondary">
              {skills.length === 0 ? t('pages.skills.noSkillsYet') : t('pages.skills.nothingFound')}
            </div>
            <div className="mt-1 max-w-xs text-[12px] leading-relaxed text-text-muted">
              {skills.length === 0
                ? t('pages.skills.emptyHintNew')
                : t('pages.skills.emptyHintTry')}
            </div>
          </div>
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(258px, 1fr))' }}
          >
            {filtered.map((s) => (
              <SkillCard key={s.id} skill={s} onOpen={() => setEditingId(s.id)} t={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Barra superior com "Voltar" — usada nas páginas de edição/criação. */
function BackBar({
  onBack,
  children,
  t,
}: {
  onBack: () => void;
  children?: ReactNode;
  t: TFunction;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-hairline-faint px-6 py-3">
      <button
        type="button"
        onClick={onBack}
        title={t('common.back')}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-hairline-strong text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      {children}
    </div>
  );
}

function SkillCard({ skill, onOpen, t }: { skill: Skill; onOpen: () => void; t: TFunction }) {
  const meta = kindMeta(skill.kind, t);
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full flex-col rounded-xl border border-hairline-med bg-surface-veil p-4 text-left transition-colors hover:border-hairline-bright hover:bg-surface-3"
    >
      <div className="flex items-center gap-2.5">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-accent-purple/25 bg-accent-purple/10 text-accent-purple">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-text-primary">
          {skill.name}
        </div>
        <PencilLine className="h-3.5 w-3.5 shrink-0 text-text-faint transition-colors group-hover:text-text-secondary" />
      </div>
      <p className="mt-2.5 line-clamp-2 flex-1 text-[12px] leading-relaxed text-text-muted">
        {skill.description || t('pages.skills.noDescription')}
      </p>
      <div className="mt-3 flex items-center gap-1.5">
        <span className="rounded border border-hairline-strong bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-text-secondary">
          {meta.label}
        </span>
        <span className="truncate font-mono text-[10px] text-text-faint">{skill.slug}</span>
      </div>
    </button>
  );
}

function CreateSkillForm({
  onBack,
  onCreate,
  busy,
}: {
  onBack: () => void;
  onCreate: (data: { name: string; kind: SkillKind }) => void;
  busy: boolean;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SkillKind>('instruction');
  const valid = name.trim().length >= 2;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BackBar onBack={onBack} t={t} />
      <div className="thin-scrollbar flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-lg flex-col gap-6 px-8 py-8">
          <div>
            <h2 className="text-[17px] font-semibold tracking-tight text-text-primary">
              {t('pages.skills.createTitle')}
            </h2>
            <p className="mt-1 text-[12.5px] text-text-muted">{t('pages.skills.createDesc')}</p>
          </div>
          <Field label={t('pages.skills.fieldName')}>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('pages.skills.namePlaceholder')}
              className="h-10 w-full rounded-lg border border-hairline-strong bg-surface-subtle px-3.5 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent-purple/40"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && valid) onCreate({ name: name.trim(), kind });
              }}
            />
          </Field>
          <Field label={t('pages.skills.fieldType')}>
            <DSSelect
              value={kind}
              onChange={(v) => setKind(v as SkillKind)}
              options={CREATABLE_KINDS.map((k) => {
                const m = kindMeta(k, t);
                return { value: k, label: m.label, hint: m.description };
              })}
            />
          </Field>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={() => onCreate({ name: name.trim(), kind })}
            className="inline-flex h-10 items-center justify-center gap-1.5 self-start rounded-lg bg-accent px-4 text-[13px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {t('pages.skills.createSkill')}
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillDetail({
  skillId,
  onDelete,
  onBack,
}: {
  skillId: string;
  onDelete: () => void;
  onBack: () => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();

  const skillQuery = useQuery({
    queryKey: ['skill', skillId],
    queryFn: () => window.orkestral['skill:get']({ skillId }),
  });
  const skill = skillQuery.data ?? null;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [initial, setInitial] = useState({ name: '', description: '', content: '' });

  useEffect(() => {
    if (skill) {
      const frame = requestAnimationFrame(() => {
        setName(skill.name);
        setDescription(skill.description ?? '');
        setContent(skill.content);
        setInitial({
          name: skill.name,
          description: skill.description ?? '',
          content: skill.content,
        });
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [skill]);

  const dirty =
    name !== initial.name || description !== initial.description || content !== initial.content;

  const saveMutation = useMutation({
    mutationFn: () =>
      window.orkestral['skill:update']({
        skillId,
        patch: { name, description: description || null, content },
      }),
    onSuccess: (s) => {
      setInitial({ name: s.name, description: s.description ?? '', content: s.content });
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      queryClient.invalidateQueries({ queryKey: ['skill', skillId] });
    },
  });

  if (skillQuery.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
        {t('pages.skills.loading')}
      </div>
    );
  }
  if (!skill) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
        {t('pages.skills.skillNotFound')}
      </div>
    );
  }

  const meta = kindMeta(skill.kind, t);
  const KindIcon = meta.icon;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Barra de ações slim */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline-faint px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            title={t('common.back')}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-hairline-strong text-text-secondary transition-colors hover:bg-surface-active hover:text-text-primary"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="inline-flex items-center gap-1 rounded border border-hairline-strong bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-text-secondary">
            <KindIcon className="h-3 w-3" />
            {meta.label}
          </span>
          <span className="truncate font-mono text-[10.5px] text-text-faint">{skill.slug}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dirty && (
            <span className="inline-flex items-center gap-1 text-[11px] text-accent-yellow">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-yellow" />
              {t('pages.skills.unsaved')}
            </span>
          )}
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3.5 text-[12.5px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t('common.save')}
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="grid h-8 w-8 place-items-center rounded-md text-text-muted transition-colors hover:bg-accent-red/10 hover:text-accent-red"
            title={t('pages.skills.deleteSkill')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Documento full-width (igual à Base de Conhecimento) */}
      <div className="thin-scrollbar flex-1 overflow-y-auto">
        <div className="pb-20 pl-20 pr-20 pt-12">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-transparent text-[34px] font-bold leading-tight tracking-tight text-text-primary placeholder:text-text-faint focus:outline-none"
            placeholder={t('pages.skills.skillNamePlaceholder')}
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('pages.skills.skillDescPlaceholder')}
            className="mt-2 w-full bg-transparent text-[15px] leading-relaxed text-text-secondary placeholder:text-text-faint focus:outline-none"
          />

          {/* Separador: acima = identidade (nome + descrição), abaixo = conteúdo
              que é injetado no prompt. */}
          <div className="mb-5 mt-8 flex items-center gap-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-text-faint">
              {t('pages.skills.contentLabel')}
            </span>
            <div className="h-px flex-1 bg-surface-active" />
            <span className="text-[10.5px] text-text-faint">
              {t('pages.skills.injectedIntoPrompt')}
            </span>
          </div>

          <SkillMarkdownEditor
            initialMarkdown={skill.content}
            onReady={(md) => {
              setContent(md);
              setInitial((prev) => ({ ...prev, content: md }));
            }}
            onChange={setContent}
          />
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-medium text-text-primary">{label}</label>
      {children}
      {hint && <span className="text-[11px] text-text-muted">{hint}</span>}
    </div>
  );
}

function PageShell({
  tab,
  onTab,
  children,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  children: ReactNode;
}) {
  const { t } = useT();
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <div className="window-drag flex items-end justify-between border-b border-hairline-soft px-8 pt-5">
          <div className="pb-3">
            <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">
              {t('pages.skills.title')}
            </h1>
            <p className="mt-0.5 text-[12.5px] text-text-muted">{t('pages.skills.subtitle')}</p>
          </div>
          <div className="window-no-drag flex items-center gap-1">
            <TabButton icon={Library} active={tab === 'mine'} onClick={() => onTab('mine')}>
              {t('pages.skills.tabMine')}
            </TabButton>
            <TabButton
              icon={Store}
              active={tab === 'marketplace'}
              onClick={() => onTab('marketplace')}
            >
              {t('pages.skills.tabMarketplace')}
            </TabButton>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function TabButton({
  icon: Icon,
  active,
  onClick,
  children,
}: {
  icon: typeof Store;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 border-b-2 px-3 pb-3 pt-2 text-[13px] font-medium transition-colors',
        active
          ? 'border-accent-purple text-text-primary'
          : 'border-transparent text-text-muted hover:text-text-secondary',
      )}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}
