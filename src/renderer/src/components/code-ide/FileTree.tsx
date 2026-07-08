import {
  useEffect,
  useRef,
  useState,
  useMemo,
  useContext,
  createContext,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  File as FileIcon,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  Copy,
  FolderOpen as FolderOpenIcon,
  ListTree,
  MessageSquarePlus,
  FileText,
  Scissors,
  ClipboardPaste,
  CopyPlus,
  Search,
  Github,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { getFileIconUrl, getFolderIconUrl } from '@renderer/lib/materialIcons';
import {
  useContextMenu,
  ContextMenu,
  type ContextMenuItem,
} from '@renderer/components/ui/context-menu';
import { useT } from '@renderer/i18n';
import { useCodeIdeStore } from '@renderer/stores/codeIdeStore';
import { useCodeTabsStore } from '@renderer/stores/codeTabsStore';
import { addFileToChat } from '@renderer/lib/addFileToChat';
import { toast } from '@renderer/stores/toastStore';

type Entry = { name: string; relPath: string; kind: 'dir' | 'file' };

const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const joinRel = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => undefined);

const ICON_CLASS = 'h-3.5 w-3.5';

const baseName = (rel: string) => (rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel);

/** Nome do destino ao duplicar: "arquivo copy.ext" / "pasta copy". */
function duplicateRelPath(rel: string, kind: 'file' | 'dir'): string {
  const parent = parentOf(rel);
  const name = baseName(rel);
  if (kind === 'dir') return joinRel(parent, `${name} copy`);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return joinRel(parent, `${stem} copy${ext}`);
}

/**
 * Ações compartilhadas do menu de contexto (arquivo e pasta): recortar/copiar/colar,
 * duplicar, copiar nome, link do GitHub e buscar na pasta. Retorna um builder que monta
 * os itens prontos pro alvo (relPath + kind); cada nó os encaixa na ordem que quiser.
 */
function useEntryActions(sourceId: string, isGithub: boolean) {
  const { t } = useT();
  const qc = useQueryClient();
  const clipboard = useCodeIdeStore((s) => s.clipboard);
  const setClipboard = useCodeIdeStore((s) => s.setClipboard);
  const clearClipboard = useCodeIdeStore((s) => s.clearClipboard);
  const openDir = useCodeIdeStore((s) => s.openDir);
  const setView = useCodeIdeStore((s) => s.setView);
  const setSearchScope = useCodeIdeStore((s) => s.setSearchScope);
  const bumpFocusSearch = useCodeIdeStore((s) => s.bumpFocusSearch);

  const refreshDirs = (...rels: string[]) => {
    for (const parent of new Set(rels.map(parentOf)))
      qc.invalidateQueries({ queryKey: ['source-dir', sourceId, parent] });
  };

  const doPaste = async (targetDir: string) => {
    if (!clipboard) return;
    const dest = joinRel(targetDir, baseName(clipboard.relPath));
    if (dest === clipboard.relPath) return;
    try {
      if (clipboard.mode === 'cut') {
        await window.orkestral['source:rename']({
          sourceId,
          relPath: clipboard.relPath,
          newRelPath: dest,
        });
        clearClipboard();
      } else {
        await window.orkestral['source:copy']({
          sourceId,
          relPath: clipboard.relPath,
          newRelPath: dest,
        });
      }
      if (targetDir) openDir(sourceId, targetDir);
      refreshDirs(clipboard.relPath, dest);
    } catch (e) {
      toast.error(
        (e as Error)?.message === 'target-exists'
          ? t('layout.codeIde.pasteExists')
          : t('layout.codeIde.pasteError'),
      );
    }
  };

  const doDuplicate = async (rel: string, kind: 'file' | 'dir') => {
    const dest = duplicateRelPath(rel, kind);
    try {
      await window.orkestral['source:copy']({ sourceId, relPath: rel, newRelPath: dest });
      refreshDirs(rel, dest);
    } catch (e) {
      toast.error(
        (e as Error)?.message === 'target-exists'
          ? t('layout.codeIde.pasteExists')
          : t('layout.codeIde.duplicateError'),
      );
    }
  };

  const doCopyGithub = async (rel: string, line?: number) => {
    try {
      const { url } = await window.orkestral['source:github-permalink']({
        sourceId,
        relPath: rel,
        line,
      });
      copy(url);
      toast.success(t('layout.codeIde.copiedGithubLink'));
    } catch {
      toast.error(t('layout.codeIde.githubLinkError'));
    }
  };

  return (rel: string, kind: 'file' | 'dir'): Record<string, ContextMenuItem> => {
    const targetDir = kind === 'dir' ? rel : parentOf(rel);
    return {
      cut: {
        label: t('layout.codeIde.ctxCut'),
        icon: <Scissors className={ICON_CLASS} />,
        hint: '⌘X',
        onSelect: () => setClipboard(rel, 'cut'),
      },
      copyFile: {
        label: t('layout.codeIde.ctxCopyFile'),
        icon: <Copy className={ICON_CLASS} />,
        hint: '⌘C',
        onSelect: () => setClipboard(rel, 'copy'),
      },
      paste: {
        label: t('layout.codeIde.ctxPaste'),
        icon: <ClipboardPaste className={ICON_CLASS} />,
        hint: '⌘V',
        disabled: !clipboard,
        onSelect: () => doPaste(targetDir),
      },
      duplicate: {
        label: t('layout.codeIde.ctxDuplicate'),
        icon: <CopyPlus className={ICON_CLASS} />,
        onSelect: () => doDuplicate(rel, kind),
      },
      copyName: {
        label: t('layout.codeIde.ctxCopyName'),
        icon: <Copy className={ICON_CLASS} />,
        onSelect: () => {
          copy(baseName(rel));
          toast.success(t('layout.codeIde.copiedPath'));
        },
      },
      findInFolder: {
        label: t('layout.codeIde.ctxFindInFolder'),
        icon: <Search className={ICON_CLASS} />,
        onSelect: () => {
          setSearchScope({ sourceId, relPath: rel });
          setView('search');
          bumpFocusSearch();
        },
      },
      githubLink: {
        label: t('layout.codeIde.ctxCopyGithubLink'),
        icon: <Github className={ICON_CLASS} />,
        disabled: !isGithub,
        onSelect: () => doCopyGithub(rel),
      },
    };
  };
}

function InlineNameInput({
  initial,
  placeholder,
  depth,
  icon,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  depth: number;
  icon?: ReactNode;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(initial);
  // Linha com a MESMA estrutura/altura das demais (ícone + campo) e padding via padding-left
  // — não margin-left — pra não estourar a largura da sidebar (era a origem do flick).
  return (
    <div
      className="box-border flex h-7 w-full items-center gap-1 pr-1"
      style={{ paddingLeft: depth * 12 + 4 }}
    >
      {icon ? <span className="grid h-4 w-4 shrink-0 place-items-center">{icon}</span> : null}
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = val.trim();
            if (n && !n.includes('/')) onSubmit(n);
          } else if (e.key === 'Escape') onCancel();
        }}
        onBlur={onCancel}
        placeholder={placeholder}
        className="h-6 min-w-0 flex-1 rounded border border-accent-purple/50 bg-surface-1 px-1 text-[12.5px] text-text-primary outline-none"
      />
    </div>
  );
}

/** Status git por arquivo (char porcelain) + dirs com mudança (pra colorir pastas). */
const GitStatusContext = createContext<{ files: Map<string, string>; dirs: Set<string> }>({
  files: new Map(),
  dirs: new Set(),
});

/** Cor do nome conforme git status, estilo VS Code. */
function gitColorClass(ch?: string): string {
  if (!ch) return '';
  if (ch === '?' || ch === 'A') return 'text-accent-green'; // novo/untracked
  if (ch === 'D') return 'text-accent-red'; // removido
  if (ch === 'U') return 'text-accent-orange'; // conflito
  return 'text-accent-yellow'; // M / R / C / T = modificado
}

/** Letra de status mostrada à direita (igual VS Code: M, A, U, D…). */
function gitStatusLetter(ch?: string): string {
  if (!ch) return '';
  if (ch === '?') return 'U';
  return ch;
}

/** Guias verticais de indentação (uma por nível ancestral), estilo VS Code. */
function IndentGuides({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-hairline"
          style={{ left: i * 12 + 11 }}
        />
      ))}
    </>
  );
}

export function FileTree({
  sourceId,
  sourceRoot,
  onOpenFile,
  activeRelPath,
  isGithub = false,
}: {
  sourceId: string;
  sourceRoot: string;
  onOpenFile: (relPath: string, name: string) => void;
  /** Only the relPath of the active tab belonging to THIS source (null = none). */
  activeRelPath: string | null;
  isGithub?: boolean;
}) {
  // Status git do repo inteiro — colore nomes (arquivo) e pastas (descendente mudou).
  const statusQuery = useQuery({
    queryKey: ['git-status', sourceId],
    queryFn: () => window.orkestral['git:status']({ sourceId }),
    retry: false,
    staleTime: 4000,
  });
  const gitValue = useMemo(() => {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    for (const f of statusQuery.data?.files ?? []) {
      const ch = f.workingStatus !== ' ' ? f.workingStatus : f.indexStatus;
      files.set(f.path, ch);
      let p = f.path;
      while (p.includes('/')) {
        p = p.slice(0, p.lastIndexOf('/'));
        dirs.add(p);
      }
    }
    return { files, dirs };
  }, [statusQuery.data]);

  return (
    <GitStatusContext.Provider value={gitValue}>
      {/* Altura natural (conteúdo) — várias sources empilhadas rolam JUNTAS no
          container externo da WorkspaceTree, não cada árvore por si. */}
      <div className="py-1 text-[12.5px]">
        <DirNode
          sourceId={sourceId}
          sourceRoot={sourceRoot}
          relPath=""
          name=""
          depth={0}
          isRoot
          onOpenFile={onOpenFile}
          activeRelPath={activeRelPath}
          isGithub={isGithub}
        />
      </div>
    </GitStatusContext.Provider>
  );
}

function FileRow({
  entry,
  depth,
  sourceId,
  sourceRoot,
  onOpenFile,
  activeRelPath,
  isGithub,
}: {
  entry: Entry;
  depth: number;
  sourceId: string;
  sourceRoot: string;
  onOpenFile: (relPath: string, name: string) => void;
  activeRelPath: string | null;
  isGithub: boolean;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const menu = useContextMenu();
  const navigate = useNavigate();
  const revealPath = useCodeIdeStore((s) => s.revealPath);
  const clearReveal = useCodeIdeStore((s) => s.clearReveal);
  const requestReveal = useCodeIdeStore((s) => s.requestReveal);
  const startRename = useCodeIdeStore((s) => s.startRename);
  const closeTab = useCodeTabsStore((s) => s.closeTab);
  const entryActions = useEntryActions(sourceId, isGithub);
  const git = useContext(GitStatusContext);
  const ref = useRef<HTMLButtonElement | null>(null);

  const rel = entry.relPath;
  const name = entry.name;
  const isRevealed = revealPath?.sourceId === sourceId && revealPath.relPath === rel;
  const gitChar = git.files.get(rel);
  const gitCls = gitColorClass(gitChar);

  useEffect(() => {
    if (!isRevealed) return;
    ref.current?.scrollIntoView({ block: 'nearest' });
    const id = window.setTimeout(() => clearReveal(), 1200);
    return () => window.clearTimeout(id);
  }, [isRevealed, clearReveal]);

  const handleDelete = async () => {
    if (
      !window.confirm(
        `${t('layout.codeIde.deleteConfirmTitle')}\n${t('layout.codeIde.deleteConfirm')}`,
      )
    )
      return;
    try {
      await window.orkestral['source:delete-file']({ sourceId, relPath: rel });
      qc.invalidateQueries({ queryKey: ['source-dir', sourceId, parentOf(rel)] });
      closeTab(sourceId, rel);
    } catch {
      toast.error(t('layout.codeIde.deleteError'));
    }
  };

  const ops = entryActions(rel, 'file');
  const items: ContextMenuItem[] = [
    {
      label: t('layout.codeIde.ctxOpen'),
      icon: <FileText className={ICON_CLASS} />,
      onSelect: () => onOpenFile(rel, name),
    },
    { type: 'separator' },
    ops.cut,
    ops.copyFile,
    ops.paste,
    ops.duplicate,
    { type: 'separator' },
    {
      label: t('layout.codeIde.ctxCopyPath'),
      icon: <Copy className={ICON_CLASS} />,
      onSelect: () => {
        copy(`${sourceRoot}/${rel}`);
        toast.success(t('layout.codeIde.copiedPath'));
      },
    },
    {
      label: t('layout.codeIde.ctxCopyRelPath'),
      icon: <Copy className={ICON_CLASS} />,
      onSelect: () => {
        copy(rel);
        toast.success(t('layout.codeIde.copiedPath'));
      },
    },
    ops.copyName,
    { type: 'separator' },
    {
      label: t('layout.codeIde.ctxRevealFinder'),
      icon: <FolderOpenIcon className={ICON_CLASS} />,
      onSelect: () => {
        window.orkestral['source:reveal']({ sourceId, relPath: rel }).catch(() =>
          toast.error(t('layout.codeIde.revealError')),
        );
      },
    },
    {
      label: t('layout.codeIde.ctxRevealTree'),
      icon: <ListTree className={ICON_CLASS} />,
      onSelect: () => requestReveal(sourceId, rel),
    },
    ...(isGithub ? [ops.githubLink] : []),
    {
      label: t('layout.codeIde.ctxAddToChat'),
      icon: <MessageSquarePlus className={ICON_CLASS} />,
      onSelect: () => {
        addFileToChat(rel, t('layout.codeIde.openedInChat'));
        navigate('/');
      },
    },
    { type: 'separator' },
    {
      label: t('layout.codeIde.ctxRename'),
      icon: <Pencil className={ICON_CLASS} />,
      onSelect: () => startRename(sourceId, rel),
    },
    {
      label: t('layout.codeIde.ctxDelete'),
      icon: <Trash2 className={ICON_CLASS} />,
      danger: true,
      onSelect: handleDelete,
    },
  ];

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => onOpenFile(rel, name)}
        onContextMenu={menu.open}
        className={cn(
          'relative flex h-7 w-full items-center gap-1 rounded-md px-1 text-left transition-colors',
          {
            'bg-surface-active text-text-primary': activeRelPath === rel,
            'text-text-secondary hover:bg-surface-hover hover:text-text-primary':
              activeRelPath !== rel,
            'ring-1 ring-accent-purple/50': isRevealed,
          },
        )}
        style={{ paddingLeft: (depth + 1) * 12 + 18 }}
      >
        <IndentGuides depth={depth + 1} />
        {(() => {
          const fileIconUrl = getFileIconUrl(name);
          return fileIconUrl ? (
            <img src={fileIconUrl} className="h-4 w-4 shrink-0" alt="" />
          ) : (
            <FileIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
          );
        })()}
        <span className={cn('truncate', gitCls)}>{name}</span>
        {gitChar && (
          <span className={cn('ml-auto shrink-0 pl-1 text-[10px] font-semibold', gitCls)}>
            {gitStatusLetter(gitChar)}
          </span>
        )}
      </button>
      {menu.state && (
        <ContextMenu x={menu.state.x} y={menu.state.y} items={items} onClose={menu.close} />
      )}
    </>
  );
}

function DirNode({
  sourceId,
  sourceRoot,
  relPath,
  name,
  depth,
  isRoot = false,
  onOpenFile,
  activeRelPath,
  isGithub,
}: {
  sourceId: string;
  sourceRoot: string;
  relPath: string;
  name: string;
  depth: number;
  isRoot?: boolean;
  isGithub: boolean;
  onOpenFile: (relPath: string, name: string) => void;
  activeRelPath: string | null;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const menu = useContextMenu();
  const expanded = useCodeIdeStore(
    (s) => isRoot || (s.expandedDirs[sourceId]?.includes(relPath) ?? false),
  );
  const toggleDir = useCodeIdeStore((s) => s.toggleDir);
  const openDir = useCodeIdeStore((s) => s.openDir);
  const entryActions = useEntryActions(sourceId, isGithub);
  const git = useContext(GitStatusContext);
  const dirCls = !isRoot && git.dirs.has(relPath) ? 'text-accent-yellow' : '';

  const pendingEdit = useCodeIdeStore((s) => s.pendingEdit);
  const clearEdit = useCodeIdeStore((s) => s.clearEdit);
  const startRename = useCodeIdeStore((s) => s.startRename);
  const startNewFile = useCodeIdeStore((s) => s.startNewFile);
  const startNewDir = useCodeIdeStore((s) => s.startNewDir);
  const revealPath = useCodeIdeStore((s) => s.revealPath);
  const renameTab = useCodeTabsStore((s) => s.renameTab);
  const closeTab = useCodeTabsStore((s) => s.closeTab);

  // Only consider pendingEdit for THIS source.
  const editForThisSource = pendingEdit?.sourceId === sourceId ? pendingEdit : null;

  const isCreatingHere =
    (editForThisSource?.kind === 'new-file' || editForThisSource?.kind === 'new-dir') &&
    editForThisSource.parentRelPath === relPath;

  // revealPath scoped to this source.
  const reveal = revealPath?.sourceId === sourceId ? revealPath.relPath : null;
  const isAncestor =
    !!reveal && !isRoot && (reveal === relPath || reveal.startsWith(relPath + '/'));

  // Force-open when this dir is an ancestor of a reveal target or the create target,
  // derived during render to avoid setState-in-effect cascades.
  const effectiveOpen = expanded || isAncestor || isCreatingHere;

  const folderIconUrl = getFolderIconUrl(name, effectiveOpen);
  const dirQuery = useQuery({
    queryKey: ['source-dir', sourceId, relPath],
    queryFn: () => window.orkestral['source:read-dir']({ sourceId, relPath }),
    enabled: effectiveOpen,
  });
  const entries: Entry[] = dirQuery.data ?? [];

  const childDepth = depth + 1;

  const isRenaming = (rel: string) =>
    editForThisSource?.kind === 'rename' && editForThisSource.targetRelPath === rel;

  const submitRename = async (rel: string, newName: string) => {
    const newRel = joinRel(parentOf(rel), newName);
    try {
      await window.orkestral['source:rename']({ sourceId, relPath: rel, newRelPath: newRel });
      renameTab(sourceId, rel, newRel, newName);
      qc.invalidateQueries({ queryKey: ['source-dir', sourceId, parentOf(rel)] });
      clearEdit();
    } catch {
      toast.error(t('layout.codeIde.renameError'));
    }
  };

  const submitCreate = async (kind: 'new-file' | 'new-dir', childName: string) => {
    const rel = joinRel(relPath, childName);
    try {
      if (kind === 'new-file') {
        await window.orkestral['source:create-file']({ sourceId, relPath: rel });
      } else {
        await window.orkestral['source:create-dir']({ sourceId, relPath: rel });
      }
      qc.invalidateQueries({ queryKey: ['source-dir', sourceId, relPath] });
      clearEdit();
      if (kind === 'new-file') onOpenFile(rel, childName);
    } catch {
      toast.error(t('layout.codeIde.createError'));
    }
  };

  const handleDirDelete = async () => {
    if (
      !window.confirm(
        `${t('layout.codeIde.deleteConfirmTitle')}\n${t('layout.codeIde.deleteConfirm')}`,
      )
    )
      return;
    try {
      await window.orkestral['source:delete-file']({ sourceId, relPath });
      qc.invalidateQueries({ queryKey: ['source-dir', sourceId, parentOf(relPath)] });
      closeTab(sourceId, relPath);
      clearEdit();
    } catch {
      toast.error(t('layout.codeIde.deleteError'));
    }
  };

  const ops = entryActions(relPath, 'dir');
  const dirItems: ContextMenuItem[] = [
    {
      label: t('layout.codeIde.ctxNewFile'),
      icon: <FilePlus className={ICON_CLASS} />,
      onSelect: () => {
        openDir(sourceId, relPath);
        startNewFile(sourceId, relPath);
      },
    },
    {
      label: t('layout.codeIde.ctxNewFolder'),
      icon: <FolderPlus className={ICON_CLASS} />,
      onSelect: () => {
        openDir(sourceId, relPath);
        startNewDir(sourceId, relPath);
      },
    },
    { type: 'separator' },
    ops.findInFolder,
    { type: 'separator' },
    ops.cut,
    ops.copyFile,
    ops.paste,
    ops.duplicate,
    { type: 'separator' },
    {
      label: t('layout.codeIde.ctxCopyPath'),
      icon: <Copy className={ICON_CLASS} />,
      onSelect: () => {
        copy(`${sourceRoot}/${relPath}`);
        toast.success(t('layout.codeIde.copiedPath'));
      },
    },
    {
      label: t('layout.codeIde.ctxCopyRelPath'),
      icon: <Copy className={ICON_CLASS} />,
      onSelect: () => {
        copy(relPath);
        toast.success(t('layout.codeIde.copiedPath'));
      },
    },
    ops.copyName,
    { type: 'separator' },
    {
      label: t('layout.codeIde.ctxRevealFinder'),
      icon: <FolderOpenIcon className={ICON_CLASS} />,
      onSelect: () => {
        window.orkestral['source:reveal']({ sourceId, relPath }).catch(() =>
          toast.error(t('layout.codeIde.revealError')),
        );
      },
    },
    ...(isGithub ? [ops.githubLink] : []),
    { type: 'separator' },
    {
      label: t('layout.codeIde.ctxRename'),
      icon: <Pencil className={ICON_CLASS} />,
      onSelect: () => startRename(sourceId, relPath),
    },
    {
      label: t('layout.codeIde.ctxDelete'),
      icon: <Trash2 className={ICON_CLASS} />,
      danger: true,
      onSelect: handleDirDelete,
    },
  ];

  return (
    <div>
      {!isRoot &&
        (isRenaming(relPath) ? (
          <InlineNameInput
            initial={name}
            placeholder={t('layout.codeIde.namePlaceholder')}
            depth={depth}
            icon={<Folder className={ICON_CLASS} />}
            onSubmit={(n) => submitRename(relPath, n)}
            onCancel={clearEdit}
          />
        ) : (
          <button
            type="button"
            onClick={() => toggleDir(sourceId, relPath)}
            onContextMenu={menu.open}
            className="relative flex h-7 w-full items-center gap-1 rounded-md px-1 text-left text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            style={{ paddingLeft: depth * 12 + 4 }}
          >
            <IndentGuides depth={depth} />
            {effectiveOpen ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
            )}
            {folderIconUrl ? (
              <img src={folderIconUrl} className="h-4 w-4 shrink-0" alt="" />
            ) : effectiveOpen ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 opacity-80" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 opacity-80" />
            )}
            <span className={cn('truncate', dirCls)}>{name}</span>
          </button>
        ))}
      {menu.state && (
        <ContextMenu x={menu.state.x} y={menu.state.y} items={dirItems} onClose={menu.close} />
      )}
      <AnimatePresence initial={false}>
        {effectiveOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            {isCreatingHere && editForThisSource && (
              <InlineNameInput
                initial=""
                placeholder={t('layout.codeIde.namePlaceholder')}
                depth={childDepth}
                icon={
                  editForThisSource.kind === 'new-dir' ? (
                    <Folder className={ICON_CLASS} />
                  ) : (
                    <FileIcon className={ICON_CLASS} />
                  )
                }
                onSubmit={(n) =>
                  submitCreate(editForThisSource.kind === 'new-dir' ? 'new-dir' : 'new-file', n)
                }
                onCancel={clearEdit}
              />
            )}
            {entries.map((e) =>
              e.kind === 'dir' ? (
                <DirNode
                  key={e.relPath}
                  sourceId={sourceId}
                  sourceRoot={sourceRoot}
                  relPath={e.relPath}
                  name={e.name}
                  depth={childDepth}
                  onOpenFile={onOpenFile}
                  activeRelPath={activeRelPath}
                  isGithub={isGithub}
                />
              ) : isRenaming(e.relPath) ? (
                <InlineNameInput
                  key={e.relPath}
                  initial={e.name}
                  placeholder={t('layout.codeIde.namePlaceholder')}
                  depth={childDepth}
                  icon={<FileIcon className={ICON_CLASS} />}
                  onSubmit={(n) => submitRename(e.relPath, n)}
                  onCancel={clearEdit}
                />
              ) : (
                <FileRow
                  key={e.relPath}
                  entry={e}
                  depth={depth}
                  sourceId={sourceId}
                  sourceRoot={sourceRoot}
                  onOpenFile={onOpenFile}
                  activeRelPath={activeRelPath}
                  isGithub={isGithub}
                />
              ),
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
