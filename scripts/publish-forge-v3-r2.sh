#!/usr/bin/env bash
#
# Publica o Orkestral Forge v3 (Qwen2.5-Coder-7B-Instruct GGUF) no Cloudflare R2.
#
# Sobe o objeto em `forge/v3/forge.gguf` — EXATAMENTE a key que o app baixa
# (FORGE_VARIANTS[v3].url = ${FORGE_R2_PUB}/forge/v3/forge.gguf em
# model-download-service.ts). O app valida por TAMANHO; quando você colar o sha256
# impresso no fim aqui dentro do catálogo (v3.sha256), passa a validar o hash também.
#
# Pré-requisitos:
#   - wrangler autenticado:  npx wrangler login   (NÃO exponha token em texto)
#   - o bucket R2 do Forge já criado (mesmo de v1/v2)
#
# Uso:
#   R2_BUCKET=orkestral-forge ./scripts/publish-forge-v3-r2.sh
#
set -euo pipefail

R2_BUCKET="${R2_BUCKET:?defina R2_BUCKET (nome do bucket R2, ex.: orkestral-forge)}"

HF_URL="https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf"
KEY="forge/v3/forge.gguf" # casa FORGE_VARIANTS[v3].url (Public Dev URL: forge/v3/forge.gguf)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
GGUF="$WORK/forge.gguf"

echo "→ baixando o Qwen2.5-Coder-7B-Instruct Q4_K_M do HuggingFace (~4.7 GB)…"
curl -fL --retry 5 --retry-delay 3 -o "$GGUF" "$HF_URL"

SIZE=$(stat -f%z "$GGUF" 2>/dev/null || stat -c%s "$GGUF")
SHA=$(shasum -a 256 "$GGUF" | awk '{print $1}')
echo "→ size=${SIZE} sha256=${SHA}"
# Sanidade: o catálogo espera 4683073536 bytes.
if [ "$SIZE" != "4683073536" ]; then
  echo "⚠ tamanho ${SIZE} ≠ 4683073536 esperado — confira o arquivo do HF antes de subir." >&2
fi

echo "→ subindo ${KEY} pro bucket ${R2_BUCKET}…"
npx wrangler r2 object put "${R2_BUCKET}/${KEY}" \
  --file "$GGUF" --content-type application/octet-stream

echo
echo "✓ publicado em ${R2_BUCKET}/${KEY}"
echo "  App baixa de: <Public Dev URL>/${KEY}"
echo
echo "→ AGORA cole este sha256 no FORGE_VARIANTS v3 (src/main/services/model-download-service.ts):"
echo "    sha256: '${SHA}',"
echo "  (hoje está vazio — valida só tamanho; com o hash, valida anti-corrupção também)"
