# Orkestral — o que é, o que faz e como é usado

> Documento-guia em português. Explica a aplicação Orkestral por inteiro: o problema
> que resolve, os conceitos, a jornada de uso, as telas, os dois pilares (economia e
> privacidade) e, por baixo, a engine de execução (o Forge). Atualizado em 2026-06-17.

---

## 1. Em uma frase

O Orkestral é um **app desktop que orquestra um TIME de agentes de IA para fazer
trabalho de software de ponta a ponta** — você conversa com um "CEO" (orquestrador), ele
**decompõe** o pedido, **delega** pra especialistas (Backend, Frontend, Code Reviewer,
Designer, QA), eles **executam de verdade** no seu repositório, **revisam** o resultado e
**reportam de volta** — economizando ao rodar o máximo possível num modelo **local**.

Não é um chat que cospe código pra você colar. É uma **equipe** que pega uma tarefa,
quebra em issues, mexe nos arquivos, valida e te entrega revisado.

---

## 2. O problema que resolve

Ferramentas de IA pra código hoje ou são (a) um chat onde você copia/cola e gerencia
tudo na mão, ou (b) um agente único que faz uma tarefa por vez sem processo. Nos dois
casos **você** é quem decompõe, acompanha, valida e cobra.

O Orkestral move isso pra um **processo de time**: decomposição automática em
épicos/sub-issues por área, execução pelos especialistas certos, revisão obrigatória e
fechamento de ciclo — tudo acompanhável em tempo real, e **barato** (executa local) e
**privado** (o código não sai da máquina).

---

## 3. Os conceitos

| Conceito                | O que é                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Workspace**           | O espaço de trabalho (uma empresa/projeto). Tem cor, time e sources próprios.                                                                                                        |
| **Source**              | Um repositório ou pasta conectado ao workspace. É onde o trabalho acontece.                                                                                                          |
| **Knowledge Base (KB)** | O índice do source: ao conectar, o Orkestral **analisa e indexa** o código (busca semântica) em background, para os agentes trabalharem **grounded** no código real, não no achismo. |
| **Time / Agentes**      | Especialistas contratados: **CEO** (orquestrador), Backend, Frontend, Code Reviewer, Designer, QA… Cada um tem papel, modelo e a quem reporta.                                       |
| **Chat / Sessão**       | Onde você fala com os agentes. O CEO responde, decompõe e delega. Você pode `@mencionar` um especialista pra ele assumir o turno.                                                    |
| **Issue / Épico**       | A unidade de trabalho. Um pedido não-trivial vira um **épico** + **sub-issues** por área (frontend e backend separados pro especialista certo).                                      |
| **Goal (objetivo)**     | Pra requisições grandes, o CEO cria um **objetivo** e valida a entrega contra ele (auto-verificação ao chegar a 100%).                                                               |
| **Review**              | Toda execução que tocou código passa pelo **Code Reviewer** — o gate final de qualidade.                                                                                             |
| **Forge**               | O **executor local** (modelo de IA na sua máquina) que faz o trabalho elegível sem gastar premium. Ver §7.                                                                           |

---

## 4. Como se usa — a jornada

1. **Cria/abre um workspace** e **conecta um source** (seu repositório).
2. A **KB indexa** o source em background (embeddings + busca semântica). Não bloqueia
   nada — você já pode conversar.
3. **Contrata o time**: o CEO + os especialistas que fizerem sentido. (O **Forge** local
   é oferecido/baixado sob demanda no hiring.)
4. **Pede no chat**: _"implementa ligação por WhatsApp no app"_.
5. O **CEO analisa** (lendo o código real via KB) e monta um **plano**: um épico +
   sub-issues (backend, frontend, design, QA separados) e, se for grande, um **goal**.
6. **Você aprova o plano.** Nada toca o código sem aprovação quando nasce de um chat.
7. Os **especialistas executam** suas issues — Forge local primeiro, premium de rede. Você
   **acompanha em tempo real**: timeline da issue (explorar → gerar → aplicar → validar),
   arquivos alterados, comentários dos agentes.
8. O **Code Reviewer revisa**. Os veredictos voltam pro chat: 🔍 em análise, 🔁 mudanças
   pedidas, ✅ aprovado.
9. O **CEO fecha o ciclo**: consolida tudo e responde no chat o que foi feito/encontrado,
   o que há pra aprovar e os próximos passos.
10. **Você revisa os diffs** em _Code changes_ e aprova.

O fio condutor: **você pede, o time entrega revisado, e você nunca fica no escuro.**

---

## 5. As telas principais

- **Chat / Sessão** — conversa com os agentes; é de onde tudo parte. Mostra as ações dos
  agentes, roteamento de modelo e o card de execução do plano.
- **Issues** — quadro de épicos/sub-issues com status; o detalhe de cada issue tem a
  **timeline** descritiva do que aconteceu + os comentários de cada agente.
- **Goals** — objetivos com **painel de atingimento** (progresso, breakdown por status,
  timeline) e validação da entrega.
- **Sources / KB** — os repositórios conectados e o estado de indexação/freshness.
- **Configurações** — Modelos (adapters disponíveis), **Comportamento do agente**
  (roteamento + tentativas antes do fallback), Aparência, Privacidade, Dados, etc.
- **Recursos / Ferramentas** — central de ferramentas (Fast Apply/Morph etc.) e o cofre
  de **secrets** cifrado (a chave nunca chega no renderer).

---

## 6. Os dois pilares

- **Economia** — o trabalho elegível roda no **Forge local** sempre que possível, em vez
  de gastar tokens premium (Claude/Codex). O premium é a **rede** que garante a entrega
  quando o local não fecha — não o caminho padrão.
- **Privacidade** — o **código do usuário nunca sai da máquina**. O Forge roda local; o
  treino aprende _como_ o usuário lida com código (padrões de estilo), **nunca o código
  em si**, que fica em SQLite local e jamais vai pra nuvem.

**Stack (pra contexto técnico):** Electron + electron-vite, React + TypeScript, Tailwind
v4, Zustand, TanStack Query. Banco SQLite (better-sqlite3 + Drizzle). Processos:
`src/main` (Node/Electron), `src/renderer` (UI), `src/shared` (tipos + IPC).

---

## 7. Por baixo: o Forge (o executor local)

O "Forge" é o **modelo de IA local** que executa o trabalho. Dois modelos GGUF rodam na
máquina via **node-llama-cpp** (Metal no macOS, CPU nos demais):

| Papel                | Modelo                                 | Tamanho | Função                                                     |
| -------------------- | -------------------------------------- | ------- | ---------------------------------------------------------- |
| **Forge** (executor) | Qwen2.5-Coder-**3B**-Instruct (Q4_K_M) | ~2,1 GB | gera/edita código, cria arquivos, escreve specs/relatórios |
| **Embeddings**       | Qwen3-Embedding-0.6B (Q8_0)            | ~0,6 GB | índice semântico do repo (busca/RAG)                       |

- **Onde ficam:** `~/.orkestral/models/`. **De onde baixa:** CDN próprio no **Cloudflare
  R2** (manifesto `forge/manifest.json` com `{version,url,sha256,sizeBytes}`; o app
  verifica o sha256 antes de trocar), HuggingFace só de fallback. O modelo é baixado sob
  demanda (aceite no hiring), não vem no instalador.

### Como uma issue é executada (engine `smart-exec`)

```
classify → plan → resolve alvos → [por arquivo: tiers de edição] → validação → review
```

1. **Classify** — deriva arquivos a **editar** vs a **criar** e os comandos de validação.
2. **Plan** — monta as tasks e anexa o **contrato `done`** (critério verificável de
   "pronto") a toda instrução — é o que vira uma ordem executável.
3. **Resolve alvos** — expande wildcards/diretórios do CEO em arquivos reais.
4. **Tiers de edição** (do mais seguro ao mais agressivo): lazy edit (formato próprio,
   constrangido por **grammar GBNF**, aplicado **determinístico** pelo app) → **região**
   (isola o menor bloco que contém o foco e reescreve só ele) → rewrite inteiro (só
   arquivo pequeno, com guarda anti-encolhimento) → create (arquivo novo). Tudo com
   **snapshot + rollback** — quem grava é o app, nunca o modelo.
5. **Best-of-N** — se não fecha, sobe a temperatura e tenta de novo; o verificador
   determinístico (aplicar + validar) fica com o primeiro candidato que passa.
6. **Validação** — syntax-check **só do arquivo tocado** (nunca a tooling do repo do
   usuário, que falha por erro pré-existente). A rede real é o Code Reviewer.
7. **Review** — execução que tocou código vai pro Code Reviewer (aprova → done; pede
   mudanças → re-executa com o foco do revisor).

**Inteligência local:** WarpGrep + embeddings (acha ONDE mexer), RAG-de-edits (few-shot
com edits que o usuário já aceitou), treino/LoRA (aprende o estilo do usuário, nunca o
código). **Roteamento** (`model-routing-policy.ts`): tenta local N vezes; se não fecha,
escala pro premium (fallback ligado por padrão, orçamento de 1 escalação por issue).

---

## 8. O upgrade recente (2026-06-17) e os problemas que enfrentamos

O sintoma era **"o Forge nunca conclui, sempre escala"**. O diagnóstico (grounded no
banco real) mostrou que **não era escalação — era BLOQUEIO**. Causas-raiz e correções:

- **Criar arquivo novo editava o arquivo errado** → detecção de caminho explícito de
  criação (qualquer stack), criando o arquivo certo.
- **Editar dentro de um componente React bloqueava** (a "região" virava o componente
  inteiro) → isolamento do **menor bloco `{…}`** que contém o foco.
- **Validação falsa** (o repo de frontend sem `node_modules` fazia `npm run lint` falhar)
  → não roda mais a tooling do repo; só syntax-check do arquivo.
- **O teto do modelo pequeno** (qualidade de primeira) → atacado por **3 frentes que se
  compõem**: modelo **1.5B → 3B**, **best-of-N** com temperatura variável, e **fallback
  premium** como rede. Não é mais bloqueio — no pior caso, o premium fecha.
- **Hospedagem própria** → o Forge agora é servido do **R2** (3B publicado como v2), com
  verificação de sha256, em vez de depender do HuggingFace.

A política mudou de "bloquear pra economizar" para **"tentar local N vezes e cair pro
premium pra garantir a entrega"**, com o nº de tentativas configurável pelo usuário.

---

## 9. Estado atual e próximos passos

**Pronto:** 3B no R2 (v2) + verificação sha256; best-of-N; validação sem tooling do
usuário; fallback premium por padrão + tentativas configuráveis; detecção de create +
resgate de região JSX.

**Para valer na máquina:** rodar o app com
`ORKESTRAL_FORGE_CDN=https://pub-049fc618193a4c5a9cafa976442c23c9.r2.dev` (lê o manifesto
v2, baixa o 3B); reiniciar o `npm run dev`; mover issues `blocked` → `todo` pra
reprocessarem.

**Próxima alavanca (não feita):** grammar dinâmica de âncora — gerar a GBNF a partir do
conteúdo real do arquivo, forçando o bloco SEARCH a ser algo que **existe** (o modelo não
conseguiria inventar uma âncora que não casa). É o golpe mais forte contra "o edit não
aplicou".

---

### Referência rápida de arquivos

| Área                                        | Arquivo                                         |
| ------------------------------------------- | ----------------------------------------------- |
| Orquestração da execução                    | `src/main/services/smart-exec/orchestrator.ts`  |
| Classificação / criação / validação         | `src/main/services/smart-exec/classifier.ts`    |
| Região editável (resgate JSX)               | `src/main/services/smart-exec/region.ts`        |
| Aplicação determinística de edit            | `src/main/services/smart-exec/morph.ts`         |
| Runtime do modelo local (sampling, grammar) | `src/main/services/smart-exec/llama-runtime.ts` |
| Validação                                   | `src/main/services/smart-exec/validators.ts`    |
| Política de roteamento / fallback           | `src/main/services/model-routing-policy.ts`     |
| Gate de execução de issue + best-of-N       | `src/main/services/issue-execution-service.ts`  |
| Download de modelo + sha256                 | `src/main/services/model-download-service.ts`   |
| Manifesto do Forge (R2)                     | `src/main/services/forge-manifest.ts`           |
| Publicação no R2                            | `scripts/publish-forge-r2.sh`                   |
