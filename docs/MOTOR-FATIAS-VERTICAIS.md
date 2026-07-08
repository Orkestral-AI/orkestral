# Motor v2: fatias verticais, condução adaptativa, execução provada

Data: 2026-06-23
Status: proposta de redesenho (a validar com uma fatia mínima antes de reescrever)

## Resumo da estratégia (TL;DR)

O premium **planeja e conduz**, o Forge **executa e prova**. O premium escreve poucas
issues (7-8), cada uma uma checklist. O Forge executa um checkbox por vez, valida imports
contra o que existe de verdade, compila no loop e só marca o box com build verde. Quando
trava ou diverge, ele para e pergunta "terminei isso, e agora?"; o premium olha o estado
real (não o plano velho), devolve uma linha e segue. As telas saem por fatia vertical, uma
de cada vez, então você abre e testa cedo. Design é sempre do premium. Cerimônia que só
queima token é cortada. Economia é medida pelo líquido, não pelo bruto.

## Contexto

O teste do `chatbot_v3` (mesmo prompt do `chatbot_v2`, no app com os fixes) expôs o
problema central: 2h rodando, 40+ issues "concluídas", e nenhuma tela funcionando.
O scaffold melhorou (framework real, 0 rotas órfãs), o sistema ficou honesto (33 issues
marcadas `unverified`), mas o app não roda de ponta a ponta:

- páginas importando pacotes inventados (`@base-ui/react` com export errado,
  `@trello/use-workspace-delete-dialog-cancel-mutation`);
- `onboarding` degenerou em 100+ imports alucinados;
- `/inbox` com layout e sem página;
- a tela de "economia $3.67" ignora o premium queimado em planejamento, então a
  economia real pode ser negativa.

## A tese (o que deve ser verdade)

O modelo da casa é correto: **o premium planeja fundo, o local executa barato.** A
única seta quebrada é **a fidelidade de execução**: o premium escreve uma issue boa, o
local transforma em lixo, e o sistema escala de volta pro premium. Paga o plano e o
conserto, duas vezes. Por isso parece mais caro que usar o premium direto.

Conserta essa seta e a economia vira real: premium pensa uma vez, local executa certo e
barato, resultado é um MVP profundo por uma fração do custo de premium executando tudo.

## A gordura que queima premium (o imposto de cerimônia)

Hoje cada issue dispara `kb_create_page`, `skill_create`, "criar memória na KB",
`comment_on_issue`, `update_issue_status` e "registrar aprendizado (24 arquivos)". São
5-6 chamadas de cerimônia por issue, cada uma com o premium raciocinando em volta.
40 issues = 200+ chamadas de cerimônia. A maior parte do gasto foi o sistema **falando**
sobre o trabalho, não fazendo.

Causa-raiz mais funda: injeta-se tanta skill, tanta spec e tanto processo num orquestrador
que **já é um modelo premium capaz**, que o enviesa a trabalhar pior do que trabalharia
sozinho. A correção é **subtrair processo, não adicionar.** Cada token de instrução é um
viés.

---

## 1. A virada principal: fatias verticais, não camadas horizontais

Hoje o plano é por camada: scaffold, schema, auth, todas as páginas, todas as APIs.
Nada funciona até tudo estar pronto. Você espera 2h e abre no nada.

O novo plano é por fatia vertical: cada issue entrega **uma coisa que roda de ponta a
ponta** (tela + dado + clica e funciona).

- **Issue 1 = esqueleto que anda.** Scaffold + layout + UMA tela real que renderiza e
  abre. Depois da issue 1 você já abre `localhost:3000` e vê algo de pé.
- **Issue 2, 3, 4** = cada uma adiciona outra fatia testável ("agora o /inbox funciona",
  "agora dá pra criar um agente"). Você testa cada uma quando cai.

Software funcionando na issue 1, não na issue 40.

## 2. UI moderna de verdade (e o Forge não estraga)

Regra: **o premium é dono do design system, o Forge só monta com peças prontas.**

- No começo o premium fixa o design: shadcn + tokens + 3-4 componentes base + UMA tela
  de referência bonita. Vira o contrato visual, congelado.
- Toda tela seguinte é montada a partir desses componentes. O Forge nunca desenha, ele
  compõe o que já existe e já é bom.
- **Design sempre premium.** O Forge nunca toca em decisão visual nova (ele geraria UI
  de 2021).

## 3. Estrutura: 7-8 issues, cada uma uma checklist

- O premium escreve **7-8 issues**, cada uma com **3-6 checkboxes** de tarefa.
- O checkbox é a **unidade de execução verificável**. A issue é o pedaço que o humano lê.
- Progresso em tempo real: você vê "3/6" enchendo. Um "3/6" honesto, não 40 issues
  mentindo "concluída".
- Checkbox carrega **zero cerimônia**: é só um campo virando `true`. Granularidade fina
  sem pagar o ciclo de vida de issue 40 vezes.

## 4. O loop de execução por checkbox (o coração da confiabilidade)

Pra cada checkbox, o Forge roda este ciclo:

1. **Aterra:** recebe os exports/tipos reais que precisa + o componente existente pra
   reusar. Sem adivinhar de memória.
2. **Gera** a mudança (pequena, escala de preenchimento).
3. **Valida import/símbolo** contra o que existe de verdade no projeto (AST + exports do
   `node_modules`). Inventou import? Rejeita e regenera. Fica incapaz de shipar import
   fantasma.
4. **Compila** os arquivos tocados.
5. **Vermelho:** o erro volta pro modelo, corrige, repete (até N tentativas).
6. **Verde:** marca o checkbox, commita a fatia.
7. **Não converge:** escala pro premium **só aquele checkbox**, cirúrgico, não a issue
   inteira.

O checkbox só fica verde com build passando. Verde = prova, não afirmação.

## 5. O loop de condução: premium guia, Forge executa e pergunta

O Forge **não segura o contexto completo** (ele varia e faz o modelo derivar). Ele faz uma
task bounded e para, notificando "terminei isso, e agora?". O premium olha o **estado real
do repositório** (não o plano velho) e guia o próximo passo. Isso é pair programming:
sênior dá uma olhada rápida no que ficou e diz "bom, agora X" ou "não, conserta Y". O
sênior nunca escreve uma spec de 46 passos no começo; ele conduz olhando a realidade.

O que isso conserta: hoje o premium planeja tudo no abstrato **antes de ver o código**, e
o executor constrói lixo contra um plano errado. Aqui o premium decide o próximo passo
**depois de ver o que aconteceu de verdade.** A fonte da verdade é o repositório, não o
plano. Isso mata a deriva.

O risco (premium caro por chamar a cada task) é morto fazendo cada "tick" ser barato:

- Ao terminar um checkbox, monta-se um **snapshot compacto**: qual box terminou, build
  passou ou não, 1 linha de diff (arquivos tocados), a checklist que falta, e o erro se
  vermelho.
- O premium recebe **só isso** e devolve **uma linha**: próximo passo, "conserta isso", ou
  "issue pronta". A maioria dos ticks é "verde, próximo box", raciocínio e custo mínimos.

E tem um **dial de custo**: quando o próximo box já está claro na checklist e o build está
verde, **nem chama o premium**, entrega o próximo box direto pro Forge. O premium só entra
quando há decisão de verdade: **build vermelho, passo ambíguo, ou estado divergiu.** Ele
vira o guia nos checkpoints e tratador de exceção, não o narrador de cada tecla. Grounded
quando importa, barato no resto.

Loop final:

1. Premium escreve a issue + checklist uma vez (o plano profundo).
2. Forge pega um checkbox, executa bounded, valida import, compila.
3. Verde e próximo box claro? Segue sozinho pro próximo.
4. Vermelho, ambíguo ou divergiu? Para e pinga "terminei isso, build assim, e agora?" com
   o snapshot compacto.
5. Premium olha a realidade, devolve uma linha, Forge continua.

O Forge nunca segura contexto grande (não aluciná), o premium nunca trabalha do abstrato
(não deriva), e o custo fica no chão porque o premium só pensa de verdade quando o
repositório pede.

## 6. Testar enquanto roda

- Depois da issue 1, o dev server fica de pé. Botão **"Abrir preview"** clicável a
  qualquer momento pra ver o estado atual.
- Cada issue termina com algo que você **consegue fazer**. Nada de issue "só de infra"
  que entrega tela em branco.
- Você testa fatia por fatia enquanto as próximas ainda rodam. Mata a ansiedade de
  esperar.

## 7. Escopo: fino, mas funcional

- Na hora de planejar, o premium escolhe o **conjunto mais fino de fatias que ainda é um
  produto coerente**. Corta feature, nunca corta "funciona".
- Melhor **3 telas que rodam** que 8 quebradas. Menos MVP na entrega, mais de pé.

## 8. O que é deletado de hoje

- 40 issues vira 7-8.
- **Sem issues de QA separadas** (a verificação é o checkbox compilar, inline).
- **Sem cerimônia por issue** (KB page, skill, "registrar aprendizado de 24 arquivos" a
  cada passo). Aprende só do que falhou.
- **Sem comentário de status narrado.** O checkbox verde já é o status.
- **Forge fora do design.**
- **Menos skill injetada** no orquestrador. Só o que muda comportamento, não
  enciclopédia.

## 9. A fatia mínima pra provar isso (antes de reescrever o motor)

Provar a peça crítica (os loops das seções 4 e 5) numa escala mínima:

- Um repo que já compila + UMA issue com 3 checkboxes (ex: "adiciona uma tela `/status`
  com um card shadcn lendo um dado real").
- O loop rodando: gera, valida import, compila, corrige até verde, marca os boxes,
  pingando o premium só nos checkpoints.
- Entregável: a tela **rodando e visível**, os 3 checkboxes verdes por build passando, e
  o **número de tokens premium vs local**.

Se a fatia funcionar, o motor repensado é viável e a reescrita acontece em cima de uma
prova. Se não funcionar nem nela, a reescrita inteira foi economizada.

## Métricas de sucesso da validação

- **Funcional:** a tela abre e funciona no browser (não 500, não placeholder).
- **Provado:** todo checkbox que ficou verde tem build passando de verdade.
- **Sem alucinação:** zero import/símbolo inventado chegou ao disco (o validador barrou).
- **Econômico:** premium gasto (planejar + conduzir) + local, comparado ao mesmo prompt
  num agente premium em loop apertado (baseline estilo Claude Code). A tese só sobrevive
  se o número do Orkestral for menor.

## Status da implementação (2026-06-23)

Plano inteiro construído e provado em `src/main/services/motor-v2/` (51 testes verdes,
typecheck limpo, sem regressão na suíte do app). Cada peça do plano virou módulo testado:

| Seção do plano                       | Módulo                                                     | Testado |
| ------------------------------------ | ---------------------------------------------------------- | ------- |
| 1+3 (fatias verticais, plano enxuto) | `planner.ts`                                               | ✅      |
| 2 (design congelado)                 | `design-system.ts`                                         | ✅      |
| 4 (loop por checkbox)                | `import-validator` + `compiler-check` + `execute-checkbox` | ✅      |
| 5 (condução adaptativa)              | `conduct-adapter.ts` + `issue-runner.ts`                   | ✅      |
| 6 (preview contextual)               | `preview-policy.ts`                                        | ✅      |
| 7 (escopo fino) / 8 (cortes)         | embutido no planner + ausência de cerimônia                | ✅      |
| economia líquida                     | `token-ledger.ts`                                          | ✅      |
| ponta a ponta + integração           | `plan-runner.ts` + `entry.ts`                              | ✅      |

A seta quebrada (fidelidade de execução) está resolvida em código: o loop rejeita
alucinação de import, UI fora do kit e erro de tipo, e converge; plano não-enxuto é
rejeitado antes de gastar Forge; preview entende backend-only / greenfield / precisa do
server no ar; issue que não fecha vira `blocked` honesto; economia é o líquido.

**Único passo restante (precisa dos modelos vivos):** chamar `createMotorV2({ premiumChat })`
com o adapter de agente premium real do app e rodar uma vez com GPU, pra fechar o número
de economia premium vs local num projeto de verdade.

## Princípios que guiam o redesenho

1. O premium **planeja e conduz**, não narra. O local **executa e prova**, não inventa.
2. O checkbox é a unidade de prova. Verde só com build verde.
3. A fonte da verdade é o repositório, não o plano. O premium re-aterra na realidade a
   cada checkpoint.
4. Fatia vertical entrega valor visível cedo. Camada horizontal entrega no fim ou nunca.
5. Design é do premium. Forge compõe peças prontas.
6. Subtrair processo de um modelo capaz, não adicionar. Cada skill/handoff a mais é custo
   e viés.
7. Medir economia pelo **líquido** (premium gasto menos local economizado), nunca pelo
   bruto.
