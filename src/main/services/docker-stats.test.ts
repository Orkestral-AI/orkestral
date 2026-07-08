import { describe, it, expect } from 'vitest';
import { computeContainerStats } from './docker-stats';

describe('computeContainerStats', () => {
  it('calcula CPU% e memória a partir do payload bruto do Docker', () => {
    const raw = {
      cpu_stats: {
        cpu_usage: { total_usage: 2_000_000 },
        system_cpu_usage: 20_000_000,
        online_cpus: 2,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 1_000_000 },
        system_cpu_usage: 10_000_000,
      },
      memory_stats: { usage: 200 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
    };
    const out = computeContainerStats(raw);
    // cpuDelta=1e6, sysDelta=1e7 → (0.1)*2*100 = 20
    expect(out.cpuPercent).toBeCloseTo(20, 5);
    expect(out.memUsedMb).toBeCloseTo(200, 1);
    expect(out.memLimitMb).toBeCloseTo(1024, 1);
  });

  it('retorna 0% de CPU quando systemDelta é 0 (primeira amostra)', () => {
    const raw = {
      cpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      memory_stats: { usage: 0, limit: 0 },
    };
    const out = computeContainerStats(raw);
    expect(out.cpuPercent).toBe(0);
    expect(out.memLimitMb).toBe(0);
  });
});
