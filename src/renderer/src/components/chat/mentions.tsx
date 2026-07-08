import * as React from 'react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { Folder } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { fileIconFor, basename } from '@renderer/lib/file-icons';

export type MentionAgent = { id: string; name: string; avatarSeed?: string | null };

/**
 * Detecta `@<nome de agente>` em React children e substitui por uma chip
 * visual com avatar + nome. Tipos de input: string (substitui),
 * array (recurse), outros (passa puro). Trabalha em qualquer nó folha
 * de markdown (parágrafo, item de lista, etc.). Compartilhado entre o chat
 * (Message.tsx) e os comentários de issue/sistema (Markdown).
 */
export function interpolateMentions(
  node: React.ReactNode,
  agents?: MentionAgent[],
): React.ReactNode {
  // Processa sempre (mesmo sem agentes) — menções de ARQUIVO viram chip também.
  if (typeof node === 'string') {
    return splitMentions(node, agents ?? []);
  }
  if (Array.isArray(node)) {
    return node.map((c, i) => (
      <React.Fragment key={i}>{interpolateMentions(c, agents)}</React.Fragment>
    ));
  }
  return node;
}

/**
 * Versão compacta pra títulos de sessão na sidebar: renderiza `@<agente>` como
 * avatar + nome (igual ao chat, mas sem o popover de hover). Só vira tag quando
 * o nome bate com um agente real do workspace.
 */
export function renderTitleMentions(title: string, agents: MentionAgent[]): React.ReactNode {
  const names = agents.map((a) => a.name).filter((n) => !!n && n.length > 0);
  if (names.length === 0) return title;
  const pattern = names
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  const rx = new RegExp(`@(${pattern})\\b`, 'g');
  const out: React.ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(title))) {
    if (m.index > cursor) {
      // Remove o travessão feio (" — ") logo antes do agente; vira só um espaço.
      out.push(title.slice(cursor, m.index).replace(/\s*[—–-]\s*$/, ' '));
    }
    const agent = agents.find((a) => a.name === m![1]);
    // Tag sutil: avatar pequeno + nome, fundo neutro discreto, menor que o
    // título e com separação (ml) do texto. O avatar já carrega a cor do agente.
    out.push(
      <span
        key={`tm-${m.index}`}
        className="ml-1 inline-flex items-center gap-1 rounded bg-surface-active px-1 py-px align-middle text-[11px] font-medium text-text-secondary"
      >
        <AgentAvatar
          seed={agent?.avatarSeed ?? null}
          name={agent?.name ?? m[1]}
          size={12}
          rounded="full"
          className="ring-0"
        />
        {agent?.name ?? m[1]}
      </span>,
    );
    cursor = m.index + m[0].length;
  }
  if (cursor === 0) return title;
  if (cursor < title.length) out.push(title.slice(cursor));
  return out;
}

// Arquivo: termina com `.ext` (`@package.json`, `@src/Foo.tsx`, `@docs/g.md`).
const FILE_MENTION_RE = '[A-Za-z0-9_.\\-]+(?:\\/[A-Za-z0-9_.\\-]+)*\\.[A-Za-z0-9]+';
// Pasta: caminho com pelo menos um `/` e SEM extensão (`@src/components`).
// Testado DEPOIS do arquivo, então um path com extensão sempre vira arquivo.
const FOLDER_MENTION_RE = '[A-Za-z0-9_.\\-]+(?:\\/[A-Za-z0-9_.\\-]+)+';

function splitMentions(text: string, agents: MentionAgent[]): React.ReactNode[] {
  const names = agents.map((a) => a.name).filter((n) => !!n && n.length > 0);
  const namePattern = names.length
    ? names
        .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length) // mais longo primeiro
        .join('|')
    : null;
  // Agentes têm prioridade (alternância tenta o agente antes do arquivo).
  const patterns: string[] = [];
  if (namePattern) patterns.push(`@(?<agent>${namePattern})\\b`);
  patterns.push(`@(?<file>${FILE_MENTION_RE})`);
  patterns.push(`@(?<folder>${FOLDER_MENTION_RE})`);
  const rx = new RegExp(patterns.join('|'), 'g');
  const out: React.ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    if (m.index > cursor) out.push(text.slice(cursor, m.index));
    const g = m.groups ?? {};
    if (g.agent) {
      const agent = agents.find((a) => a.name === g.agent);
      out.push(
        <MentionChip
          key={`m-${m.index}`}
          agentId={agent?.id}
          name={agent?.name ?? g.agent}
          avatarSeed={agent?.avatarSeed ?? null}
        />,
      );
    } else if (g.file) {
      out.push(<FileMentionChip key={`f-${m.index}`} path={g.file} />);
    } else if (g.folder) {
      out.push(<FolderMentionChip key={`d-${m.index}`} path={g.folder} />);
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out.length ? out : [text];
}

/** Chip de menção de ARQUIVO: ícone por extensão + basename, caminho no hover. */
function FileMentionChip({ path }: { path: string }) {
  const Icon = fileIconFor(path);
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-surface-active px-1.5 py-0.5 align-middle text-[12px] font-medium text-text-secondary"
      title={path}
    >
      <Icon className="h-3 w-3 shrink-0 text-text-muted" />
      {basename(path)}
    </span>
  );
}

/** Chip de menção de PASTA: ícone de pasta + caminho. */
function FolderMentionChip({ path }: { path: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-surface-active px-1.5 py-0.5 align-middle text-[12px] font-medium text-text-secondary"
      title={path}
    >
      <Folder className="h-3 w-3 shrink-0 text-text-muted" />
      {path}
    </span>
  );
}

/**
 * Chip de menção de agente: sem o `@`, fundo na cor primária (accent) bem
 * sutil, e tooltip no hover com as tarefas que o agente está tocando agora.
 */
function MentionChip({
  agentId,
  name,
  avatarSeed,
}: {
  agentId?: string;
  name: string;
  avatarSeed?: string | null;
}) {
  const [hover, setHover] = useState(false);
  const workspace = useWorkspaceStore((s) => s.active);
  const q = useQuery({
    queryKey: ['mention-work', workspace?.id, agentId],
    enabled: hover && !!agentId && !!workspace,
    queryFn: () => window.orkestral['issue:list']({ workspaceId: workspace!.id }),
  });
  const active = (q.data ?? [])
    .filter((i) => i.assigneeAgentId === agentId)
    .filter((i) => i.status === 'in_progress' || i.status === 'in_review' || i.status === 'todo')
    .slice(0, 5);

  return (
    <span
      className="relative inline-flex items-center gap-1.5 rounded-md bg-accent-purple/15 px-2 py-0.5 align-middle text-[12.5px] font-semibold text-accent-purple transition-colors hover:bg-accent-purple/25"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <AgentAvatar
        seed={avatarSeed ?? null}
        name={name}
        size={16}
        rounded="full"
        className="ring-0"
      />
      {name}
      {hover && agentId && (
        <span className="absolute left-0 top-full z-50 mt-1 w-60 rounded-lg border border-hairline-strong bg-dialog p-2.5 text-left shadow-xl">
          <span className="block text-[10.5px] font-medium uppercase tracking-wider text-text-faint">
            {name} · trabalhando em
          </span>
          {active.length === 0 ? (
            <span className="mt-1.5 block text-[12px] text-text-muted">
              {q.isFetching ? '…' : 'Sem tarefas ativas no momento.'}
            </span>
          ) : (
            <span className="mt-1.5 flex flex-col gap-1">
              {active.map((i) => (
                <span
                  key={i.id}
                  className="flex items-start gap-1.5 text-[12px] text-text-secondary"
                >
                  <span
                    className={cn(
                      'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                      i.status === 'in_progress'
                        ? 'bg-accent-blue'
                        : i.status === 'in_review'
                          ? 'bg-accent-yellow'
                          : 'bg-text-faint',
                    )}
                  />
                  <span className="truncate">{i.title}</span>
                </span>
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
