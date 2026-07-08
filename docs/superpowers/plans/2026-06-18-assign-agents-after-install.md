# Modal "Atribuir a agentes" pós-install — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Após instalar uma Skill ou MCP pela marketplace, abrir um modal com cards de agente (avatar + nome) onde o usuário liga/desliga o item em cada agente, com botão "marcar/desmarcar todos" e tudo marcado por padrão.

**Architecture:** Componente React novo `AssignAgentsDialog` aberto no `onSuccess` do install (em `ItemDetailDialog` e no quick-install do `MarketplaceBrowser`). Skill (instruction) liga por agente via `skill:attach`; MCP liga por model-scope via `marketplace:set-model-scopes`, traduzindo agentes selecionados → união de scopes (agentes do mesmo modelo se movem juntos). Remove o auto-attach-all de instruction no install do backend.

**Tech Stack:** Electron + React + TanStack Query + IPC tipado (`window.orkestral[...]`), i18n via `useT()`, Tailwind/shadcn, DiceBear (`AgentAvatar`).

**Validação (sem test runner pra UI):** gate é `npm run typecheck` + `npm run lint`. Sem TDD/test novo (segue o padrão do projeto). Verificação funcional = rodar o app e instalar um item.

---

## File Structure

- **Create:** `src/renderer/src/components/marketplace/AssignAgentsDialog.tsx` — o modal; recebe o skill instalado + workspaceId, mostra cards de agente, salva atribuição.
- **Modify:** `src/renderer/src/components/marketplace/ItemDetailDialog.tsx` — abrir o modal no sucesso do install.
- **Modify:** `src/renderer/src/components/marketplace/MarketplaceBrowser.tsx` — abrir o modal no sucesso do quick-install.
- **Modify:** `src/main/ipc/handlers/skills-issues.ts` — remover o loop de auto-attach-all em instruction.
- **Modify:** `src/renderer/src/i18n/locales/pt-BR/pages.json` e `src/renderer/src/i18n/locales/en/pages.json` — novas strings em `marketplace`.

Endpoints/types reusados (já existem, NÃO criar): `agent:list`, `skill:attach`, `skill:detach`, `marketplace:set-model-scopes`. Helpers reusados: `scopeFor`, `AgentAvatar`.

---

## Task 1: Strings i18n do modal

**Files:**

- Modify: `src/renderer/src/i18n/locales/pt-BR/pages.json` (objeto `marketplace`, perto da linha 565)
- Modify: `src/renderer/src/i18n/locales/en/pages.json` (objeto `marketplace`, perto da linha 565)

- [ ] **Step 1: Adicionar chaves no pt-BR**

No objeto `"marketplace": { ... }` do arquivo `pt-BR/pages.json`, adicionar (cuidar pra não deixar vírgula faltando antes/depois):

```json
"assignTitle": "Atribuir {name} aos agentes",
"assignSubtitleSkill": "Escolha quais agentes vão usar esta skill.",
"assignSubtitleMcp": "Escolha quais agentes vão usar este MCP. Agentes que rodam o mesmo modelo ligam juntos.",
"assignSelectAll": "Marcar todos",
"assignDeselectAll": "Desmarcar todos",
"assignCounter": "{selected} de {total} selecionados",
"assignSiblingNote": "Agentes do mesmo modelo são ligados juntos automaticamente.",
"assignSave": "Salvar",
"assignSkip": "Pular",
"assignEmpty": "Nenhum agente neste workspace ainda.",
"assignSavedToast": "Atribuição salva",
"assignSaveFailTitle": "Falha ao salvar atribuição"
```

- [ ] **Step 2: Adicionar as mesmas chaves no en**

No objeto `"marketplace": { ... }` do arquivo `en/pages.json`:

```json
"assignTitle": "Assign {name} to agents",
"assignSubtitleSkill": "Choose which agents will use this skill.",
"assignSubtitleMcp": "Choose which agents will use this MCP. Agents running the same model turn on together.",
"assignSelectAll": "Select all",
"assignDeselectAll": "Deselect all",
"assignCounter": "{selected} of {total} selected",
"assignSiblingNote": "Agents on the same model are linked and toggle together.",
"assignSave": "Save",
"assignSkip": "Skip",
"assignEmpty": "No agents in this workspace yet.",
"assignSavedToast": "Assignment saved",
"assignSaveFailTitle": "Failed to save assignment"
```

- [ ] **Step 3: Validar JSON**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && node -e "JSON.parse(require('fs').readFileSync('src/renderer/src/i18n/locales/pt-BR/pages.json','utf8'));JSON.parse(require('fs').readFileSync('src/renderer/src/i18n/locales/en/pages.json','utf8'));console.log('ok')"`
Expected: imprime `ok` (sem erro de parse → vírgulas corretas).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/i18n/locales/pt-BR/pages.json src/renderer/src/i18n/locales/en/pages.json
git commit -m "i18n(marketplace): strings do modal de atribuição a agentes"
```

---

## Task 2: Componente AssignAgentsDialog

**Files:**

- Create: `src/renderer/src/components/marketplace/AssignAgentsDialog.tsx`

- [ ] **Step 1: Criar o componente**

Cole o arquivo inteiro. Notas de design embutidas no código:

- `selected` inicia com TODOS os agentes (decisão A).
- MCP: ao togglear um agente, todos os irmãos (mesmo `scopeFor`) acompanham.
- Skill instruction (item recém-instalado, nada atachado ainda): salva = `skill:attach` em cada selecionado.
- MCP: salva = `marketplace:set-model-scopes` com `['*']` se todos selecionados, senão união dos scopes dos selecionados.
- Cores: `primary` pra selecionado, `outline/muted` pro resto. Sem `secondary`/ciano.

```tsx
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Agent, Skill } from '@shared/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog';
import { Button } from '@renderer/components/ui/button';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { scopeFor, scopeLabel } from './shared';
import { toast } from '@renderer/stores/toastStore';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';

interface AssignAgentsDialogProps {
  /** Skill recém-instalada (kind decide skill vs mcp). Null = fechado. */
  skill: Skill | null;
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}

export function AssignAgentsDialog({ skill, workspaceId, open, onClose }: AssignAgentsDialogProps) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const isMcp = skill?.kind === 'mcp';

  const agentsQuery = useQuery({
    queryKey: ['agents', workspaceId],
    queryFn: () => window.orkestral['agent:list']({ workspaceId }),
    enabled: open,
  });
  const agents = agentsQuery.data ?? [];

  // Default: todos marcados. Re-sincroniza quando a lista chega / o modal reabre.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allIdsKey = agents.map((a) => a.id).join(',');
  useEffect(() => {
    if (open) setSelected(new Set(allIdsKey ? allIdsKey.split(',') : []));
  }, [open, allIdsKey]);

  /** Irmãos de MCP: agentes com o mesmo scope adapterType:model. */
  function siblingsOf(agent: Agent): Agent[] {
    if (!isMcp || !agent.adapterType) return [agent];
    const scope = scopeFor(agent.adapterType, agent.model ?? null);
    return agents.filter(
      (a) => a.adapterType && scopeFor(a.adapterType, a.model ?? null) === scope,
    );
  }

  function toggle(agent: Agent): void {
    const next = new Set(selected);
    const group = siblingsOf(agent);
    const turningOn = !next.has(agent.id);
    for (const g of group) {
      if (turningOn) next.add(g.id);
      else next.delete(g.id);
    }
    setSelected(next);
  }

  const allSelected = agents.length > 0 && selected.size === agents.length;
  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(agents.map((a) => a.id)));
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!skill) return;
      const chosen = agents.filter((a) => selected.has(a.id));
      if (isMcp) {
        // Todos marcados → '*' (todos os modelos). Senão união dos scopes.
        let modelScopes: string[];
        if (chosen.length === agents.length) {
          modelScopes = ['*'];
        } else {
          modelScopes = Array.from(
            new Set(
              chosen
                .filter((a) => a.adapterType)
                .map((a) => scopeFor(a.adapterType!, a.model ?? null)),
            ),
          );
        }
        await window.orkestral['marketplace:set-model-scopes']({ skillId: skill.id, modelScopes });
      } else {
        // Instruction recém-instalada: nada atachado ainda → attach dos escolhidos.
        for (const a of chosen) {
          await window.orkestral['skill:attach']({ agentId: a.id, skillId: skill.id });
        }
      }
    },
    onSuccess: () => {
      toast.success(t('pages.marketplace.assignSavedToast'));
      queryClient.invalidateQueries({ queryKey: ['skills', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      for (const a of agents)
        queryClient.invalidateQueries({ queryKey: ['skills-by-agent', a.id] });
      onClose();
    },
    onError: (e) =>
      toast.error(
        t('pages.marketplace.assignSaveFailTitle'),
        e instanceof Error ? e.message : undefined,
      ),
  });

  if (!skill) return null;

  const subtitle = isMcp
    ? t('pages.marketplace.assignSubtitleMcp')
    : t('pages.marketplace.assignSubtitleSkill');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('pages.marketplace.assignTitle', { name: skill.name })}</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-text-muted">{subtitle}</p>

        {agents.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">
            {t('pages.marketplace.assignEmpty')}
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-muted">
                {t('pages.marketplace.assignCounter', {
                  selected: selected.size,
                  total: agents.length,
                })}
              </span>
              <Button variant="outline" size="sm" onClick={toggleAll}>
                {allSelected
                  ? t('pages.marketplace.assignDeselectAll')
                  : t('pages.marketplace.assignSelectAll')}
              </Button>
            </div>

            <div
              className="grid max-h-[50vh] gap-2 overflow-y-auto"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
            >
              {agents.map((agent) => {
                const on = selected.has(agent.id);
                return (
                  <div
                    key={agent.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggle(agent)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggle(agent);
                      }
                    }}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border p-3 transition-colors',
                      {
                        'border-primary bg-primary/10 ring-1 ring-primary/40': on,
                        'border-hairline bg-surface-1 hover:bg-surface-2': !on,
                      },
                    )}
                  >
                    <AgentAvatar
                      seed={agent.avatarSeed}
                      name={agent.name}
                      size={36}
                      rounded="full"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{agent.name}</div>
                      <div className="truncate text-xs text-text-muted">
                        {agent.title || agent.role}
                        {agent.adapterType
                          ? ` · ${scopeLabel(scopeFor(agent.adapterType, agent.model ?? null), t)}`
                          : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {isMcp && (
              <p className="text-xs text-text-muted">{t('pages.marketplace.assignSiblingNote')}</p>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={saveMut.isPending}>
            {t('pages.marketplace.assignSkip')}
          </Button>
          <Button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || agents.length === 0}
          >
            {t('pages.marketplace.assignSave')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Confirmar imports/símbolos**

Verifique que estes existem (grep rápido); se algum path divergir, ajuste o import:
Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && ls src/renderer/src/components/ui/dialog.tsx src/renderer/src/components/ui/button.tsx src/renderer/src/components/agents/AgentAvatar.tsx && grep -n "export const toast\|export { toast\|export function" src/renderer/src/stores/toastStore.ts | head`
Expected: os 3 arquivos existem e `toast` é exportado. (Se `Button`/`Dialog` tiverem outro caminho, corrigir o import no Step 1.)

- [ ] **Step 3: Typecheck**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && npm run typecheck:web`
Expected: PASS (0 erros). Se acusar campo inexistente em `Agent` (ex: `avatarSeed`, `title`, `role`, `adapterType`, `model`), checar o tipo `Agent` em `src/shared/types` e ajustar acesso.

- [ ] **Step 4: Lint dos arquivos tocados**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && npx eslint src/renderer/src/components/marketplace/AssignAgentsDialog.tsx`
Expected: 0 erros (warnings ok). Sem `any`, sem `eslint-disable` de regra de tipo.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/marketplace/AssignAgentsDialog.tsx
git commit -m "feat(marketplace): modal AssignAgentsDialog (cards de agente, marcar/desmarcar todos)"
```

---

## Task 3: Abrir o modal no ItemDetailDialog

**Files:**

- Modify: `src/renderer/src/components/marketplace/ItemDetailDialog.tsx`

- [ ] **Step 1: Importar o modal**

No topo (junto dos outros imports de `./`), adicionar:

```tsx
import { AssignAgentsDialog } from './AssignAgentsDialog';
```

- [ ] **Step 2: Estado pra guardar o skill instalado**

Dentro do componente interno (onde estão os `useState` de `envValues`/`scopes`, ~linha 101), adicionar:

```tsx
const [assignSkill, setAssignSkill] = useState<Skill | null>(null);
```

- [ ] **Step 3: Abrir o modal no sucesso do install**

Substituir o `onSuccess` do `installMut` (linhas ~125-134) por:

```tsx
    onSuccess: (created) => {
      toast.success(
        t('pages.marketplace.installedToastTitle', { name: item.name }),
        isMcp
          ? t('pages.marketplace.installedDialogDesc')
          : t('pages.marketplace.installedSkillDesc'),
      );
      onChanged();
      setAssignSkill(created); // abre o modal de atribuição; não fecha o detalhe ainda
    },
```

- [ ] **Step 4: Renderizar o modal**

Logo antes do último fechamento do JSX do componente interno (antes do `</Dialog>`/`</>` final do return), adicionar:

```tsx
<AssignAgentsDialog
  skill={assignSkill}
  workspaceId={workspaceId}
  open={assignSkill !== null}
  onClose={() => {
    setAssignSkill(null);
    onClose(); // só fecha o detalhe depois que o usuário resolve a atribuição
  }}
/>
```

Nota: `workspaceId` já está disponível nas props do componente interno (usado no `installMut`).

- [ ] **Step 5: Typecheck**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && npm run typecheck:web`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && npx eslint src/renderer/src/components/marketplace/ItemDetailDialog.tsx`
Expected: 0 erros.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/marketplace/ItemDetailDialog.tsx
git commit -m "feat(marketplace): abrir modal de atribuicao apos install no ItemDetailDialog"
```

---

## Task 4: Abrir o modal no quick-install do MarketplaceBrowser

**Files:**

- Modify: `src/renderer/src/components/marketplace/MarketplaceBrowser.tsx`

- [ ] **Step 1: Importar o modal**

Junto do `import { ItemDetailDialog } from './ItemDetailDialog';` (linha ~14):

```tsx
import { AssignAgentsDialog } from './AssignAgentsDialog';
```

- [ ] **Step 2: Estado do skill a atribuir**

Junto dos outros `useState` (perto da linha 30, ao lado de `installingId`):

```tsx
const [assignSkill, setAssignSkill] = useState<Skill | null>(null);
```

Garantir que `Skill` está importado de `@shared/types` no topo; se não estiver, adicionar ao import existente de tipos.

- [ ] **Step 3: Capturar o skill criado no sucesso do quick-install**

No `quickInstall` mutation, trocar o `onSuccess` (linhas ~136-144) por (note o 1º arg `created` que é o Skill retornado):

```tsx
    onSuccess: (created, item) => {
      toast.success(
        t('pages.marketplace.installedToastTitle', { name: item.name }),
        item.kind === 'mcp'
          ? t('pages.marketplace.installedMcpDesc')
          : t('pages.marketplace.installedSkillDesc'),
      );
      refetch();
      setAssignSkill(created);
    },
```

- [ ] **Step 4: Renderizar o modal**

Logo após o `<ItemDetailDialog ... />` (perto da linha 273-281), adicionar:

```tsx
<AssignAgentsDialog
  skill={assignSkill}
  workspaceId={workspaceId}
  open={assignSkill !== null}
  onClose={() => setAssignSkill(null)}
/>
```

- [ ] **Step 5: Typecheck**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && npm run typecheck:web`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && npx eslint src/renderer/src/components/marketplace/MarketplaceBrowser.tsx`
Expected: 0 erros.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/marketplace/MarketplaceBrowser.tsx
git commit -m "feat(marketplace): abrir modal de atribuicao apos quick-install"
```

---

## Task 5: Remover auto-attach-all de instruction no install

**Files:**

- Modify: `src/main/ipc/handlers/skills-issues.ts` (~linha 561-567)

- [ ] **Step 1: Remover o loop de auto-attach**

Localizar este bloco (dentro do handler `marketplace:install`, ~linha 561):

```ts
// Skills de INSTRUÇÃO (texto que entra no prompt) só têm efeito se atachadas
// a um agente — auto-atacha a todos do workspace na instalação. MCPs entram
// via modelScope no buildMcpConfigForRun, não precisam de attach.
if (item.install.skillKind === 'instruction') {
  for (const a of agentRepo.listByWorkspace(workspaceId)) skillRepo.attach(a.id, created.id);
}
```

Substituir por (mantém comentário explicando que a atribuição agora é via modal):

```ts
// Skills de INSTRUÇÃO só têm efeito se atachadas a um agente. A atribuição
// agora é feita pelo AssignAgentsDialog logo após o install (default: todos
// os agentes marcados), então NÃO auto-atacha aqui — evita ligar em agente
// que o usuário desmarcaria. MCPs entram via modelScope, sem attach.
```

- [ ] **Step 2: Conferir que `agentRepo` ainda é usado em outro lugar (senão vira import morto)**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && grep -n "agentRepo" src/main/ipc/handlers/skills-issues.ts`
Expected: ao menos 1 outra ocorrência (uso/declaração). Se a ÚNICA ocorrência restante for a linha de import/obtenção do repo, remover também essa linha pra não quebrar o lint de unused.

- [ ] **Step 3: Typecheck do node**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && npm run typecheck:node`
Expected: PASS.

- [ ] **Step 4: Lint**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && npx eslint src/main/ipc/handlers/skills-issues.ts`
Expected: 0 erros (sem variável não usada).

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/handlers/skills-issues.ts
git commit -m "refactor(marketplace): atribuicao de skill via modal, remove auto-attach-all no install"
```

---

## Task 6: Verificação final (typecheck + lint + app)

**Files:** nenhum (só validação)

- [ ] **Step 1: Typecheck completo**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && npm run typecheck`
Expected: PASS (node + web).

- [ ] **Step 2: Lint completo**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && npm run lint`
Expected: 0 erros.

- [ ] **Step 3: Verificação funcional manual (rodar o app)**

Run: `cd /Users/luccas/Documents/Github/OrkestralAI/orkestral && npm run dev`
Conferir manualmente:

1. Instalar uma **Skill** (instruction) pela marketplace → modal abre com TODOS os agentes marcados. Desmarcar 1, Salvar → toast "Atribuição salva". Abrir um agente desmarcado → skill NÃO está atachada; agente marcado → está.
2. Instalar um **MCP** → modal abre. Conferir aviso "mesmo modelo ligam juntos". Desmarcar 1 agente cujo modelo é compartilhado → o irmão desmarca junto. Salvar.
3. Botão "Marcar/Desmarcar todos" alterna corretamente; contador atualiza.
4. "Pular" fecha sem mudar atribuição.

Expected: os 4 cenários conferem. Se algo falhar, debugar antes de seguir.

- [ ] **Step 4: Atualizar memória do projeto (opcional)**

Se a verificação passar, o fluxo de install agora sempre passa pelo modal — anotar como decisão de projeto se for relevante pra sessões futuras.

```

```

---

## Self-Review (já aplicado)

- **Cobertura do spec:** gatilho pós-install (T3/T4), default todos marcados (T2 Step 1), marcar/desmarcar todos (T2), MCP irmãos arrastam junto (T2 `siblingsOf`/`toggle`), skill por-agente (T2 save), remover auto-attach-all (T5), i18n sem hardcode (T1), cores sem `secondary` (T2). Tudo coberto.
- **Placeholders:** nenhum — todo passo tem código/comando real.
- **Consistência de tipos:** `scopeFor(adapterType, model)` usado igual em `siblingsOf` e no save; `set-model-scopes` e `skill:attach` batem com `ipc-contract.ts`; `AgentAvatar` props (`seed`/`name`/`size`/`rounded`) batem com o componente real.
