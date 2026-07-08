# Changelog

All notable changes to **Orkestral** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.1] — 2026-06-10

🪐 **First public release.** A local-first desktop deck where a team of AI agents plans, executes and reviews your code — entirely on your machine.

### Added

- **Agent team & orchestration** — a **CEO** orchestrator that reads your repos, plans and delegates to specialists (Tech Lead, Code Reviewer, Frontend, Backend, DevOps, QA, Designer) following a real `reports_to` hierarchy. Mention `@agent` to route a turn to a specialist; the team breaks work down, executes, reviews each other and reports back in chat.
- **Orkestral Forge (local execution)** — a bundled local code model (Qwen2.5-Coder via `node-llama-cpp`) that executes edits **100% on your machine** with **$0 API cost**, escalating to a premium model only when needed. Own **Fast Apply**: a deterministic SEARCH/REPLACE applier that merges edits without rewriting whole files (never writes ambiguous content).
- **Issues & epics** — every meaningful request becomes trackable work, auto-grouped under epics, with status, priority, assignee and parent/child links, plus an approval gate before any code is touched.
- **Code reviews** — senior-level reviews on GitHub pull requests with structured findings and inline comments.
- **Knowledge base** — a wiki-style brain per workspace (pages, wikilinks, graph view), auto-built from your repos via **BM25 lexical + local semantic search (embeddings/RAG)** — all on-device, no cloud.
- **Routines & goals**, **MCP servers & integrations** (e.g. GitHub, Playwright browser tools, voice) and multiple agent providers.
- **Local search tools** — Warp Grep (semantic context), code search and conversation search, all local.
- **Multilingual UI** — full English + Brazilian Portuguese, auto-detected from the OS; agents reply in the language you write in.
- **Cross-platform installers** — native builds for **macOS (Apple Silicon)**, **Windows (x64)** and **Linux (AppImage)**, with the local models **bundled in** so the app works offline from the first launch.
- **CI release pipeline** — pushing a `v*` tag (or running the **Release** workflow) builds all three platforms on native runners and publishes the installers to a GitHub Release.
- **In-app auto-update** — Windows/Linux via `electron-updater` (macOS uses a manual update check until code signing lands).
- **Cloud login bridge** — sign in / sign up on the web and sync your name + email back into the desktop app via loopback / deep link.

### Notes

- Installers are **not code-signed yet** — the OS shows a warning on first launch (macOS Gatekeeper / Windows SmartScreen). It's safe; signing + notarization are on the roadmap.
- The web companion (accounts, downloads, docs) lives at **[orkestral.pro](https://orkestral.pro)**.

[Unreleased]: https://github.com/Orkestral-AI/orkestral/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Orkestral-AI/orkestral/releases/tag/v0.1.1
