# Prompt Mestre: Orkestral Forge, RAG, Post-training e Fine-tuning Real

Use este prompt para retomar a arquitetura do Orkestral Forge e evoluir o sistema com foco em modelo local, RAG, aprendizado real, post-training, multiagentes, QA, execução híbrida e experiência de desenvolvedor.

---

## Contexto do Produto

O Orkestral é uma aplicação desktop local para desenvolvedores. O cliente baixa e roda na própria máquina. A proposta é ser uma plataforma operacional para devs, parecida com uma squad de agentes locais, capaz de:

- conectar repositórios locais, GitHub e Azure Repos;
- entender o projeto profundamente;
- criar agentes especializados por repo e por papel;
- manter uma base de conhecimento viva;
- executar tarefas de código;
- mostrar progresso em tempo real;
- revisar mudanças;
- rodar QA;
- economizar uso de sessão/tokens de CLIs externas como Claude Code e Codex;
- evoluir o Orkestral Forge até ele conseguir resolver cada vez mais tarefas localmente.

O objetivo final é chegar em uma experiência de alto nível, parecida com Claude Code/Codex, mas com inteligência local, memória por projeto e economia real para o usuário.

---

## Objetivo Principal

Analise o projeto inteiro e evolua a arquitetura para transformar o Orkestral Forge em um sistema que realmente aprende com execuções reais.

Não trate "fine-tuning" como simples salvamento de memória. Separe claramente:

- RAG;
- embeddings;
- memória operacional;
- exemplos de treino;
- post-training;
- fine-tuning real;
- execução local;
- operação híbrida com CLI premium.

Ao final, quero saber exatamente:

- o que já funciona;
- o que apenas parece funcionar;
- o que ainda é RAG/memória;
- o que falta para virar fine-tuning real;
- quais arquivos foram alterados;
- quais testes comprovam que não quebramos nada.

---

## Regras de Trabalho

1. Leia o código antes de propor mudanças.
2. Preserve tudo que já foi construído.
3. Não quebre fluxo de onboarding, issues, chat, agents, KB, embeddings ou source sync.
4. Faça mudanças pequenas e verificáveis.
5. Ao alterar código, rode testes e typecheck.
6. Se encontrar conflitos ou mudanças de outro dev, trabalhe com elas, não reverta.
7. Sempre pense como arquiteto sênior de produto de IA para devtools.
8. O sistema precisa rodar localmente com qualidade, baixa latência e previsibilidade.

---

## Arquitetura Desejada

### 1. Base de Conhecimento e RAG

O sistema deve criar e atualizar KB automaticamente quando o usuário:

- cria um workspace;
- conecta repo GitHub;
- conecta Azure Repos;
- seleciona pasta local;
- adiciona novo source depois;
- faz pull/sync;
- recebe mudanças externas de outros devs.

A KB deve:

- indexar arquivos relevantes;
- ignorar ruído;
- gerar embeddings;
- ter busca híbrida: vetorial + lexical + rerank;
- manter vínculo com workspace, source, repo, arquivos e agentes;
- alimentar o `Repo Intelligence`/contexto dos agentes;
- atualizar quando arquivos mudam;
- invalidar contexto obsoleto.

Critérios importantes:

- cobertura por repo;
- deduplicação;
- qualidade do chunk;
- latência de busca;
- rastreabilidade do que foi aprendido;
- progresso visível para o usuário.

### 2. Modelo Local: Orkestral Forge

O Forge local deve ser mais do que um leitor de repo.

Hoje ele pode:

- classificar risco de task;
- tentar patch local;
- usar arquivos alvo;
- gerar SEARCH/REPLACE;
- aplicar patch de forma determinística;
- cair para CLI premium quando falha.

Mas o objetivo é evoluir para:

- receber contexto RAG diretamente;
- operar com context-pack por issue;
- usar memória e exemplos verificados;
- gerar múltiplos candidatos de patch;
- validar em sandbox;
- escolher melhor patch com verificador local;
- reduzir dependência de Claude/Codex ao longo do tempo.

### 3. Híbrido Forge + CLI

Quando o usuário ativar o modo híbrido:

- tarefas simples devem tentar Forge local primeiro;
- tarefas médias podem usar Forge + verificador;
- tarefas complexas devem ir para Claude/Codex CLI;
- se Forge falhar, escalar para CLI mantendo o contexto;
- se CLI estiver sendo usada, preservar todo o histórico;
- mostrar no trace quando usou Forge, quando escalou e por quê;
- mostrar economia de sessão/tokens em linguagem entendível para o usuário.

Não exibir custo bruto em dólar se isso não fizer sentido para o cliente. Preferir:

- "uso de sessão evitado";
- "Forge resolveu localmente";
- "CLI premium preservada";
- "escalado por risco alto";
- "escalado por falha de patch local".

### 4. Fine-tuning Real e Post-training

O sistema só terá fine-tuning real quando houver um pipeline que gere um adapter/modelo novo a partir de trajetórias verificadas.

Pipeline desejado:

```text
Execuções reais verificadas
        ↓
Dataset de trajetórias
        ↓
Curadoria/score/QA/undo filter
        ↓
SFT ou RFT
        ↓
DPO/KTO/RLVR
        ↓
Adapter LoRA/QLoRA
        ↓
Merge/quantização GGUF
        ↓
Forge local vNext
```

O sistema deve salvar trajetórias completas:

- prompt original;
- workspace/source/repo;
- fingerprint do repo;
- agente responsável;
- plano;
- arquivos explorados;
- searches;
- KB hits;
- contexto injetado;
- patches tentados;
- diff final;
- comandos executados;
- testes/build/lint;
- QA;
- code review;
- aprovação ou rejeição;
- undo;
- modelo usado;
- motivo de escalação;
- resultado final.

Somente trajetórias verificadas devem entrar no dataset de treino.

Não treinar com:

- execução com undo;
- task rejeitada;
- diff sem teste;
- resultado sem validação;
- saída duplicada;
- alteração ruidosa;
- exemplo fora do source correto;
- mudança que quebrou design system.

### 5. SWE Reasoning / Post-training

Aplicar técnicas inspiradas em agentes de software engineering:

- trajectory synthesis;
- trajectory curation;
- long-horizon SFT;
- rejection fine-tuning;
- reinforcement learning with verifiable rewards;
- test-time scaling;
- verifier model;
- sandbox validation;
- repo-aware context packing.

Referências importantes para considerar:

- SWE-Master: post-training para agentes SWE com trajetórias, SFT, RL e test-time scaling.
- SWE-Gym: treino com repositórios reais, ambiente executável e testes.
- Agent-RLVR: RL com recompensas verificáveis para agentes.
- SWE-smith: geração de tarefas de software engineering a partir de repositórios.
- LoRA/QLoRA: adapters para fine-tuning eficiente.

### 6. Multiagentes por Repo

O Orkestral deve criar e manter uma squad coerente:

- CEO;
- Tech Lead / agente especialista por repo;
- Frontend;
- Backend;
- Mobile quando realmente for mobile;
- Designer quando houver design system/UI;
- QA;
- Code Reviewer;
- Security/Performance quando necessário.

Cada agente precisa:

- conhecer os sources que fazem parte do seu escopo;
- não misturar app, web e backend de forma errada;
- respeitar stack e design system;
- usar KB antes de responder ou editar;
- atualizar memória durável quando descobrir convenções;
- receber contexto atualizado quando source muda.

Quando um novo repo entra:

1. detectar role real do repo;
2. analisar stack;
3. gerar KB;
4. propor agente especialista;
5. mostrar progresso visível;
6. pedir aprovação do CEO/usuário;
7. criar agente após aprovação;
8. atualizar `Repo Intelligence`.

### 7. QA Forte

O agente QA deve agir como validador real, não como texto genérico.

Ao finalizar uma task, o CEO deve poder perguntar:

- deseja rodar QA?
- deseja code review?
- deseja aplicar correções?

O QA deve:

- entender a issue;
- montar plano de teste;
- rodar testes relevantes;
- validar build/lint/typecheck quando aplicável;
- validar design system no frontend;
- validar contrato frontend/backend quando houver integração;
- registrar evidências;
- reprovar com motivo claro;
- devolver para o agente correto corrigir sem perder contexto.

O usuário deve ver:

- plano de QA;
- etapas concluídas;
- falhas;
- arquivos envolvidos;
- evidências;
- status em tempo real.

### 8. UX de Execução em Tempo Real

A experiência do chat precisa mostrar exatamente o que está acontecendo.

Quando uma task for aprovada:

- o chat deve entrar em "Working";
- mostrar tempo de execução;
- mostrar ferramentas usadas;
- mostrar buscas;
- mostrar arquivos explorados;
- mostrar arquivos editados;
- mostrar card agregado de mudanças;
- atualizar progresso das issues;
- não duplicar mensagens;
- não criar cards repetidos por issue;
- não travar em queued/review/running;
- persistir estado se o usuário sair e voltar;
- notificar quando finalizar;
- permitir continuar após interrupção.

Formato desejado:

- `Explored 3 files, 1 search`;
- `Searching files in ...`;
- `Editing src/... +3 -1`;
- `4 files changed +238 -250`;
- botão `Review`;
- botão `Undo`;
- progresso agregado do plano completo.

### 9. Undo e Aprendizado

Undo precisa ser transacional.

Quando o usuário desfaz uma mudança:

- reverter arquivos alterados;
- atualizar chat;
- atualizar diff card;
- invalidar trajetória como dado de treino;
- impedir que esse exemplo vire aprendizado positivo;
- registrar motivo;
- se necessário, marcar learning como rejeitado.

Uma task desfeita não pode alimentar fine-tuning como sucesso.

### 10. Source Freshness

Antes de editar qualquer source:

- checar se repo está atualizado;
- para GitHub/Azure, fazer pull/fetch seguro;
- detectar mudanças externas;
- atualizar KB quando arquivos mudarem;
- atualizar embeddings;
- atualizar Repo Intelligence;
- avisar usuário quando houver mudança relevante;
- evitar operar com contexto obsoleto.

Para pasta local:

- detectar mudanças no filesystem;
- recalcular fingerprint;
- atualizar KB incremental.

---

## Primeira Execução Recomendada

Execute nesta ordem:

1. Auditar estado atual do Forge local.
2. Confirmar onde RAG entra no CLI e onde não entra no Forge local.
3. Implementar context-pack direto no Forge local.
4. Criar/fortalecer trajectory recorder.
5. Garantir que undo invalida aprendizado.
6. Exportar dataset de treino com apenas trajetórias verificadas.
7. Adicionar testes unitários para scoring, export e invalidation.
8. Rodar typecheck e testes.
9. Gerar relatório com evidências.

---

## Perguntas Técnicas Que Devem Ser Respondidas

Ao final, responda:

1. O Forge local hoje está apenas consultando dados ou está aprendendo?
2. O que exatamente é RAG no sistema?
3. O que exatamente é fine-tuning real?
4. Quais dados entram no aprendizado?
5. Quais dados são descartados?
6. O que acontece quando o usuário dá undo?
7. Como o sistema decide se uma execução é boa para treino?
8. Como o modelo local recebe contexto do repo?
9. Como o sistema evita contexto obsoleto após pull/sync?
10. Como a CLI premium e Forge local preservam contexto entre si?
11. Como o usuário enxerga economia de sessão?
12. O que falta para o Forge substituir a CLI em mais casos?

---

## Definição de Pronto

Considere pronto apenas se:

- typecheck passa;
- testes passam;
- não há conflitos;
- não há regressão no onboarding;
- KB continua indexando;
- embeddings continuam funcionando;
- issue execution continua funcionando;
- traces mostram roteamento local/híbrido;
- trajetória é salva;
- exemplos ruins são filtrados;
- undo invalida aprendizado;
- usuário tem feedback visual claro;
- relatório final explica o estado real sem maquiagem.

---

## Entrega Esperada

Entregue:

1. resumo executivo;
2. lista de arquivos alterados;
3. explicação da arquitetura final;
4. evidências de teste;
5. riscos restantes;
6. próximos passos para chegar em fine-tuning real;
7. se houver commit, usar mensagem semântica.

Mensagem de commit sugerida:

```text
feat(forge): add verified trajectory pipeline for local post-training
```
