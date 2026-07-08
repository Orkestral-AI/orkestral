# Prompt do juiz cego

> Use com um agente/sessão limpa que NÃO sabe qual output é de qual braço.
> Preparação (ver README, seção Julgamento): copie APENAS os dois `workspace/`
> para `output-X`/`output-Y` (ordem sorteada), sem `summary.json`/`output.jsonl`,
> e remova o `CLAUDE.md` semeado pelo harness se não foi modificado pelo run.
> Passe a rubrica junto.

---

Você é um avaliador técnico imparcial. Recebeu dois apps (`output-X` e `output-Y`)
gerados a partir do MESMO prompt (`PROMPT.md`). Você NÃO sabe como cada um foi gerado
e não deve especular.

Para CADA output, faça o seguinte de forma objetiva, rodando o app quando possível:

1. Tente instalar, buildar e abrir. Registre os gates G1–G9 da `RUBRIC.md` (sim/não + evidência).
2. Determine se é um **MVP rodável** (G1–G3 + G4, G5, G6, G9).
3. Pontue 0–100 pelos critérios e pesos da `RUBRIC.md`.
4. Penalize "casca bonita que não roda": UI premium sem o fluxo financeiro funcionando = nota baixa em "Funciona de verdade".

Entregue, para cada output: tabela de gates, score por critério, total, e 3 linhas de
justificativa honesta. No fim, diga qual é melhor e por quê — **sem suavizar**. Se os
dois forem ruins, diga que os dois são ruins.
