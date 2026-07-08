import { describe, it, expect } from 'vitest';
import { groupByCompose, type DockerContainer } from './dockerGrouping';

const c = (id: string, labels: Record<string, string>): DockerContainer => ({
  id,
  name: id,
  image: 'img',
  state: 'running',
  status: 'Up',
  labels,
});

describe('groupByCompose', () => {
  it('agrupa por projeto compose e ordena serviços', () => {
    const list = [
      c('a', { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web' }),
      c('b', { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'db' }),
    ];
    const groups = groupByCompose(list);
    expect(groups).toHaveLength(1);
    expect(groups[0].project).toBe('app');
    expect(groups[0].containers.map((x) => x.id)).toEqual(['b', 'a']); // db antes de web
  });

  it('containers sem label vão pro grupo "Avulsos" por último', () => {
    const list = [
      c('solo', {}),
      c('a', { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web' }),
    ];
    const groups = groupByCompose(list);
    expect(groups.map((g) => g.project)).toEqual(['app', null]);
  });
});
