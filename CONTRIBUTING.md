# Contributing to Orkestral

Thanks for your interest in contributing! Orkestral is a **local-first AI dev-orchestration desktop app** — an agent company on your computer. It's built with **Electron 39 + React 19 + TypeScript**, using Tailwind v4, Zustand, TanStack Query, React Router, and SQLite (better-sqlite3 via Drizzle ORM).

This guide covers how to get set up, how the project is laid out, and the conventions we follow so your contribution lands smoothly.

---

## Getting set up

1. **Fork and clone** the repository.

   ```bash
   git clone https://github.com/<your-username>/orkestral.git
   cd orkestral
   ```

2. **Install dependencies.** The `postinstall` step rebuilds native modules (`better-sqlite3`) for Electron automatically.

   ```bash
   npm install
   ```

3. **Set up local models.** Orkestral runs models on-device, so the first run needs the Forge and embedding models in place. (This also runs automatically before `npm run dev` via `predev`.)

   ```bash
   npm run setup:models
   ```

4. **Run the app in development.**

   ```bash
   npm run dev
   ```

That's it — the Electron app should launch with hot reload for the renderer.

---

## Project structure

Orkestral splits cleanly into three layers. Knowing which one you're in tells you what you're allowed to import and how code communicates.

| Path           | Process                  | Responsibility                                                                                                                                                                     |
| -------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main`     | Electron **main** (Node) | App lifecycle, IPC handlers, DB access. SQLite schema in `src/main/db/schema.ts`, migrations in `src/main/db/migrations.ts`, data access in `src/main/db/repositories/`.           |
| `src/renderer` | React **UI**             | The whole interface. Components in `src/renderer/src/components/` (shared `ui/` + domain folders), Zustand stores in `src/renderer/src/stores/`, i18n in `src/renderer/src/i18n/`. |
| `src/shared`   | Shared **contract**      | IPC types and the typed channel contract in `src/shared/ipc-contract.ts`, plus shared types in `src/shared/types/`.                                                                |

The main and renderer processes **never** call each other directly — they talk over the typed IPC contract in `src/shared`. Data logic lives in repositories, not in IPC handlers.

---

## Making a change

1. **Create a branch** off the latest default branch (see [Commit & branch conventions](#commit--branch-conventions)).
2. **Make the smallest change that solves the problem** (see [Engineering conventions](#engineering-conventions)).
3. **Run the quality gate** locally — everything must pass:

   ```bash
   npm run typecheck && npm run lint && npm run format && npm run test
   ```

   - `typecheck` — TypeScript across both the node and web configs.
   - `lint` — ESLint.
   - `format` — Prettier (auto-fixes formatting).
   - `test` — Vitest.

4. **Open a pull request** against the upstream repository. Describe what changed and why; include a short, numbered summary of what you **added** and what you **altered**.
5. **Address review feedback.** Keep follow-up commits focused and re-run the quality gate before pushing updates.

> The quality gate is the bar for every PR. If it doesn't pass locally, it won't pass review.

---

## Commit & branch conventions

**Branch names** are always in English and follow `type/kebab-case-in-english`, using a Conventional Commit prefix:

- `feat/` — a new feature
- `fix/` — a bug fix
- `chore/` — tooling, deps, housekeeping
- `refactor/` — code change that neither fixes a bug nor adds a feature
- `docs/` — documentation only

Examples: `feat/issue-bulk-actions`, `fix/chat-scroll-jump`, `docs/contributing-guide`.

Use the same Conventional Commit prefixes for your commit messages, with a clear, present-tense subject line.

---

## Engineering conventions

These are the universal rules we hold every contribution to. They keep the codebase consistent and reviewable.

### Minimal patch first

- Change only what's needed to solve the task. Don't refactor surrounding code or clean up unrelated lines while fixing something else.
- No speculative abstraction. Don't build a helper, util, or wrapper for a single use, and don't add design patterns the problem doesn't call for. A few similar lines beat a premature abstraction; extract a component or function only once it's genuinely reused (roughly 3+ call sites).

### Reuse what already exists

Before creating something new, check whether it already exists:

- **UI** — look in `src/renderer/src/components/ui/` (button, dialog, card, badge, selects, context-menu, empty-state, etc.) and the domain folders (`agents/`, `chat/`, `sources/`, `workspace/`, `settings/`, `layout/`, …) before writing a new component.
- **Stores** — global state is Zustand in `src/renderer/src/stores/`. Don't introduce React Context for global state.
- **Types & IPC** — reuse existing types in `src/shared/types/` and existing channels in `src/shared/ipc-contract.ts` before adding new ones.
- **Data** — go through repositories in `src/main/db/repositories/`.
- **Dependencies** — don't add a library (or a new tool like Playwright/Storybook/etc.) without checking for an existing equivalent and a clear need. Icons come from `lucide-react`.

### No hardcoded colors or strings

- **Colors / spacing / shadows** come from the design-system tokens — never raw values. No `bg-white`, `text-zinc-X`, `bg-[#hex]`, or inline `style={{ color: '...' }}` for static colors. If a token you need doesn't exist, add it to the `@theme` block in `src/renderer/src/styles/global.css` rather than inlining an arbitrary value. (Dynamic, data-driven colors that can't be expressed as a token — e.g. an avatar gradient — are the exception.)
- **User-facing text** is never hardcoded in JSX. Use `t('key')` from the `useT()` hook. Error fallbacks use a translation key, never a raw string.

### i18n parity

- Locales live in `src/renderer/src/i18n/locales/`, and we ship **both `en` and `pt-BR`**.
- Every new string must be added to **both** locales — no exceptions. A key that exists in one locale but not the other is a bug.
- Format dates with a dynamic locale, not a fixed one.

### TypeScript & file naming

All new files are TypeScript: `.ts` for utils/hooks/stores, `.tsx` for components. Don't add new `.js`/`.jsx` files. Follow the existing naming conventions:

| Kind          | Convention         | Example             |
| ------------- | ------------------ | ------------------- |
| Component     | `PascalCase.tsx`   | `IssuesPage.tsx`    |
| Hook          | `useX` (camelCase) | `useIssueReadStore` |
| Zustand store | `xStore.ts`        | `workspaceStore.ts` |
| Repository    | `x.repo.ts`        | `issue.repo.ts`     |
| Util / helper | camelCase          | `accents.ts`        |
| DB column     | `snake_case`       | `parent_issue_id`   |
| IPC channel   | `domain:action`    | `issue:create-full` |

---

## Reporting bugs / requesting features

Found a bug or have an idea? Please open an issue using the templates:

- **[Bug report](https://github.com/Orkestral-AI/orkestral/issues/new?template=bug_report.md)**
- **[Feature request](https://github.com/Orkestral-AI/orkestral/issues/new?template=feature_request.md)**

Or browse the full list at the [issue tracker](https://github.com/Orkestral-AI/orkestral/issues). The more context you give (steps to reproduce, OS, what you expected), the faster we can help.

---

## Thanks!

Every contribution — code, docs, bug reports, ideas — makes Orkestral better. We're glad you're here. If anything in this guide is unclear, open an issue and let us know, and we'll improve it. Happy building!
