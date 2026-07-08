import { describe, it, expect } from 'vitest';
import { selectTemplate, STARTER_TEMPLATES } from './project-templates';

describe('selectTemplate', () => {
  it('escolhe Next.js+shadcn para um produto com UI (chatbot multi-canal com painel)', () => {
    const t = selectTemplate(
      'criar um sistema completo de chatbot multi-canal com AI Studio, dashboard e onboarding',
    );
    expect(t.name).toBe('nextjs-shadcn');
    expect(t.designSystem).toBe('shadcn');
  });

  it('escolhe Vite quando o pedido cita Vite/SPA', () => {
    const t = selectTemplate('uma SPA em Vite + React para um dashboard simples');
    expect(t.name).toBe('vite-react-shadcn');
  });

  it('escolhe Node API quando é só backend/API', () => {
    const t = selectTemplate('só uma API REST em Express, sem front, recebe webhooks');
    expect(t.name).toBe('node-api');
  });

  it('cai no default de UI (Next+shadcn) para pedido genérico de "criar um app"', () => {
    const t = selectTemplate('quero criar um app');
    expect(t.name).toBe('nextjs-shadcn');
  });

  it('todo template tem comandos de scaffold', () => {
    for (const t of STARTER_TEMPLATES) expect(t.commands.length).toBeGreaterThan(0);
  });

  it('o overlay curado (estilo bolt.diy) ensina ONDE pôr os arquivos — anti rota órfã', () => {
    const next = STARTER_TEMPLATES.find((t) => t.name === 'nextjs-shadcn')!;
    const agents = next.overlayFiles?.find((f) => f.path === 'AGENTS.md');
    expect(agents).toBeDefined();
    // A regra-chave contra o lixo do run anterior: rotas SÓ sob src/app/.
    expect(agents!.content).toMatch(/src\/app\/api\/<nome>\/route\.ts/);
    expect(agents!.content).toMatch(/NUNCA crie .*route\.ts. na raiz/);
    // Exemplo de rota CORRETA já incluso (o modelo copia o padrão).
    expect(next.overlayFiles?.some((f) => f.path === 'src/app/api/health/route.ts')).toBe(true);
  });
});
