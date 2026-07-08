import type { Issue, IssueRun, IssueVerificationState } from './types';

export interface SessionCodeChangeFile {
  sourceId: string;
  sourceLabel: string;
  issueId: string;
  snapshotId?: string;
  path: string;
  additions: number;
  deletions: number;
}

export interface SessionCodeChange {
  sourceId: string;
  sourceLabel: string;
  issueId: string;
  snapshotId?: string;
  files: string[];
}

export interface SessionCodeChangeSummary {
  files: SessionCodeChangeFile[];
  changes: SessionCodeChange[];
  sourceIds: string[];
  additions: number;
  deletions: number;
}

export interface LiveProgressEvent {
  kind:
    | 'queued'
    | 'started'
    | 'phase'
    | 'tool-use'
    | 'file-change'
    | 'model-route'
    | 'finished'
    | 'error';
  label: string;
  at: number;
  runId?: string;
}

export interface IssueProgressState {
  done: boolean;
  progressed: boolean;
  cancelled: boolean;
  queued: boolean;
  running: boolean;
  errored: boolean;
  reviewing: boolean;
  /** Veredito de verificação do trabalho concluído (issue.metadata.verification). */
  verification: IssueVerificationState;
  /** done + verificado (passou na validação OU não havia código pra verificar). */
  verifiedDone: boolean;
  last?: LiveProgressEvent;
}

function decodeCodeChangeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseCodeChangeAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  for (const match of raw.matchAll(attrRe)) {
    attrs[match[1]] = decodeCodeChangeAttr(match[2]);
  }
  return attrs;
}

export function buildSessionCodeChangeSummary(issues: Issue[]): SessionCodeChangeSummary | null {
  const blockRe = /<orkestral:code-changes([^>]*)>([\s\S]*?)<\/orkestral:code-changes>/gi;
  const fileRe = /<file([^>]*)\/>/gi;
  const files = new Map<string, SessionCodeChangeFile>();
  const changes = new Map<string, SessionCodeChange>();
  for (const issue of issues) {
    const block = (issue.metadata as { lastCodeChangeBlock?: string } | null)?.lastCodeChangeBlock;
    if (!block) continue;
    for (const blockMatch of block.matchAll(blockRe)) {
      const attrs = parseCodeChangeAttrs(blockMatch[1]);
      const sourceId = attrs.source_id ?? '';
      const sourceLabel = attrs.source_label ?? 'Source';
      const issueId = attrs.issue_id ?? issue.id;
      const snapshotId = attrs.snapshot_id?.trim() || undefined;
      const changeKey = snapshotId
        ? `${sourceId}:snapshot:${snapshotId}`
        : `${sourceId}:issue:${issueId}`;
      const changeFiles: string[] = [];
      for (const fileMatch of blockMatch[2].matchAll(fileRe)) {
        const fileAttrs = parseCodeChangeAttrs(fileMatch[1]);
        const path = fileAttrs.path?.trim();
        if (!sourceId || !issueId || !path) continue;
        const additions = Number(fileAttrs.additions ?? 0) || 0;
        const deletions = Number(fileAttrs.deletions ?? 0) || 0;
        changeFiles.push(path);
        const key = `${sourceId}:${path}`;
        const current = files.get(key);
        files.set(key, {
          sourceId,
          sourceLabel,
          issueId,
          snapshotId,
          path,
          additions: Math.max(current?.additions ?? 0, additions),
          deletions: Math.max(current?.deletions ?? 0, deletions),
        });
      }
      if (changeFiles.length > 0) {
        const current = changes.get(changeKey);
        changes.set(changeKey, {
          sourceId,
          sourceLabel,
          issueId,
          snapshotId,
          files: [...new Set([...(current?.files ?? []), ...changeFiles])],
        });
      }
    }
  }
  const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (list.length === 0) return null;
  return {
    files: list,
    changes: [...changes.values()],
    sourceIds: [...new Set(list.map((file) => file.sourceId))],
    additions: list.reduce((sum, file) => sum + file.additions, 0),
    deletions: list.reduce((sum, file) => sum + file.deletions, 0),
  };
}

export function progressStateForIssue(
  issue: Pick<Issue, 'status' | 'metadata'>,
  events: LiveProgressEvent[] | undefined,
  latestRun?: Pick<IssueRun, 'status'> | null,
): IssueProgressState {
  const last = events?.at(-1);
  const errored =
    issue.status === 'blocked' || latestRun?.status === 'failed' || last?.kind === 'error';
  const done = issue.status === 'done';
  const cancelled = issue.status === 'cancelled' || latestRun?.status === 'cancelled';
  const reviewing =
    issue.status === 'in_review' ||
    (latestRun?.status === 'done' && issue.status !== 'done' && issue.status !== 'cancelled') ||
    (last?.kind === 'finished' && issue.status !== 'done' && issue.status !== 'cancelled');
  const queued =
    !reviewing &&
    (issue.status === 'todo' || latestRun?.status === 'queued' || last?.kind === 'queued');
  const running =
    !reviewing &&
    (latestRun?.status === 'running' ||
      last?.kind === 'started' ||
      last?.kind === 'phase' ||
      last?.kind === 'tool-use' ||
      last?.kind === 'file-change' ||
      last?.kind === 'model-route');
  const verification =
    (issue.metadata as { verification?: IssueVerificationState } | null)?.verification ??
    'not_applicable';
  // done VERIFICADO = concluído E (passou na validação OU não havia código a
  // verificar). Sinal de QUALIDADE à parte — não trava a barra.
  const verifiedDone = done && verification !== 'unverified';
  // "progressed" = etapa concluída (status `done`) — espelha o status REAL da
  // issue, consistente com a página de Objetivos e a lista de Issues. Uma issue
  // `done` mas não-verificada CONTA como concluída aqui (o épico já rolou pra done);
  // o nível de prova fica em `verifiedDone`/`verification`, sem travar o progresso.
  // in_review (reviewing) e queued/running NÃO contam (done=false).
  const progressed = done;
  return {
    done,
    progressed,
    cancelled,
    queued,
    running,
    errored,
    reviewing,
    verification,
    verifiedDone,
    last,
  };
}
