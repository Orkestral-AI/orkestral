#!/usr/bin/env bash
# Runner do Braço A — `claude` puro (Claude Code) agêntico, headless.
# Roda o PROMPT.md verbatim num workspace vazio e captura usage/custo do stream-json.
#
# Uso:  ./run-raw-arm.sh <run-index> <modelo>
# Ex.:  ./run-raw-arm.sh 1 claude-opus-4-8
#
# Pré-requisitos: `claude` logado, `jq` instalado.
# Fairness: usa --dangerously-skip-permissions porque o Orkestral roda com --yolo.
# O modelo é OBRIGATÓRIO: paridade exige o MESMO modelo explícito nos dois braços
# (e em bash 3.2 do macOS, modelo opcional quebrava com `set -u` + array vazio).

set -euo pipefail

RUN_IDX="${1:?uso: ./run-raw-arm.sh <run-index> <modelo>}"
MODEL="${2:?uso: ./run-raw-arm.sh <run-index> <modelo> — modelo explícito é obrigatório (fairness)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FILE="$SCRIPT_DIR/PROMPT.md"
RUN_DIR="$SCRIPT_DIR/runs/raw/run-$RUN_IDX"
WS_DIR="$RUN_DIR/workspace"

command -v claude >/dev/null || { echo "erro: 'claude' não está no PATH"; exit 1; }
command -v jq >/dev/null || { echo "erro: 'jq' não encontrado (brew install jq)"; exit 1; }

# Prompt = conteúdo do PROMPT.md sem o bloco de comentário HTML do topo.
PROMPT="$(sed '/^<!--/,/-->/d' "$PROMPT_FILE")"

mkdir -p "$WS_DIR"
# CLAUDE.md mínimo no workspace do braço A (paridade: o Orkestral injeta contexto;
# aqui damos só o mínimo neutro, sem viés de stack).
# Julgamento cego: este arquivo fingerprinta o braço A — remova-o da CÓPIA entregue
# ao juiz se o run não o modificou (ver README, seção Julgamento).
printf '# Projeto\n\nApp novo. Escolha a stack que achar melhor. Foque num MVP que roda.\n' > "$WS_DIR/CLAUDE.md"

echo "==> Braço A | run $RUN_IDX | modelo=$MODEL"
echo "==> workspace: $WS_DIR"
START_EPOCH=$(date +%s)
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$RUN_DIR/started_at.txt"
CLAUDE_EXIT=""

# Escreve ended_at + summary.json a partir do que existir em output.jsonl.
# Chamado no fim feliz E no trap de EXIT (claude falhou / Ctrl-C): o run que FALHA
# — budget estourado, erro do CLI — é exatamente o cenário que a métrica 6 do
# README mais precisa registrar; ele não pode sair sem summary.
write_summary() {
  local end_epoch wall result_json model_used
  end_epoch=$(date +%s)
  wall=$((end_epoch - START_EPOCH))
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$RUN_DIR/ended_at.txt"

  # `|| true`: output.jsonl pode terminar em linha truncada (run morto mid-write) —
  # o jq falharia e, sob set -e, mataria o script sem summary.
  result_json="$(jq -c 'select(.type=="result")' "$RUN_DIR/output.jsonl" 2>/dev/null | tail -1 || true)"
  # Modelo REALMENTE usado (id resolvido pelo CLI) — vem do evento init do stream-json.
  model_used="$(jq -r 'select(.type=="system" and .subtype=="init") | .model // empty' "$RUN_DIR/output.jsonl" 2>/dev/null | head -1 || true)"

  jq -n \
    --argjson result "${result_json:-null}" \
    --arg wall "$wall" \
    --arg run "$RUN_IDX" \
    --arg model "$MODEL" \
    --arg model_used "${model_used:-}" \
    --arg claude_exit "${CLAUDE_EXIT:-}" \
    '{
       arm: "raw",
       run: ($run|tonumber),
       model_requested: $model,
       model_used: (if $model_used == "" then null else $model_used end),
       claude_exit_code: (if $claude_exit == "" then null else ($claude_exit|tonumber) end),
       wall_clock_sec: ($wall|tonumber),
       total_cost_usd: ($result.total_cost_usd // null),
       num_turns: ($result.num_turns // null),
       duration_ms: ($result.duration_ms // null),
       usage: ($result.usage // null),
       is_error: (if $result == null then null else ($result.is_error // false) end)
     }' > "$RUN_DIR/summary.json"
}

on_exit() {
  # Ctrl-C / morte inesperada: garante ended_at + summary parcial do que já existe.
  [ -f "$RUN_DIR/summary.json" ] || write_summary || true
}
trap on_exit EXIT

# Roda agêntico em headless, streaming JSON pra capturar usage no evento final.
# `|| CLAUDE_EXIT=$?`: exit != 0 do claude (erro, budget) NÃO pode matar o script —
# com pipefail o status do pipeline é o do claude, e set -e abortaria antes do summary.
# CLAUDE_EXIT só é atribuído DEPOIS do pipeline: morte no meio (Ctrl-C) → null no summary.
( cd "$WS_DIR" && claude -p "$PROMPT" \
    --output-format stream-json --verbose \
    --dangerously-skip-permissions \
    --model "$MODEL" ) | tee "$RUN_DIR/output.jsonl" && CLAUDE_EXIT=0 || CLAUDE_EXIT=$?

write_summary

echo "==> done. claude_exit=$CLAUDE_EXIT"
echo "==> resumo:"; cat "$RUN_DIR/summary.json"
echo "==> agora avalie $WS_DIR com benchmark/RUBRIC.md"
