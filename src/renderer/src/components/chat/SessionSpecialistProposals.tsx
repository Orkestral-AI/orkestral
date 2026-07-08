import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { GitPullRequest, Check, Loader2, BookOpen, X } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { useInboxDismissStore } from '@renderer/stores/inboxDismissStore';

interface SpecialistPayload {
  type?: string;
  sourceId?: string;
  sourceLabel?: string;
  recommendedAgentName?: string;
  reason?: string;
  originSessionId?: string;
}

/**
 * Propostas de especialista de source nascidas DESTA sessão de chat, renderizadas
 * INLINE no chat (acima do input) — além do Inbox, que segue mostrando (a proposta
 * é workspace-scoped). Cada card some quando o especialista é criado (source
 * coberto → `needsNewAgent=false`) ou ao dispensar. Reusa o mesmo IPC do Inbox.
 */
export function SessionSpecialistProposals({
  workspaceId,
  sessionId,
}: {
  workspaceId: string;
  sessionId: string;
}): JSX.Element | null {
  const { t } = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const dismissedMap = useInboxDismissStore((s) => s.dismissed);
  const dismiss = useInboxDismissStore((s) => s.dismiss);

  const activityQuery = useQuery({
    queryKey: ['activity', workspaceId],
    queryFn: () => window.orkestral['activity:list']({ workspaceId, limit: 50 }),
    refetchInterval: 5000,
  });
  const assignmentsQuery = useQuery({
    queryKey: ['agent-source-assignments', workspaceId],
    queryFn: () => window.orkestral['agent:source-assignments']({ workspaceId }),
  });

  const createMut = useMutation({
    mutationFn: (sourceId: string) =>
      window.orkestral['agent:create-source-specialist']({ workspaceId, sourceId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['agent-source-assignments'] });
      qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });

  const assignmentBySource = new Map((assignmentsQuery.data ?? []).map((a) => [a.sourceId, a]));
  // Dedup por source (pending mais recente), só desta sessão e ainda necessária.
  const bySource = new Map<string, { id: string; payload: SpecialistPayload; createdAt: string }>();
  for (const e of activityQuery.data ?? []) {
    if (e.kind !== 'proposal.pending') continue;
    const payload = (e.payload ?? {}) as SpecialistPayload;
    if (payload.type !== 'source-specialist' || !payload.sourceId) continue;
    if (payload.originSessionId !== sessionId) continue;
    const prev = bySource.get(payload.sourceId);
    if (!prev || e.createdAt > prev.createdAt) {
      bySource.set(payload.sourceId, { id: e.id, payload, createdAt: e.createdAt });
    }
  }
  const proposals = Array.from(bySource.values()).filter((p) => {
    if (dismissedMap[`act:${p.id}`] === p.id) return false;
    return assignmentBySource.get(p.payload.sourceId!)?.needsNewAgent ?? true;
  });

  if (proposals.length === 0) return null;

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl space-y-2 px-6">
      {proposals.map((p) => {
        const busy = createMut.isPending && createMut.variables === p.payload.sourceId;
        return (
          <div
            key={p.id}
            className="flex items-center gap-2.5 rounded-md border border-accent-purple/25 bg-accent-purple/[0.06] px-3 py-2.5"
          >
            <GitPullRequest className="h-4 w-4 shrink-0 text-accent-purple" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium text-text-primary">
                {t('chat.specialist.title', {
                  name: p.payload.recommendedAgentName ?? '',
                  source: p.payload.sourceLabel ?? '',
                })}
              </div>
              {p.payload.reason && (
                <div className="truncate text-[11.5px] text-text-muted">{p.payload.reason}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => navigate('/knowledge')}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-hairline-heavy px-2.5 text-[11.5px] text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
            >
              <BookOpen className="h-3.5 w-3.5" />
              {t('chat.specialist.viewKnowledge')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => createMut.mutate(p.payload.sourceId!)}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent-green px-2.5 text-[11.5px] font-semibold text-white transition-opacity hover:bg-accent-green/90 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              {t('chat.specialist.approve')}
            </button>
            <button
              type="button"
              onClick={() => dismiss(`act:${p.id}`, p.id)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-faint transition-colors hover:bg-surface-active hover:text-text-primary"
              aria-label={t('chat.specialist.dismiss')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
