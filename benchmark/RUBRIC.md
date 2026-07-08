# Rubrica de avaliação (cega)

> Aplique a cada output **sem saber qual braço o produziu**. Renomeie as pastas
> para `output-X` / `output-Y` antes de julgar. Some os pontos (0–100).

## Gate de funcionalidade (objetivo, faça você mesmo)

Estes são medidos rodando o app, não opinando. Registre sim/não + evidência.

- [ ] **G1. Instala** (`install` roda sem erro fatal) — pré-requisito
- [ ] **G2. Builda / typecheck** passa
- [ ] **G3. App abre** sem crash
- [ ] **G4. Criar conta a pagar** funciona e persiste
- [ ] **G5. Criar conta a receber** funciona e persiste
- [ ] **G6. Marcar como paga/recebida** funciona
- [ ] **G7. Filtro por status/período** funciona
- [ ] **G8. Painel de saldo** (a pagar / a receber / líquido) calcula certo
- [ ] **G9. Dados sobrevivem a reload** (persistência real, não estado em memória)

**MVP rodável = G1–G3 + pelo menos G4, G5, G6 e G9.** Marque o run como
"MVP rodável: sim/não". Esta é a métrica mais importante.

## Score de qualidade (0–100)

| Critério                     | Peso | O que avaliar                                                                                              |
| ---------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| **Completude vs spec**       | 30   | Quantos dos 5 requisitos funcionais estão realmente entregues e funcionando                                |
| **Funciona de verdade**      | 25   | O fluxo core roda ponta-a-ponta sem quebrar; quantos gates G4–G9 passam                                    |
| **Coerência de arquitetura** | 15   | Estrutura de pastas, separação de responsabilidades, código que um dev manteria                            |
| **Qualidade de UI**          | 15   | Usável, clara, sem telas quebradas; adequada a um app financeiro (não "dashboard genérico bonito e vazio") |
| **Acabou no budget**         | 10   | Chegou a um MVP dentro de uma sessão, sem estourar/abandonar no meio                                       |
| **Instruções de run**        | 5    | README claro; dá pra rodar seguindo o que foi escrito                                                      |

> Penalize código que **parece** pronto mas não roda (casca bonita > MVP funcional é
> o anti-padrão que estamos caçando). "Premium e moderno" sem o fluxo funcionando = nota baixa em "Funciona de verdade".

## Registro

Para cada run, anote: gates passados, score por critério, total, e 2–3 linhas de
justificativa honesta. Use `RESULTS.template.md`.
