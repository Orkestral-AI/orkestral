# Orkestral Embeddings

Esta pasta guarda o GGUF local usado pela busca semantica/RAG.

O modelo de embeddings e separado do Forge executor. O Forge e um modelo
instruct/coder; embeddings precisam de um modelo treinado para similaridade.

Estrutura esperada:

```text
resources/embeddings/
  models/embedding.gguf
```

Prepare com:

```bash
npm run setup:embeddings
```

O build executa `setup:models`, que prepara Forge e embeddings antes de empacotar
os recursos via `electron-builder.extraResources`.
