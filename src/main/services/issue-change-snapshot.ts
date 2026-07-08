import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWorkspaceDir } from '../db/connection';

export interface IssueChangeSnapshotRecord {
  id: string;
  workspaceId: string;
  sourceId: string;
  issueId: string;
  files: string[];
  patchPath: string;
  createdAt: string;
}

function snapshotDir(workspaceId: string): string {
  const dir = join(resolveWorkspaceDir(workspaceId), 'change-snapshots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function assertSnapshotId(snapshotId: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(snapshotId)) {
    throw new Error('Snapshot de mudanças inválido.');
  }
}

export function createIssueChangeSnapshot(input: {
  workspaceId: string;
  sourceId: string;
  issueId: string;
  files: string[];
  patch: string;
}): IssueChangeSnapshotRecord | null {
  if (!input.patch.trim()) return null;
  const id = randomUUID();
  const dir = snapshotDir(input.workspaceId);
  const patchPath = join(dir, `${id}.patch`);
  const metaPath = join(dir, `${id}.json`);
  const record: IssueChangeSnapshotRecord = {
    id,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    issueId: input.issueId,
    files: input.files,
    patchPath,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(patchPath, input.patch, 'utf8');
  writeFileSync(metaPath, JSON.stringify(record, null, 2), 'utf8');
  return record;
}

export function readIssueChangeSnapshot(
  workspaceId: string,
  snapshotId: string,
): { record: IssueChangeSnapshotRecord; patch: string } {
  assertSnapshotId(snapshotId);
  const dir = snapshotDir(workspaceId);
  const metaPath = join(dir, `${snapshotId}.json`);
  const patchPath = join(dir, `${snapshotId}.patch`);
  if (!existsSync(metaPath) || !existsSync(patchPath)) {
    throw new Error('Snapshot de mudanças não encontrado para desfazer esta execução.');
  }
  const record = JSON.parse(readFileSync(metaPath, 'utf8')) as IssueChangeSnapshotRecord;
  if (record.workspaceId !== workspaceId || record.id !== snapshotId) {
    throw new Error('Snapshot de mudanças não pertence a este workspace.');
  }
  return { record, patch: readFileSync(patchPath, 'utf8') };
}
