# motor-v2

O motor de execução do Orkestral repensado: **o premium planeja e conduz, o Forge executa
e prova.** Resolve em código a "seta quebrada" do chatbot_v3 (o local alucinava import e
shipava lixo). Desenho completo em `docs/MOTOR-FATIAS-VERTICAIS.md`.

## A garantia

Um checkbox só fica verde quando o código passa por **import válido + build verde**.
Verde = prova, não afirmação. Import fantasma (`@trello/...`, `Label` de um pacote que não
exporta Label) é barrado antes de tocar o disco.

## Peças (todas construídas e testadas)

| Arquivo               | Papel                                                                         |
| --------------------- | ----------------------------------------------------------------------------- |
| `import-validator.ts` | Barra pacote/export inventado (AST + resolução real).                         |
| `compiler-check.ts`   | Typecheck do código proposto via overlay, sem escrever no disco.              |
| `design-system.ts`    | Congela o kit de UI e barra UI nova / componente fora do kit.                 |
| `execute-checkbox.ts` | O loop de um checkbox: gera, valida import + design, compila, até verde.      |
| `issue-runner.ts`     | Orquestra a checklist: aplica, marca, escala pro premium, contabiliza.        |
| `planner.ts`          | Premium vira 1 linha em fatias verticais; valida plano enxuto.                |
| `preview-policy.ts`   | Preview contextual: backend-only? já existe? precisa do server no ar?         |
| `conduct-adapter.ts`  | Premium na escalada do checkpoint (atrás de interface).                       |
| `token-ledger.ts`     | Economia LÍQUIDA honesta (premium gasto vs local), avisa prejuízo.            |
| `forge-adapter.ts`    | Liga o Forge local real (`llamaChat`) na interface `GenerateFn`.              |
| `plan-runner.ts`      | Roda o plano de ponta a ponta (planner + fatias + design + preview + ledger). |
| `entry.ts`            | A costura: o app pluga `premiumChat` e chama `createMotorV2().run()`.         |

## Uso

```ts
import { runIssue, createForgeGenerate, type ConductFn } from './motor-v2';

const generate = createForgeGenerate(); // Forge local real

const conduct: ConductFn = async ({ checkbox, trail, diagnostics }) => {
  // Chama o premium SÓ no checkpoint/escalada, com o estado real.
  // Wire aqui no adapter de agente premium do app; retorna { code, premiumIn, premiumOut }.
  throw new Error('wire premium conduct here');
};

const result = await runIssue({
  issue, // { id, title, checkboxes: [{ id, instruction, targetFile, done }] }
  projectRoot, // repo alvo (tem tsconfig + node_modules)
  generate,
  conduct,
  onCheckpoint: (s) => console.log(`${s.checkboxId}: ${s.status} (${s.remaining} restantes)`),
});

console.log(result.doneCount, 'de', result.results.length, 'provados');
console.log(economyLine(result.economy)); // número líquido honesto
```

## Como o app pluga

```ts
import { createMotorV2 } from './motor-v2';

const motor = createMotorV2({
  premiumChat: async (system, user) => {
    // chame o adapter de agente premium do app; devolva texto + tokens
    return { text, premiumIn, premiumOut };
  },
  // forgeChat opcional: default = llamaChat real (Forge local)
});

const result = await motor.run({
  intent: 'cria um chatbot multi-canal',
  projectRoot: '/Users/.../meu-projeto',
  onCheckpoint: (s) => ui.update(s), // o "3/6" enchendo em tempo real
  onPreviewReady: (p) => ui.showPreview(p), // preview contextual liberado apos a fatia 1
});

console.log(result.economyLine); // numero LIQUIDO honesto
```

## Status

- **Tudo construído e testado (51 testes verdes, typecheck limpo, 0 regressão na suíte
  do app):** as 12 peças da tabela acima, do planner ao entry.
- **Único passo restante (precisa dos modelos vivos):** chamar `createMotorV2` com o
  `premiumChat` real do app e rodar uma vez com GPU pra fechar o número de economia
  premium vs local num projeto de verdade. A lógica inteira está pronta e provada.

Tudo determinístico é coberto por teste hermético (repo temp + validador/compilador reais

- modelos falsos roteirizados). A confiabilidade vem do loop, não de confiar no modelo.
