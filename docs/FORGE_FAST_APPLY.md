# Orkestral Forge — Fast-Apply (merge sem âncora)

> Como o Forge aplica edits e o caminho pra um **fast-apply próprio** (sem Morph LLM pago),
> reaproveitando o que dá do [`kortix-ai/fast-apply`](https://github.com/kortix-ai/fast-apply)
> (Apache-2.0) e os guards do [`JRedeker/opencode-morph-fast-apply`](https://github.com/JRedeker/opencode-morph-fast-apply) (MIT).

## O problema

O caminho primário aplica um **lazy-edit** (trechos + `// ... existing code ...`) casando
**âncoras** no arquivo (`morph.ts`). Quando o modelo pequeno varia um detalhe que NÃO muda a
identidade da linha — `import { create }` vs `import create`, aspas `'`/`"` — a âncora não
casava e a issue **escalava pro premium** (ou estourava o timeout mandando o arquivo inteiro).

## O que já entrou (código)

1. **Âncora tolerante** (`morph.ts` → `normAnchorLoose` + tier único em `anchorPositions`):
   neutraliza chaves de destructuring e aspas; casa SÓ quando há **uma** linha (nunca adivinha).
   O merge preserva a **linha real** do arquivo (`safeSeg[aStart]=origLines[best.start]`), então
   localizar com tolerância não corrompe o import — só o miolo muda.
2. **Região-primeiro pra arquivo grande** (`orchestrator.ts` → `REGION_FIRST_CHARS=45k`): arquivo
   grande pula os tiers de arquivo-inteiro (que estouram os 180s) e vai direto pro tier de
   **região** (manda só a função relevante: prompt pequeno, rápido, local).
3. **Tier FAST-APPLY** (estilo kortix, `local-patcher.ts` → `generateLocalFastApply` +
   `FAST_APPLY_SYSTEM`): quando temos um lazy-edit válido mas a âncora não casou, o modelo
   **mescla** o `<update>` no `<code>` e devolve o arquivo inteiro em `<updated-code>` — **sem
   âncora pra errar**. Só pra arquivo **pequeno** (`FAST_APPLY_MAX_CHARS=12k`: a saída precisa
   caber em `maxOutputTokens`). Guards: anti-encolhimento + **perda de imports**
   (`droppedTopLevelImports`, do guard MIT do JRedeker) → nunca grava deleção/import-drop silencioso.

Formato (idêntico ao dataset de fast-apply, pra um Forge fine-tunado ficar ótimo nisso):

```
<code>{arquivo original}</code>
<update>{lazy-edit que o modelo gerou}</update>
→ <updated-code>{arquivo inteiro mesclado}</updated-code>
```

## Próximo passo — fine-tunar o Forge em fast-apply ("o seu morph")

O Forge é **Qwen2.5-Coder** (v1=1.5B, v2=3B, v3=7B) — **o mesmo base** do `kortix-ai/fast-apply`.
E o runtime já carrega **LoRA** (`llama-runtime.ts` → `loraPath`). Então dá pra ter um adapter
de fast-apply próprio, local e grátis:

1. **Dataset**: [`Kortix/FastApply-dataset-v1.0`](https://huggingface.co/datasets/Kortix/FastApply-dataset-v1.0)
   (Apache-2.0, ~5.600 pares `original-code` / `update-snippet` / `final-updated-code`,
   80% TS/TSX + 15% Python). Misturar com pares gerados dos **repos do usuário** (PHP/Laravel +
   Next/TSX) pra cobrir o domínio real — usar o mesmo gerador (clonar repo → diff → snippet).
2. **Formato de treino**: o `FAST_APPLY_SYSTEM` + `<code>/<update>/<updated-code>` deste repo
   (mesmo template do dataset). O `<update>` usa os markers `// ... existing code ...` — alinhado
   com o lazy-edit que o Forge já produz.
3. **Treino**: QLoRA 4-bit (unsloth `Qwen2.5-Coder-*-Instruct-bnb-4bit`), rank 16–32 / alpha 16,
   como o kortix. Reaproveitar o pipeline em `docs/Orkestral_Forge_Fine_Tuning_Architecture.*`.
4. **Publicar**: GGUF/LoRA no R2 (bucket `orkestral-forge`, como as variantes), e carregar via
   `loraPath` SÓ no tier de fast-apply (não muda o modelo base das outras tarefas).
5. **Escopo**: merge-cheio escala em arquivo **pequeno/médio** (a saída precisa caber no contexto
   de saída do modelo pequeno). Pra arquivo **grande**, seguir com **região-primeiro** — a saída
   de arquivo inteiro num modelo pequeno dropa código.

## Por que NÃO usar o `opencode-morph-fast-apply` direto

É um **cliente fino da API paga** do Morph (`api.morphllm.com`) — a inteligência de merge é
proprietária deles, não vem no repo. Daqui só reaproveitamos os **guards determinísticos** (MIT),
em especial a **detecção de perda de imports**, já portada (`droppedTopLevelImports`).
