# Releasing — instaláveis multiplataforma (mac / win / linux)

O Orkestral é empacotado com **electron-builder** e publicado em **GitHub Releases**.
Cada plataforma é buildada no seu runner **nativo** (electron-builder não faz
cross-compile confiável de módulos nativos como o `better-sqlite3`).

## Como cortar um release (caminho recomendado: CI)

1. Garanta que o gate está verde localmente:
   ```bash
   npm run typecheck && npm test && npm run lint
   ```
2. Suba a versão (gera o commit + a tag `vX.Y.Z`):
   ```bash
   npm version patch   # ou: minor / major
   git push --follow-tags
   ```
3. O workflow **`.github/workflows/release.yml`** dispara na tag `v*`, builda nas
   3 plataformas e publica os instaláveis numa **Release (draft)** com a tag.
4. Abra a Release no GitHub, confira os artefatos e clique em **Publish**.

> Também dá pra rodar manualmente: Actions → **Release** → _Run workflow_.
> Marque **dry_run** pra buildar nas 3 plataformas SEM publicar — os instaláveis
> saem como _artifacts_ do Actions pra você baixar e testar antes de cortar a tag.

### O que sai em cada plataforma

| Plataforma | Artefatos                                                               |
| ---------- | ----------------------------------------------------------------------- |
| macOS      | `Orkestral-X.Y.Z-arm64.dmg` + `-x64.dmg` (e `.zip` p/ auto-update)      |
| Windows    | `Orkestral-X.Y.Z-x64.exe` (instalador NSIS)                             |
| Linux      | `Orkestral-X.Y.Z-x86_64.AppImage` (universal — roda em qualquer distro) |

## Build local (uma plataforma)

```bash
npm run dist:mac      # .dmg/.zip (precisa de macOS)
npm run dist:win      # .exe NSIS (precisa de Windows)
npm run dist:linux    # .AppImage/.deb (precisa de Linux)
npm run dist:dir      # só descompacta (sem instalador) — pra testar rápido
```

Saída em `dist/`. Esses scripts usam `--publish never` (não sobem nada).

## Pontos de atenção

- **Tamanho — nenhum GGUF vai no instalável.** Os modelos locais (embeddings,
  fast-apply) baixam sob demanda no primeiro uso; o `electron-builder` exclui os
  `.gguf` de `resources/` (ver `extraResources.filter` no `package.json`).

- **Assinatura / notarização — hoje os builds NÃO são assinados.** Eles instalam,
  mas o SO avisa (macOS Gatekeeper: "app de desenvolvedor não identificado";
  Windows SmartScreen). Pra produção sem aviso, adicione os secrets ao repo:
  - **macOS**: `CSC_LINK` (cert .p12 base64), `CSC_KEY_PASSWORD`, e p/ notarizar
    `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
  - **Windows**: `CSC_LINK` + `CSC_KEY_PASSWORD` (cert de code-signing).
    O `CSC_IDENTITY_AUTO_DISCOVERY: false` no workflow só evita o CI falhar enquanto
    não há cert — remova quando configurar a assinatura no macOS.

- **Auto-update** já está pré-cabeado pelo `publish: github` no `package.json`
  (provider `github`, `Orkestral-AI/orkestral`). Os `.dmg`/`.zip`/`nsis`/`AppImage`
  gerados são compatíveis com `electron-updater` quando você quiser ligar updates.

- **`GITHUB_TOKEN`** do próprio Actions já basta pra publicar a Release (o workflow
  pede `permissions: contents: write`). Não precisa de PAT.
