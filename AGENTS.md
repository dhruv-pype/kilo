# AGENTS.md

Instructions for coding agents working in this repository.

## Purpose
This file defines repo-local operating rules for AI coding agents. Keep it aligned with the current codebase structure and workflows.

## Scope
- Applies to the full repository.
- If a deeper `AGENTS.md` exists in a subdirectory, that file overrides this one for files under that subtree.

## Core Rules
1. Do not print, echo, or copy secret values from `.env` or any credential source.
2. Never use destructive git commands unless explicitly requested.
3. Prefer minimal, focused changes over broad refactors.
4. Keep behavior-compatible changes unless the user asked for behavior changes.
5. Always include or update tests when logic changes.

## Repo Architecture Map
- API routes: `src/api/routes/*`
- Runtime orchestration: `src/bot-runtime/orchestrator/message-orchestrator.ts`
- Prompt composition: `src/bot-runtime/prompt-composer/*`
- Skill matching/proposal: `src/bot-runtime/skill-matcher/*`, `src/bot-runtime/skill-proposer/*`
- Web research learning flow: `src/web-research/*`
- Skill engine: `src/skill-engine/*`
- LLM gateway/providers/usage: `src/llm-gateway/*`
- Tool execution and credential vault: `src/tool-execution/*`
- Data layer: `src/database/*`, `src/cache/*`
- Tests: `tests/unit/*`

## Required Workflow For Changes
1. Read the affected code paths and nearby tests first.
2. Implement the smallest correct change.
3. Run targeted tests for changed modules.
4. Run `npm run typecheck` when TypeScript files are changed.
5. Summarize what changed, why, and what was verified.

## Testing Guidance
- Run module-level tests first, then broader tests if needed.
- Relevant common commands:
  - `npm test -- tests/unit/web-research/*.test.ts`
  - `npm test -- tests/unit/bot-runtime/*.test.ts`
  - `npm run typecheck`

## Environment & Safety
- Use `npm run env:check` for non-secret env diagnostics (`set/missing/invalid` only).
- Never add real keys/tokens to source, logs, tests, docs, or commit messages.
- If a secret is exposed, recommend rotation immediately.

## Documentation Rules
- `README.md`: developer/user-facing setup and product docs.
- `AGENTS.md`: agent behavior, guardrails, and coding workflow.
- Keep this file up to date when architecture or workflow changes materially.

## Commit Hygiene (When Asked to Commit)
- Keep commit scope tight and messages explicit.
- Avoid mixing unrelated changes in one commit.
- Mention affected modules and tests in commit body when useful.
