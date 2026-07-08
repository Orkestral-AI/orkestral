export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string; // running | exited | paused | restarting | created
  status: string;
  labels: Record<string, string>;
  /** Engine de origem (Docker Desktop / OrbStack) — preenchido só no modo "Todas". */
  engine?: string;
}

export interface ComposeGroup {
  /** null = containers avulsos (sem compose). */
  project: string | null;
  containers: DockerContainer[];
}

const PROJECT = 'com.docker.compose.project';
const SERVICE = 'com.docker.compose.service';

export function isRunning(c: DockerContainer): boolean {
  return c.state === 'running' || c.state === 'restarting';
}

/** Agrupa containers por projeto compose. RODANDO PRIMEIRO (estilo OrbStack):
 *  projetos com algum container rodando vêm no topo; "Avulsos" (null) por último.
 *  Dentro do grupo, containers rodando primeiro, depois ordem alfabética por serviço. */
export function groupByCompose(containers: DockerContainer[]): ComposeGroup[] {
  const byProject = new Map<string | null, DockerContainer[]>();
  for (const ct of containers) {
    const key = ct.labels[PROJECT] ?? null;
    const arr = byProject.get(key) ?? [];
    arr.push(ct);
    byProject.set(key, arr);
  }

  const groups: ComposeGroup[] = [...byProject.entries()].map(([project, list]) => ({
    project,
    containers: list.sort((x, y) => {
      // Rodando antes de parado; empate → ordem alfabética por serviço/nome.
      const rx = isRunning(x) ? 0 : 1;
      const ry = isRunning(y) ? 0 : 1;
      if (rx !== ry) return rx - ry;
      return (x.labels[SERVICE] ?? x.name).localeCompare(y.labels[SERVICE] ?? y.name);
    }),
  }));

  return groups.sort((a, b) => {
    const ra = a.containers.some(isRunning) ? 0 : 1;
    const rb = b.containers.some(isRunning) ? 0 : 1;
    if (ra !== rb) return ra - rb; // grupo com algo rodando no topo
    if (a.project === null) return 1; // Avulsos por último
    if (b.project === null) return -1;
    return a.project.localeCompare(b.project);
  });
}
