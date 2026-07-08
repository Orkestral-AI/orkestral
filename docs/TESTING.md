# Testing — Orkestral

Quality gates and how to run them.

## Commands

```bash
npm run typecheck   # tsc (main + renderer) — gate principal
npm run lint        # eslint
npm test            # vitest run — testes unitários de lógica pura
npm run test:watch  # vitest em watch
```

`npm test` roda em ambiente **node** (sem Electron/DOM) e cobre apenas lógica
pura — funções determinísticas que não dependem de SQLite, do runtime do
modelo local nem do DOM. Arquivos de teste ficam ao lado do código (`*.test.ts`)
e são excluídos do `typecheck` (o Vitest os transpila por conta própria).

## Cobertura de testes unitários

| Arquivo                                           | O que cobre                                                                                                                                                                              | Tasks                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `src/main/services/chat-stream.test.ts`           | Buffer/parser de streaming: nunca vaza `<orkestral:...>` parcial; segura tag incompleta, bloco sem fechamento e prefixo parcial; deixa componente completo passar; corta token de hiring | P0-03                      |
| `src/main/services/smart-exec/morph.test.ts`      | Morphismo: SEARCH/REPLACE (parse + apply determinístico, ambíguo/ausente falham sem adivinhar), lazy edit por âncora, levenshtein                                                        | P0-13                      |
| `src/main/services/smart-exec/classifier.test.ts` | Roteamento Forge local vs premium: arquivo comum → local, sem arquivos → local (explora), área crítica → premium, muitos arquivos → premium, risco variável                              | P0-12, P0-14               |
| `src/main/services/smart-exec/config.test.ts`     | Política anti-premium: `allowPremiumFallback=false` por padrão, opt-in só via env explícito                                                                                              | P0-12                      |
| `src/shared/plan.test.ts`                         | Estado de plano: `planNeedsApproval` só com `pending` + filhos; aprovado some do inbox; sem estado → sem botão                                                                           | P0-04, P0-07, P0-08, P0-15 |

## Fluxo de aceite manual (E2E)

A UI crítica (chat, modais, drawers, sidebar) é validada por `typecheck` +
o roteiro manual de ponta a ponta em
[`../orkestral_claude_tasks_md/02_GLOBAL_ACCEPTANCE_TEST_PLAN.md`](../../orkestral_claude_tasks_md/02_GLOBAL_ACCEPTANCE_TEST_PLAN.md).

Resumo do caminho feliz a verificar manualmente (`npm run dev`):

1. Abrir chat com histórico grande → abre direto no fim, sem animação descendo
   do topo (P0-01).
2. Enviar mensagem com imagem + texto → imagem em cima, thumbnail menor; clicar
   abre o preview com baixar/abrir/fechar (P0-02).
3. Pedir uma tarefa grande → durante o streaming nenhum `<orkestral:...>` parcial
   aparece (P0-03); o botão "Aprovar" só surge quando o plano fica `pending`
   (todas as issues criadas), com estado "Criando as issues do plano…" antes (P0-04).
4. Clicar numa issue do plano → abre **modal** (não navega) com detalhes e ação
   "Abrir issue completa" (P0-05).
5. Aprovar → o chat publica "Plano aprovado — execução iniciada"; o inbox remove
   a pendência; o épico sai de `backlog` para `in_progress` (P0-06, P0-07, P0-08).
6. Agentes sem dependência iniciam em paralelo (entre repos); a sidebar mostra a
   bolinha verde de "trabalhando"; o épico agrega o status das subissues em tempo
   real (P0-14, P1-02, P0-10).
7. Se o Forge falhar, ele **bloqueia pedindo ajuda** (Tech Lead vira reviewer,
   responsável mantido) em vez de escalar pro premium (P0-11, P0-12, P0-13).
8. O inbox nunca mostra plano fantasma sem filhos reais (P0-15).

Para forçar o fallback premium (desligado por padrão), rode com
`ORKESTRAL_ALLOW_PREMIUM_FALLBACK=1`.
