import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRepository } from '../db/repositories/agent.repo';
import { WorkspaceSourceRepository } from '../db/repositories/workspace-source.repo';
import { planSourceAgentAssignments } from './agent-assignment-policy';
import type { SourceAgentAssignment, WorkspaceSource } from '../../shared/types';

const sourceRepo = new WorkspaceSourceRepository();
const agentRepo = new AgentRepository();

function readPackageHints(source: WorkspaceSource): string {
  if (!source.path) return '';
  const hints: string[] = [];
  const pkgPath = join(source.path, 'package.json');
  try {
    if (existsSync(pkgPath)) {
      const raw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      hints.push(
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.scripts ?? {}),
      );
    }
  } catch {
    // best-effort
  }
  const composerPath = join(source.path, 'composer.json');
  try {
    if (existsSync(composerPath)) {
      const raw = readFileSync(composerPath, 'utf8');
      const composer = JSON.parse(raw) as {
        require?: Record<string, string>;
        'require-dev'?: Record<string, string>;
        scripts?: Record<string, unknown>;
      };
      hints.push(
        'php',
        'composer',
        ...Object.keys(composer.require ?? {}),
        ...Object.keys(composer['require-dev'] ?? {}),
        ...Object.keys(composer.scripts ?? {}),
      );
    }
  } catch {
    // best-effort
  }
  return hints.join(' ');
}

export function listSourceAgentAssignments(workspaceId: string): SourceAgentAssignment[] {
  const sources = sourceRepo.listByWorkspace(workspaceId);
  const agents = agentRepo.listByWorkspace(workspaceId);
  const packageHintsBySourceId = Object.fromEntries(
    sources.map((source) => [source.id, readPackageHints(source)]),
  );
  return planSourceAgentAssignments({ sources, agents, packageHintsBySourceId });
}
