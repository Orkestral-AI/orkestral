<div align="center">

<img src="resources/icon.png" width="96" alt="Orkestral" />

# Orkestral

### O deck operacional de desenvolvimento com IA

**Contrate um time de agentes de IA que planeja, rastreia, executa e revisa o seu código — tudo num app desktop local-first.**

[![Plataforma](https://img.shields.io/badge/plataforma-macOS%20·%20Windows%20·%20Linux-1b1b1f)](#)
[![Stack](https://img.shields.io/badge/stack-Electron%2039%20·%20React%2019%20·%20Vite%207-6d28d9)](#)
[![Local-first](https://img.shields.io/badge/local--first-gratuito-22c55e)](#)
[![Download](https://img.shields.io/badge/download-latest-6d28d9)](https://github.com/Orkestral-AI/orkestral/releases/latest)
[![Licença: FSL-1.1](https://img.shields.io/badge/licen%C3%A7a-FSL--1.1--Apache--2.0-6d28d9)](LICENSE)

🇺🇸 **[English version (principal)](README.md)**

</div>

---

## O que é o Orkestral?

Orkestral é um app desktop onde um **time de agentes de IA trabalha no seu código com contexto completo**. Em vez de colar trechos numa janela de chat, você dá seus repositórios ao Orkestral e deixa um orquestrador (o agente **CEO**) coordenar especialistas — Tech Lead, Code Reviewer, Frontend, Backend, DevOps e mais — pra transformar pedidos em **trabalho rastreável**: issues, mudanças de código, reviews e uma base de conhecimento viva.

Tudo roda **na sua máquina**. Seu código, conversas, agentes e dados ficam locais (`~/.orkestral`) — sem servidor, gratuito.

> **A ideia central:** os modelos premium _planejam_, um modelo local (**Forge**) _executa_ a $0 por tarefa, e você fica no controle. Chat, issues, git, code review e conhecimento ficam unificados num só deck operacional, pra nada se perder entre ferramentas.

---

## O que ele faz

|                               |                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 💬 **Chat com agentes**       | Fale com o agente CEO em linguagem natural. Ele lê o projeto, identifica a stack e coordena o trabalho. Use `@agente` pra acionar um especialista.                                                                                                                                                                    |
| 🧩 **Issues e épicas**        | Pedidos viram issues rastreáveis, agrupadas em épicas, com status, prioridade, responsável, vínculos pai/filho — e dedup no servidor pra não criar duplicadas.                                                                                                                                                        |
| 🤖 **Um time de agentes**     | O CEO pode propor e "contratar" um time inicial (Tech Lead + Code Reviewer + especialistas) com hierarquia de reporte correta.                                                                                                                                                                                        |
| ⚙️ **Execução local (Forge)** | Um modelo de código local aplica os patches de forma determinística — **$0 de custo de API**. Baixa sob demanda (não vem embutido) e só escala pro premium quando necessário. Aprende _como_ os devs lidam com o código — **nunca o seu código** — e auto-atualiza pras versões mais espertas treinadas centralmente. |
| 🔍 **Code reviews**           | Reviews de PR no nível sênior nos seus pull requests do GitHub, com achados estruturados e comentários inline.                                                                                                                                                                                                        |
| 🧠 **Base de conhecimento**   | Um cérebro estilo wiki por workspace: páginas, wikilinks e visão em grafo. Gerada automaticamente a partir dos repos via **busca lexical (BM25) + busca semântica local** (embeddings/RAG) — tudo no dispositivo, sem nuvem.                                                                                          |
| 🔁 **Rotinas e metas**        | Automações recorrentes e metas do workspace nas quais os agentes podem agir.                                                                                                                                                                                                                                          |
| 🔌 **MCP e integrações**      | Conecte servidores MCP (ex: ferramentas de browser via Playwright) e vários provedores de agente.                                                                                                                                                                                                                     |
| 🌎 **Multilíngue**            | UI completa em Inglês + Português do Brasil, detectada do SO. Os agentes respondem no idioma em que você escreve.                                                                                                                                                                                                     |

---

## Como funciona

### O modelo de agentes

```
            ┌─────────────────────────────────────────────┐
            │                  VOCÊ                         │
            └───────────────────┬─────────────────────────┘
                                │ linguagem natural
                                ▼
                       ┌─────────────────┐
                       │  CEO / Orquestr. │  lê o repo, planeja, delega
                       └────────┬────────┘
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                   ▼
        ┌──────────┐     ┌─────────────┐     ┌────────────┐
        │ Tech Lead│     │Code Reviewer│     │Especialistas│ Frontend,
        └────┬─────┘     └─────────────┘     └────────────┘ Backend, DevOps…
             │ coordena os especialistas
             ▼
   Issues · Mudanças de código · Reviews · Base de conhecimento
```

O CEO reporta a você; Tech Lead e Code Reviewer reportam ao CEO; especialistas reportam ao Tech Lead. Todo pedido relevante vira **issues** — o produto é trabalho rastreável, não prosa descartável.

### Premium planeja, local executa (Orkestral Forge)

O **Forge** é o modelo de código local do Orkestral (Qwen2.5-Coder via `node-llama-cpp`, GGUF) que roda 100% offline a **$0 por tarefa**. Ele **não vem embutido** no instalador — baixa sob demanda (do CDN do Orkestral) na primeira vez que o CEO propõe um agente que o usa, com um aviso de 1 clique. Até baixar, esses agentes caem num modelo premium. O pipeline minimiza custo de API sem abrir mão de correção:

```
 modelo premium ──► PLANEJA a mudança (quais arquivos, quais edições)
        │
        ▼
 Forge (local)  ──► EXECUTA: emite blocos SEARCH/REPLACE
        │
        ▼
 Morph (aplicador) ──► aplica de forma determinística (exato → fuzzy, nunca errado)
        │
        ├─ sucesso ──► pronto, custo de API $0
        └─ não aplica ──► escala pro premium (1x) como fallback
```

O **Morph** é um motor determinístico de SEARCH/REPLACE: aplica por match exato, depois normalizado por espaços, depois um passe fuzzy seguro de match único — e **rejeita** o que for ambíguo em vez de escrever o conteúdo errado. Um painel de economia mostra quantos runs foram resolvidos localmente vs. escalados.

### O Forge aprende com o tempo (treinado central, roda local)

O Forge não é congelado. Ele fica mais esperto a partir de como os devs realmente trabalham — enquanto **o seu código nunca sai da sua máquina**:

```
 sua máquina: premium PLANEJA → Forge EXECUTA → review VERIFICA
        │  (um sinal SEM código: qual abordagem venceu, o que foi corrigido)
        ▼
 nuvem Orkestral ──► treina um Forge mais esperto a partir dos sinais (GPU central)
        │
        ▼
 versão nova do Forge ──► o seu Forge local auto-atualiza pra ela
```

- **A barreira de privacidade é o ponto central:** a nuvem aprende **como você lida com o código** — quais abordagens vencem, o que é corrigido — **nunca o seu código**, que jamais sai da sua máquina. Só sobem sinais pequenos e sem código (e só enquanto você está logado no Orkestral Cloud).
- **Roda na sua máquina:** toda tarefa continua executando localmente a $0. O treino central só entrega um conjunto melhor de pesos; a inferência nunca vai pra nuvem.
- **Um modelo, trocado no lugar:** existe um único Forge atual que auto-atualiza — sem acúmulo de versões no seu disco.

> O pipeline de sinais já sai hoje; o treino central que transforma esses sinais num Forge mais esperto vem na sequência.

### Contexto unificado

Chat, issues, status/diffs do git, code reviews e a base de conhecimento vivem no mesmo workspace e se alimentam entre si. Os agentes leem tudo isso, então uma conversa pode gerar issues, uma issue pode rodar um agente, e os aprendizados são gravados de volta na KB.

---

## Stack técnica

- **Shell:** Electron 39 + [electron-vite](https://electron-vite.org)
- **UI:** React 19, React Router 7, Tailwind CSS v4, Radix UI, Framer Motion, Lucide
- **Estado/dados:** Zustand, TanStack Query
- **Banco:** better-sqlite3 + Drizzle ORM (SQLite local em `~/.orkestral`)
- **Modelos locais:** node-llama-cpp (GGUF) — **Forge** (Qwen2.5-Coder) e **embeddings** (Qwen3-Embedding) baixam sob demanda do CDN do Orkestral (nenhum peso de modelo no instalador, então ele fica pequeno); o Forge auto-atualiza pras versões treinadas centralmente
- **Editor/KB:** BlockNote, busca lexical BM25 + embeddings (snapshots `.bkf`)
- **Empacotamento:** electron-builder + electron-updater (auto-update no Windows/Linux)

---

## Começando

### Pré-requisitos

- **Node.js 20+** e npm
- Para os adapters premium: as CLIs **Claude Code** (`claude`) e/ou **Codex** (`codex`) instaladas e autenticadas. O Forge (execução local) não precisa de nada — baixa sob demanda na primeira vez que um agente o usa.

### Rodar em desenvolvimento

```bash
npm install
npm run dev
```

O modelo de embeddings baixa sob demanda na primeira vez que é usado (`setup:models` pode pré-baixar pro dev).

### Gerar os instaladores

| Comando              | Saída                                 |
| -------------------- | ------------------------------------- |
| `npm run dist:mac`   | macOS `.dmg` + `.zip` (Apple Silicon) |
| `npm run dist:win`   | Windows `.exe` (NSIS)                 |
| `npm run dist:linux` | Linux `.AppImage`                     |
| `npm run dist:all`   | os três (precisa de runners nativos)  |

O resultado vai pra `dist/`. Os instaladores **não trazem nenhum peso de modelo**, então cada um é pequeno (~150–250 MB); **o Forge e o modelo de embeddings baixam sob demanda** do CDN do Orkestral na primeira vez que são usados. O app roda offline assim que um modelo está no lugar.

As **releases** são feitas pela CI: empurrar uma tag `v*` (ou rodar o workflow **Release** manualmente) builda as três plataformas em runners nativos do GitHub e publica os instaladores numa GitHub Release. Veja [`docs/RELEASING.md`](docs/RELEASING.md).

> Os builds **ainda não são assinados** — o sistema mostra um aviso na primeira execução (Gatekeeper no macOS / SmartScreen no Windows). É seguro; só confirme a instalação. Assinatura + notarização estão no roadmap.

### Scripts úteis

| Script              | O que faz                                                   |
| ------------------- | ----------------------------------------------------------- |
| `npm run dev`       | Dev com HMR (só renderer; main/preload precisam de restart) |
| `npm run build`     | Type-check (node + web) + build de produção                 |
| `npm run typecheck` | Só TypeScript                                               |
| `npm run dist:mac`  | Gera o `.dmg` + `.zip` do macOS                             |

---

## Estrutura do projeto

```
src/
├─ main/            Processo main do Electron
│  ├─ adapters/     Provedores de agente (claude, codex, forge, gemini, cursor…)
│  ├─ db/           Schema Drizzle, migrations, repositories
│  ├─ ipc/          Handlers de IPC tipados
│  ├─ services/     chat, issues, code review, KB, smart-exec (Forge)…
│  └─ i18n.ts       Resolução de idioma no servidor
├─ preload/         Bridge segura (expõe window.orkestral)
├─ renderer/        App React
│  └─ src/
│     ├─ pages/         Issues, Inbox, Dashboard, Knowledge, Agents…
│     ├─ components/    chat, onboarding, settings, layout…
│     └─ i18n/          Traduções da UI (en / pt-BR, um arquivo por área)
└─ shared/          Tipos + o contrato de IPC tipado
```

---

## Privacidade e dados

O Orkestral é **local-first**. Tudo fica na sua máquina em `~/.orkestral` (banco SQLite, arquivos do workspace, o modelo local). Nenhuma telemetria é coletada ou enviada. Você pode exportar seus dados pra JSON ou limpá-los em **Configurações → Dados**.

---

## Roadmap

- ✅ Local-first single-user (gratuito) — chat, issues, agentes, code review, KB, execução local com Forge + embeddings locais
- ✅ Inglês + Português do Brasil, ciente do SO
- ✅ Instaladores **macOS · Windows · Linux**, releases por CI e auto-update no app (Windows/Linux)
- 🔜 **Orkestral Cloud** — plano de equipe: contas, workspaces compartilhados, sync entre dispositivos, backups gerenciados _(em andamento em [orkestral.pro](https://orkestral.pro))_
- 🔜 **Treino central do Forge** — transformar os sinais sem código em versões mais espertas do Forge numa GPU central, entregues automaticamente a cada instalação (nunca o código do dev). O pipeline de sinais sai agora; o treino vem na sequência.
- 🔜 Assinatura + notarização (remover o aviso do SO na primeira execução)
- 🔜 Recuperação de contexto mais rica, mais integrações de provedores

---

## Contribuindo

Contribuições são bem-vindas — correções, features, traduções, docs.

- Leia o **[CONTRIBUTING.md](CONTRIBUTING.md)** pro setup de dev (`npm install` → `npm run setup:models` → `npm run dev`) e o gate de qualidade antes de um PR (`npm run typecheck && npm run lint && npm run format && npm run test`).
- Achou um bug ou tem uma ideia? Abra uma [issue](https://github.com/Orkestral-AI/orkestral/issues).
- Seguimos o [Código de Conduta (Contributor Covenant)](CODE_OF_CONDUCT.md).

## Comunidade e suporte

- 🐛 **Issues** — [github.com/Orkestral-AI/orkestral/issues](https://github.com/Orkestral-AI/orkestral/issues)
- 🌐 **Site** — [orkestral.pro](https://orkestral.pro)
- 🔒 **Segurança** — reporte vulnerabilidades **em privado** (veja [SECURITY.md](SECURITY.md)).

## Licença

O Orkestral é distribuído sob a **[Functional Source License — FSL-1.1-Apache-2.0](LICENSE)**: livre pra usar, modificar e auto-hospedar, com uma restrição — você **não** pode usar pra fazer um produto ou serviço comercial concorrente. Dois anos após cada release, aquela versão vira **Apache 2.0** automaticamente. Veja o [LICENSE](LICENSE) pros termos completos.

---

<div align="center">

🇺🇸 [Read in English](README.md)

</div>
