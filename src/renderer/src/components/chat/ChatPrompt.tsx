import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUp,
  Check,
  ChevronDown,
  CornerDownRight,
  Eraser,
  Folder,
  Github,
  HelpCircle,
  Layers,
  Plus,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { fileIconFor, basename, dirname } from '@renderer/lib/file-icons';
import type { Agent, ChatAttachment, WorkspaceSource } from '@shared/types';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useScopeStore } from '@renderer/stores/scopeStore';
import { useDraftStore } from '@renderer/stores/draftStore';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { ROLE_META } from '@renderer/lib/role-meta';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { ProviderIcon } from '@renderer/components/ProviderIcon';
import { MentionsMenu, type MentionItem } from './MentionsMenu';
import { isHiddenPlanningMessage } from './ask-user';
import { useT, type TFunction } from '@renderer/i18n';
import type { PendingMessage, PendingMessageKind } from '@renderer/stores/chatStore';
import { DictateButton } from './DictateButton';
import { toast } from '@renderer/stores/toastStore';

export type SlashCommand = 'clear' | 'help' | 'new';

interface ChatPromptProps {
  onSubmit: (content: string, attachments?: ChatAttachment[]) => void;
  onCancel?: () => void;
  streaming?: boolean;
  placeholder?: string;
  agents?: Agent[];
  currentAgent?: Agent;
  onAgentChange?: (agentId: string) => void;
  onCommand?: (command: SlashCommand) => void;
  /** Chave do rascunho (sessionId ou HOME_DRAFT_KEY) — persiste o texto não-enviado por chat. */
  draftKey?: string;
  /** Painel aberto → o prompt preenche a coluna (alinha com as mensagens). */
  expand?: boolean;
  /** Input mais ALTO (estilo Lobe) — usado na tela de novo chat. */
  tall?: boolean;
  /** Conteúdo anexado DENTRO do card, abaixo da barra (ex.: banner de canais). */
  footer?: ReactNode;
  pendingQueue?: PendingMessage[];
  onPendingKindChange?: (pendingId: string, kind: PendingMessageKind) => void;
  onPendingRemove?: (pendingId: string) => void;
  onPendingSendNow?: (pendingId: string) => void;
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB por arquivo

interface SlashCommandDef {
  id: SlashCommand;
  command: string;
  label: string;
  description: string;
  icon: typeof Eraser;
}

function buildSlashCommands(t: TFunction): SlashCommandDef[] {
  return [
    {
      id: 'new',
      command: '/new',
      label: t('chat.slash.newLabel'),
      description: t('chat.slash.newDescription'),
      icon: Sparkles,
    },
    {
      id: 'clear',
      command: '/clear',
      label: t('chat.slash.clearLabel'),
      description: t('chat.slash.clearDescription'),
      icon: Trash2,
    },
    {
      id: 'help',
      command: '/help',
      label: t('chat.slash.helpLabel'),
      description: t('chat.slash.helpDescription'),
      icon: HelpCircle,
    },
  ];
}

export function ChatPrompt({
  onSubmit,
  onCancel,
  streaming,
  placeholder,
  agents,
  currentAgent,
  onAgentChange,
  onCommand,
  draftKey,
  expand,
  tall,
  footer,
  pendingQueue,
  onPendingKindChange,
  onPendingRemove,
  onPendingSendNow,
}: ChatPromptProps) {
  const { t } = useT();
  const resolvedPlaceholder = placeholder ?? t('chat.input.placeholderDots');
  const slashCommands = useMemo(() => buildSlashCommands(t), [t]);
  const [value, setValue] = useState(() =>
    draftKey !== undefined ? (useDraftStore.getState().drafts[draftKey] ?? '') : '',
  );
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Texto que já estava no campo quando o ditado começou (o parcial é anexado a ele).
  const dictationBaseRef = useRef('');

  // Rascunho persistente por chat: ao trocar de chat (draftKey muda) carrega o
  // rascunho daquele chat; enquanto o chat é o mesmo, salva cada alteração. O
  // SessionPage não remonta o ChatPrompt ao trocar de sessão, então o swap por
  // key tem que acontecer aqui mesmo.
  const draftKeyRef = useRef(draftKey);
  useEffect(() => {
    if (draftKey === undefined) return;
    if (draftKeyRef.current !== draftKey) {
      draftKeyRef.current = draftKey;
      setValue(useDraftStore.getState().drafts[draftKey] ?? '');
      return;
    }
    if (value) useDraftStore.getState().setDraft(draftKey, value);
    else useDraftStore.getState().clearDraft(draftKey);
  }, [value, draftKey]);

  // Sources do workspace — usados pelo @ pra mencionar pastas (além de agentes).
  const activeWs = useWorkspaceStore((s) => s.active);
  const sourcesQuery = useQuery<WorkspaceSource[]>({
    queryKey: ['sources', activeWs?.id],
    enabled: !!activeWs,
    queryFn: () => window.orkestral['source:list']({ workspaceId: activeWs!.id }),
  });
  const sources = useMemo(() => sourcesQuery.data ?? [], [sourcesQuery.data]);

  // Subpastas dos sources (varridas do disco) — pro @ mencionar pastas internas.
  const dirsQuery = useQuery({
    queryKey: ['source-dirs', activeWs?.id],
    enabled: !!activeWs,
    queryFn: () => window.orkestral['source:list-dirs']({ workspaceId: activeWs!.id }),
  });
  const dirs = useMemo(() => dirsQuery.data ?? [], [dirsQuery.data]);

  // Arquivos dos sources (varridos do disco) — pro @ mencionar arquivos, com
  // ícone por extensão (paridade com o opencode).
  const filesQuery = useQuery({
    queryKey: ['source-files', activeWs?.id],
    enabled: !!activeWs,
    queryFn: () => window.orkestral['source:list-files']({ workspaceId: activeWs!.id }),
  });
  const files = useMemo(() => filesQuery.data ?? [], [filesQuery.data]);

  // Skills instaladas — entram no menu de comandos "/" (estilo opencode).
  const skillsQuery = useQuery({
    queryKey: ['skills', activeWs?.id],
    enabled: !!activeWs,
    queryFn: () => window.orkestral['skill:list']({ workspaceId: activeWs!.id }),
  });
  const skills = (skillsQuery.data ?? []).filter((s) => s.kind !== 'mcp');

  type MenuState = {
    kind: 'slash' | 'mention';
    anchorStart: number;
    query: string;
    highlight: number;
  } | null;
  const [menu, setMenu] = useState<MenuState>(null);
  // Placement dinâmico: se o textarea está perto do topo da viewport (ex:
  // estado "Novo chat" vazio centralizado), o menu sobe e fica cortado.
  // Medimos o espaço acima vs altura estimada do menu (~300px) e mudamos
  // pra `below` quando não cabe acima.
  // Menu abre pra cima por padrão. Medimos o espaço real até o topo do
  // container scrollável e LIMITAMOS a altura do menu — assim ele nunca corta,
  // independente de quantos agentes/pastas ou tamanho de janela.
  const [menuPlacement, setMenuPlacement] = useState<'above' | 'below'>('above');
  const [menuMaxHeight, setMenuMaxHeight] = useState<number>(260);
  useEffect(() => {
    if (!menu) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const rect = ta.getBoundingClientRect();
    // Acha o ancestral scrollável pra saber onde o menu pode começar/terminar.
    let scroller: HTMLElement | null = ta.parentElement;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if (oy === 'auto' || oy === 'scroll') break;
      scroller = scroller.parentElement;
    }
    const topBound = scroller ? scroller.getBoundingClientRect().top : 8;
    const botBound = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight - 8;
    const aboveSpace = rect.top - topBound - 12;
    const belowSpace = botBound - rect.bottom - 12;
    const CHROME = 64; // header + footer + margem do menu
    if (aboveSpace >= 180 || aboveSpace >= belowSpace) {
      setMenuPlacement('above');
      setMenuMaxHeight(Math.max(120, Math.min(360, aboveSpace - CHROME)));
    } else {
      setMenuPlacement('below');
      setMenuMaxHeight(Math.max(120, Math.min(360, belowSpace - CHROME)));
    }
  }, [menu]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  }, [value]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function detectMenu(text: string, caret: number): MenuState {
    let kind: 'slash' | 'mention' | null = null;
    let anchorStart = -1;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === ' ' || ch === '\n' || ch === '\t') break;
      if (ch === '/') {
        if (i === 0 || /\s/.test(text[i - 1] ?? '')) {
          kind = 'slash';
          anchorStart = i;
        }
        break;
      }
      if (ch === '@') {
        if (i === 0 || /\s/.test(text[i - 1] ?? '')) {
          kind = 'mention';
          anchorStart = i;
        }
        break;
      }
    }
    if (!kind || anchorStart < 0) return null;
    return { kind, anchorStart, query: text.slice(anchorStart + 1, caret), highlight: 0 };
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setValue(next);
    setMenu(detectMenu(next, e.target.selectionStart ?? next.length));
  }

  function handleKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      setMenu(detectMenu(value, e.currentTarget.selectionStart ?? value.length));
    }
  }

  const items: MentionItem[] = useMemo(() => {
    if (!menu) return [];
    const q = menu.query.toLowerCase();
    if (menu.kind === 'slash') {
      const cmdItems: MentionItem[] = slashCommands
        .filter((c) => c.command.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
        .map((c) => ({
          id: c.id,
          label: c.label,
          description: c.description,
          icon: c.icon,
          insert: c.command + ' ',
        }));
      // Skills instaladas — comando `/<slug>` com badge "skill".
      const skillItems: MentionItem[] = skills
        .filter((s) => s.slug.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
        .map((s) => ({
          id: `skill:${s.id}`,
          label: s.name,
          description: s.description ?? undefined,
          icon: Sparkles,
          badge: t('chat.slash.skillBadge'),
          insert: `/${s.slug} `,
        }));
      return [...cmdItems, ...skillItems];
    }
    // Mention = agentes (com avatar) + pastas/sources do workspace.
    const agentItems: MentionItem[] = (agents ?? [])
      .filter((a) => a.name.toLowerCase().includes(q))
      .map((a) => ({
        id: a.id,
        label: a.name,
        description: `${a.adapterType ?? t('chat.mention.noAdapter')}${a.isOrchestrator ? t('chat.mention.orchestratorSuffix') : ''}`,
        avatar: { seed: a.avatarSeed, name: a.name },
        insert: `@${a.name} `,
      }));
    const sourceItems: MentionItem[] = sources
      .filter((s) => sourceDisplayName(s).toLowerCase().includes(q))
      .map((s) => ({
        id: s.id,
        label: sourceDisplayName(s),
        description: s.repoFullName ?? s.path ?? undefined,
        icon: s.kind === 'github_repo' ? Github : Folder,
        insert: `@${sourceDisplayName(s)} `,
      }));
    // Subpastas dos sources. Cap em 40 itens visíveis pra lista não explodir.
    // Estilo opencode: pasta apagada + nome em destaque, uma linha só.
    const dirItems: MentionItem[] = dirs
      .filter((d) => d.relPath.toLowerCase().includes(q))
      .slice(0, 40)
      .map((d) => ({
        id: `dir:${d.sourceId}:${d.relPath}`,
        label: basename(d.relPath),
        dir: dirname(d.relPath) || undefined,
        icon: Folder,
        insert: `@${d.relPath} `,
      }));
    // Arquivos dos sources — ícone por extensão (estilo opencode). Só quando há
    // query (a lista de arquivos é grande); cap em 40 visíveis.
    const fileItems: MentionItem[] = q
      ? files
          .filter((f) => f.relPath.toLowerCase().includes(q))
          .slice(0, 40)
          .map((f) => ({
            id: `file:${f.sourceId}:${f.relPath}`,
            label: basename(f.relPath),
            dir: dirname(f.relPath) || undefined,
            icon: fileIconFor(f.relPath),
            insert: `@${f.relPath} `,
          }))
      : [];
    return [...agentItems, ...sourceItems, ...dirItems, ...fileItems];
  }, [menu, agents, sources, dirs, files, skills, slashCommands, t]);

  const safeMenu = menu
    ? { ...menu, highlight: Math.min(menu.highlight, Math.max(0, items.length - 1)) }
    : null;

  function applyMenuItem(item: MentionItem) {
    if (!safeMenu) return;
    const before = value.slice(0, safeMenu.anchorStart);
    const after = value.slice(safeMenu.anchorStart + 1 + safeMenu.query.length);
    const next = before + item.insert + after;
    setValue(next);
    setMenu(null);
    const newCaret = before.length + item.insert.length;
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(newCaret, newCaret);
      }
    });
    if (safeMenu.kind === 'slash' && onCommand) {
      const slash = slashCommands.find((c) => c.command + ' ' === item.insert);
      if (slash) {
        onCommand(slash.id);
        setValue('');
      }
    }
    if (safeMenu.kind === 'mention') {
      const ag = (agents ?? []).find((a) => a.id === item.id);
      if (ag && onAgentChange) onAgentChange(ag.id);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (safeMenu && items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenu({ ...safeMenu, highlight: (safeMenu.highlight + 1) % items.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenu({ ...safeMenu, highlight: (safeMenu.highlight - 1 + items.length) % items.length });
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        applyMenuItem(items[safeMenu.highlight]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  // Permite enviar durante streaming — a página enfileira pra despachar
  // depois do message-end. O botão fica habilitado quando há texto ou anexos.
  const canSubmit = value.trim().length > 0 || attachments.length > 0;

  function submit() {
    if (!canSubmit) return;
    const text = value.trim();
    const atts = attachments;
    setValue('');
    setAttachments([]);
    setMenu(null);
    onSubmit(text, atts);
  }

  async function addFiles(files: FileList | File[]): Promise<void> {
    const arr = Array.from(files);
    const accepted: ChatAttachment[] = [];
    for (const f of arr) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        // Antes o arquivo era descartado em silêncio — o usuário não entendia
        // por que o anexo "sumiu". Agora avisa com toast (i18n).
        toast.error(
          t('chat.attachment.tooLargeTitle'),
          t('chat.attachment.tooLargeDescription', { name: f.name }),
        );
        continue;
      }
      const data = await fileToBase64(f);
      accepted.push({
        id: crypto.randomUUID(),
        name: f.name || t('chat.attachment.fallbackName'),
        mime: f.type || guessMimeFromName(f.name),
        size: f.size,
        data,
      });
    }
    if (accepted.length === 0) return;
    setAttachments((prev) => [...prev, ...accepted]);
  }

  function removeAttachment(id: string): void {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    // Dedup: ao colar imagem (ex: screenshot), o Chromium/Electron pode expor
    // o MESMO arquivo em mais de um item `kind: 'file'`, gerando thumb duplicado.
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (!f) continue;
        // Sem lastModified: as duas representações do mesmo blob colado podem
        // ter lastModified diferente — nome+tamanho+tipo já identifica o arquivo.
        const sig = `${f.name}|${f.size}|${f.type}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void addFiles(files);
  }

  return (
    <div
      className={cn('chat-width-col mx-auto w-full px-6 pb-4', expand ? 'max-w-5xl' : 'max-w-3xl')}
    >
      {/* Contexto de empilhamento: input na FRENTE (z-10), banner de canais ATRÁS
          (z-0) encaixado sob ele. */}
      <div className="relative">
        <div
          className={cn(
            'relative z-10 rounded-2xl border transition-colors',
            // Com banner (Home): bg OPACO pra ocluir o topo do banner encaixado
            // atrás. Sem banner (chat): vidro translúcido sobre as mensagens.
            footer ? 'bg-surface' : 'bg-surface-subtle backdrop-blur-md',
            isDragging
              ? 'border-accent-blue/60 bg-accent-blue/[0.06]'
              : footer
                ? 'border-border-strong'
                : 'border-hairline-strong',
            // Menu aberto: sobe o card acima do toolbar (irmão posterior no DOM),
            // senão o z-50 interno do menu não vence o stacking context do toolbar.
            menu && 'z-50',
          )}
          style={{
            boxShadow: '0 10px 30px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04)',
          }}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
              e.preventDefault();
              setIsDragging(true);
            }
          }}
          onDragLeave={(e) => {
            // Só limpa se realmente saiu (não foi pra um filho)
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setIsDragging(false);
          }}
          onDrop={handleDrop}
        >
          {pendingQueue && pendingQueue.length > 0 && (
            <PendingQueueStrip
              items={pendingQueue}
              streaming={streaming}
              onKindChange={onPendingKindChange}
              onRemove={onPendingRemove}
              onSendNow={onPendingSendNow}
            />
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3 pb-1">
              {attachments.map((att) => (
                <AttachmentThumb
                  key={att.id}
                  attachment={att}
                  onRemove={() => removeAttachment(att.id)}
                />
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept="image/*,application/pdf,text/*,.md,.json,.yaml,.yml,.csv"
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          {safeMenu && (
            <MentionsMenu
              items={items}
              highlight={safeMenu.highlight}
              onHover={(i) => setMenu({ ...safeMenu, highlight: i })}
              onSelect={applyMenuItem}
              placement={menuPlacement}
              listMaxHeight={menuMaxHeight}
              title={
                safeMenu.kind === 'slash'
                  ? t('chat.menu.commands')
                  : t('chat.menu.mentionAgentOrFolder')
              }
              hint={
                safeMenu.kind === 'slash' ? t('chat.menu.hintSlash') : t('chat.menu.hintMention')
              }
              emptyLabel={
                safeMenu.kind === 'slash' ? t('chat.menu.noCommands') : t('chat.menu.noResults')
              }
            />
          )}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onPaste={handlePaste}
            onBlur={() => setTimeout(() => setMenu(null), 120)}
            placeholder={resolvedPlaceholder}
            rows={1}
            className={cn(
              'block w-full resize-none bg-transparent px-4 text-[14px] leading-relaxed text-text-primary placeholder:text-text-faint focus:outline-none',
              tall ? 'pt-3.5 pb-2' : 'pt-3.5 pb-2',
            )}
            style={{ minHeight: tall ? 56 : 24 }}
          />

          {/* Linha de baixo DENTRO do card (estilo Lobe): seletor de agente + anexar
            à esquerda; source (sutil) + ditar + enviar à direita. */}
          <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
            <AgentSelector
              agents={agents}
              currentAgent={currentAgent}
              onAgentChange={onAgentChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="grid h-7 w-7 place-items-center rounded-md text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
              title={t('chat.input.attachFile')}
            >
              <Plus className="h-4 w-4" />
            </button>

            <div className="flex-1" />

            <ScopePopover />
            <DictateButton
              onStart={() => {
                dictationBaseRef.current = value;
              }}
              onLiveText={(live) => {
                const base = dictationBaseRef.current;
                setValue(base + (live ? (base ? ' ' : '') + live : ''));
              }}
              onFinalText={(finalText) => {
                const base = dictationBaseRef.current;
                setValue(base + (finalText ? (base ? ' ' : '') + finalText : ''));
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
              onCancel={() => setValue(dictationBaseRef.current)}
            />
            {streaming ? (
              <button
                type="button"
                onClick={onCancel}
                className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-text-primary transition-colors hover:bg-surface-6"
                title={t('chat.input.stop')}
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            ) : (
              // Botão de envio estilo Lobe: círculo claro, ícone escuro.
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className={cn(
                  'grid h-8 w-8 place-items-center rounded-full transition-all',
                  canSubmit
                    ? 'bg-text-primary text-background hover:opacity-90'
                    : 'bg-surface-elevated text-text-faint',
                )}
                title={t('chat.input.send')}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Banner de canais ENCAIXADO atrás do input (estilo Lobe): card próprio
          arredondado, puxado pra cima (-mt-5) pra tucar sob o input. O input na
          frente (bg opaco) oculta o topo do banner, então só a faixa de baixo
          aparece — com os cantos inferiores arredondados. pt-5 reempurra o
          conteúdo pra baixo da borda do input. O input mantém TODOS os cantos
          arredondados (inclusive embaixo). */}
        {footer && (
          <div className="relative z-0 -mt-[26px] rounded-2xl border border-border-strong bg-sidebar pt-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

function PendingQueueStrip({
  items,
  streaming,
  onKindChange,
  onRemove,
  onSendNow,
}: {
  items: PendingMessage[];
  /** Há um turno em andamento — define se "send now" reinicia o turno (honesto). */
  streaming?: boolean;
  onKindChange?: (pendingId: string, kind: PendingMessageKind) => void;
  onRemove?: (pendingId: string) => void;
  onSendNow?: (pendingId: string) => void;
}) {
  const { t } = useT();
  const item = items[0];
  if (!item) return null;
  const hasMore = items.length > 1;
  // Respostas do wizard de planejamento vão escondidas pro CEO; na fila mostramos um
  // rótulo amigável em vez do marker cru [[PLANNING_DECISIONS_HIDDEN]].
  const text =
    (item.content && isHiddenPlanningMessage(item.content)
      ? t('chat.queue.planningDecisions')
      : item.content?.trim()) ||
    (item.attachments?.length
      ? item.attachments.length === 1
        ? t('chat.queue.attachment', { n: item.attachments.length })
        : t('chat.queue.attachmentPlural', { n: item.attachments.length })
      : t('chat.queue.followUp'));
  const steerActive = item.kind === 'steer';

  // Strip compacta de uma linha: vive no topo do card do input, acompanhando a
  // coluna da conversa. Mostra só o follow-up + controles discretos.
  return (
    <div className="-mx-px -mt-px flex items-center gap-2 rounded-t-2xl border-b border-hairline-med bg-surface-faint px-3 py-1.5">
      <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
      <span
        className="min-w-0 flex-1 truncate text-[12px] leading-none text-text-secondary"
        title={text}
      >
        {text}
      </span>
      {hasMore && (
        <span className="shrink-0 text-[11px] leading-none text-text-faint">
          +{items.length - 1}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => onKindChange?.(item.id, steerActive ? 'queue' : 'steer')}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium transition-colors',
            steerActive
              ? 'bg-accent-purple/12 text-accent-purple hover:bg-accent-purple/18'
              : 'text-text-muted hover:bg-surface-2 hover:text-text-primary',
          )}
          title={steerActive ? t('chat.queue.keepInQueue') : t('chat.queue.steerHint')}
        >
          <CornerDownRight className="h-3 w-3" />
          <span>{t('chat.queue.steer')}</span>
        </button>
        <button
          type="button"
          onClick={() => onSendNow?.(item.id)}
          className="grid h-6 w-6 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
          title={streaming ? t('chat.queue.sendNowRestart') : t('chat.queue.sendNow')}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onRemove?.(item.id)}
          className="grid h-6 w-6 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
          title={t('chat.queue.remove')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Agent selector — escolhe qual agente responde. Modelo/esforço vêm do agente,
// então não há seletor de modelo aqui. Em sessão em andamento (sem
// onAgentChange) vira só um chip com o agente atual.
// ============================================================================
function AgentSelector({
  agents,
  currentAgent,
  onAgentChange,
}: {
  agents?: Agent[];
  currentAgent?: Agent;
  onAgentChange?: (agentId: string) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const list = agents ?? [];
  const switchable = !!onAgentChange && list.length > 0;

  // Subtítulo descritivo do agente: cargo/título (ex.: "Frontend Engineer"),
  // com sufixo de orquestrador quando for o CEO.
  const agentSubtitle = (a: Agent): string => {
    const base = a.title?.trim() || a.role?.trim() || t('chat.agentSelector.agentFallback');
    return a.isOrchestrator ? `${base}${t('chat.agentSelector.orchestratorSuffix')}` : base;
  };
  // Modelo configurado do agente (ex.: "claude-opus-4-8"). Null quando default.
  const modelLabel = (a: Agent): string | null => {
    const m = a.model?.trim();
    return m && m !== 'default' ? m : null;
  };

  if (!switchable) {
    return (
      <div
        className="inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-[12px] text-text-secondary"
        title={t('chat.agentSelector.conversationAgent')}
      >
        <AgentAvatar seed={currentAgent?.avatarSeed} name={currentAgent?.name} size={18} />
        <span className="max-w-[160px] truncate font-medium text-text-primary">
          {currentAgent?.name ?? t('chat.agentSelector.agentFallback')}
        </span>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-full bg-surface-subtle px-2 pr-2.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          title={t('chat.agentSelector.chooseAgent')}
        >
          <AgentAvatar seed={currentAgent?.avatarSeed} name={currentAgent?.name} size={18} />
          <span className="max-w-[160px] truncate font-medium text-text-primary">
            {currentAgent?.name ?? t('chat.agentSelector.chooseAgent')}
          </span>
          <ChevronDown className="h-3 w-3 text-text-muted" />
        </button>
      </PopoverTrigger>
      {/* Abre pra BAIXO (Radix auto-flipa pra cima). Compacto e descritivo:
          avatar + nome + cargo · ícone do provedor (Forge/Claude/…) + modelo. */}
      <PopoverContent align="start" side="bottom" sideOffset={8} className="w-[228px] p-1">
        <div className="px-2 pb-0.5 pt-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-text-faint">
          {t('chat.agentSelector.title')}
        </div>
        <div className="no-scrollbar max-h-[300px] overflow-y-auto">
          {list.map((a) => {
            const model = modelLabel(a);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  onAgentChange?.(a.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-2',
                  a.id === currentAgent?.id && 'bg-surface-1',
                )}
              >
                <AgentAvatar seed={a.avatarSeed} name={a.name} size={24} rounded="lg" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-text-primary">{a.name}</div>
                  <div className="flex items-center gap-1 text-[11px] leading-snug text-text-muted">
                    <span className="min-w-0 truncate">{agentSubtitle(a)}</span>
                    {/* Ícone do modelo/provedor (orkestral_local = Forge). */}
                    <span className="text-text-faint">·</span>
                    <ProviderIcon
                      provider={a.adapterType}
                      className="h-3 w-3 shrink-0 text-text-faint"
                    />
                    {model && (
                      <span className="shrink-0 truncate font-mono text-[10px] text-text-faint">
                        {model}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================================
// Scope popover — seletor de quais sources do workspace o agente considera.
// 'all' = geral (todos), ou array de sourceIds específicos.
// ============================================================================
function ScopePopover() {
  const { t } = useT();
  const ws = useWorkspaceStore((s) => s.active);
  const scope = useScopeStore((s) => (ws ? s.getScope(ws.id) : 'all'));
  const setScope = useScopeStore((s) => s.setScope);
  const toggleSource = useScopeStore((s) => s.toggleSource);

  const sourcesQuery = useQuery<WorkspaceSource[]>({
    queryKey: ['sources', ws?.id],
    enabled: !!ws,
    queryFn: () => window.orkestral['source:list']({ workspaceId: ws!.id }),
  });
  const sources = sourcesQuery.data ?? [];

  if (!ws) return null;

  // Label do botão trigger
  const isAll = scope === 'all';
  const selectedIds = Array.isArray(scope) ? scope : [];
  const selectedSources = sources.filter((s) => selectedIds.includes(s.id));

  let TriggerIcon: typeof Github = Layers;
  let triggerLabel: string;
  let triggerSub: string | null = null;
  if (isAll) {
    TriggerIcon = Layers;
    triggerLabel = sources.length === 0 ? t('chat.scope.noSources') : t('chat.scope.general');
    triggerSub =
      sources.length > 0
        ? sources.length === 1
          ? t('chat.scope.sourceCount', { n: sources.length })
          : t('chat.scope.sourceCountPlural', { n: sources.length })
        : null;
  } else if (selectedSources.length === 1) {
    const s = selectedSources[0];
    TriggerIcon = s.kind === 'github_repo' ? Github : Folder;
    triggerLabel = sourceDisplayName(s);
  } else if (selectedSources.length > 1) {
    TriggerIcon = Layers;
    triggerLabel = t('chat.scope.selectedSources', { n: selectedSources.length });
  } else {
    triggerLabel = t('chat.scope.general');
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 max-w-[200px] items-center gap-1.5 rounded-md px-2 text-[12px] text-text-muted transition-colors hover:bg-surface-2 hover:text-text-secondary"
          title={t('chat.scope.chooseScope')}
        >
          <TriggerIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{triggerLabel}</span>
          {triggerSub && <span className="shrink-0 text-text-faint">· {triggerSub}</span>}
          <ChevronDown className="h-3 w-3 shrink-0 text-text-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[300px] p-0">
        <div className="border-b border-hairline-faint px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
            {t('chat.scope.title')}
          </div>
          <p className="mt-0.5 text-[11px] text-text-muted">{t('chat.scope.subtitle')}</p>
        </div>

        <div className="flex flex-col p-1">
          <ScopeRow
            icon={Layers}
            iconClass="text-text-secondary"
            title={t('chat.scope.general')}
            subtitle={
              sources.length === 0
                ? t('chat.scope.generalNoSources')
                : sources.length === 1
                  ? t('chat.scope.generalAllSources', { n: sources.length })
                  : t('chat.scope.generalAllSourcesPlural', { n: sources.length })
            }
            active={isAll}
            onClick={() => setScope(ws.id, 'all')}
          />

          {sources.length > 0 && (
            <>
              <div className="my-1 h-px bg-surface-1" />
              <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-faint">
                {t('chat.scope.individualSources')}
              </div>
              {sources.map((s) => {
                const meta = s.role ? ROLE_META[s.role] : null;
                const SrcIcon = s.kind === 'github_repo' ? Github : Folder;
                const checked = !isAll && selectedIds.includes(s.id);
                return (
                  <ScopeRow
                    key={s.id}
                    icon={SrcIcon}
                    iconClass={
                      s.kind === 'github_repo' ? 'text-text-secondary' : 'text-accent-yellow'
                    }
                    title={sourceDisplayName(s)}
                    subtitle={s.repoFullName ?? s.path ?? undefined}
                    rightChip={
                      meta ? (
                        <span
                          className={cn(
                            'inline-flex h-4 items-center gap-0.5 rounded-full border px-1.5 text-[9px] font-medium',
                            meta.chip,
                          )}
                        >
                          {s.role}
                        </span>
                      ) : null
                    }
                    active={checked}
                    onClick={() => toggleSource(ws.id, s.id)}
                  />
                );
              })}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ScopeRow({
  icon: Icon,
  iconClass,
  title,
  subtitle,
  rightChip,
  active,
  onClick,
}: {
  icon: typeof Github;
  iconClass?: string;
  title: string;
  subtitle?: string;
  rightChip?: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
        active ? 'bg-surface-active' : 'hover:bg-surface-hover',
      )}
    >
      <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 opacity-80', iconClass)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-text-primary">{title}</span>
          {rightChip}
        </div>
        {subtitle && (
          <div className="truncate font-mono text-[10.5px] text-text-muted">{subtitle}</div>
        )}
      </div>
      {active && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-purple" />}
    </button>
  );
}

function sourceDisplayName(s: WorkspaceSource): string {
  if (s.kind === 'github_repo' && s.repoFullName) {
    return s.repoFullName.split('/').slice(-1)[0] ?? s.label;
  }
  if (s.path) {
    return s.path.split('/').filter(Boolean).slice(-1)[0] ?? s.label;
  }
  return s.label;
}

// ============================================================================
// Attachments
// ============================================================================

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader retornou tipo inválido'));
        return;
      }
      // dataURL é "data:<mime>;base64,<...>"
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

function guessMimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext) return 'application/octet-stream';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext))
    return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  if (ext === 'pdf') return 'application/pdf';
  if (['md', 'txt', 'csv', 'json', 'yaml', 'yml'].includes(ext)) return 'text/plain';
  return 'application/octet-stream';
}

function AttachmentThumb({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment;
  onRemove: () => void;
}) {
  const { t } = useT();
  const isImage = attachment.mime.startsWith('image/');
  const sizeKb = Math.max(1, Math.round(attachment.size / 1024));
  return (
    <div className="group relative inline-flex h-14 items-center gap-2 rounded-lg border border-hairline-strong bg-surface-1 pl-1 pr-2.5">
      {isImage ? (
        <img
          src={`data:${attachment.mime};base64,${attachment.data}`}
          alt={attachment.name}
          className="h-12 w-12 rounded-md object-cover"
        />
      ) : (
        <div className="grid h-12 w-12 place-items-center rounded-md bg-surface-2 text-[10px] uppercase text-text-secondary">
          {attachment.name.split('.').pop()?.slice(0, 4) ?? 'file'}
        </div>
      )}
      <div className="flex flex-col text-[11.5px] leading-tight">
        <span className="max-w-[180px] truncate font-medium text-text-primary">
          {attachment.name}
        </span>
        <span className="text-text-muted">{sizeKb} KB</span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        title={t('chat.input.removeAttachment')}
        className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-hairline-heavy bg-background text-text-secondary opacity-0 transition-opacity group-hover:opacity-100 hover:text-accent-red"
      >
        <Trash2 className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}
