#!/usr/bin/env bash
#
# Publica o modelo FAST-APPLY (o "morph" próprio) no Cloudflare R2.
#
# Modelo: kortix-ai/fast-apply (Apache-2.0) — Qwen2.5-Coder-1.5B fine-tunado SÓ pra
# MESCLAR um edit no arquivo. GGUF Q4_K_M (~986 MB) quantizado pelo bartowski.
#
# Sobe o objeto em `fast-apply/fast-apply.gguf` — EXATAMENTE a key que o app baixa
# (MODELS['fast-apply'].url = ${FORGE_R2_PUB}/fast-apply/fast-apply.gguf em
# model-download-service.ts). Sem isto, o app já auto-instala pelo HuggingFace de
# fallback; o R2 é só pra hospedar você mesmo (mais rápido/estável, sem 429).
#
# O app valida por TAMANHO; ao colar o sha256 impresso no fim aqui no catálogo
# (MODELS['fast-apply'].sha256), passa a validar o hash também (anti-corrupção).
#
# Pré-requisitos:
#   - wrangler autenticado:  npx wrangler login   (NÃO exponha token em texto)
#   - o bucket R2 do Forge já criado (mesmo de v1/v2/v3)
#
# Uso:
#   R2_BUCKET=orkestral-forge ./scripts/publish-fast-apply-r2.sh
#
set -euo pipefail

R2_BUCKET="${R2_BUCKET:?defina R2_BUCKET (nome do bucket R2, ex.: orkestral-forge)}"

HF_URL="https://huggingface.co/bartowski/FastApply-1.5B-v1.0-GGUF/resolve/main/FastApply-1.5B-v1.0-Q4_K_M.gguf"
KEY="fast-apply/fast-apply.gguf" # casa MODELS['fast-apply'].url

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
GGUF="$WORK/fast-apply.gguf"

echo "→ baixando o FastApply-1.5B-v1.0 Q4_K_M do HuggingFace (~986 MB)…"
curl -fL --retry 5 --retry-delay 3 -o "$GGUF" "$HF_URL"

SIZE=$(stat -f%z "$GGUF" 2>/dev/null || stat -c%s "$GGUF")
SHA=$(shasum -a 256 "$GGUF" | awk '{print $1}')
echo "→ size=${SIZE} sha256=${SHA}"
# Sanidade: o catálogo espera 986047072 bytes.
if [ "$SIZE" != "986047072" ]; then
  echo "⚠ tamanho ${SIZE} ≠ 986047072 esperado — confira o arquivo do HF antes de subir." >&2
fi

echo "→ subindo ${KEY} pro bucket ${R2_BUCKET}…"
npx wrangler r2 object put "${R2_BUCKET}/${KEY}" \
  --file "$GGUF" --content-type application/octet-stream

echo
echo "✓ publicado em ${R2_BUCKET}/${KEY}"
echo "  App baixa de: <Public Dev URL>/${KEY}"
echo
echo "→ AGORA cole este sha256 no MODELS['fast-apply'] (src/main/services/model-download-service.ts):"
echo "    sha256: '${SHA}',"
echo "  (hoje sem sha256 — valida só tamanho; com o hash, valida anti-corrupção também)"
