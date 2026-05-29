# Repository Instructions

This file applies to the entire `codex-insights` repository.

## Project Shape

- This is a local Codex plugin for session-insights reports.
- Plugin metadata lives in `.codex-plugin/plugin.json`.
- `/insight` command behavior lives in `commands/insight.md`.
- `@insight` skill behavior lives in `skills/insight/SKILL.md`.
- The main analyzer is `scripts/codex-session-insights.mjs`.
- Report structure and styling live in `templates/report.html` and `assets/report.css`.
- The coaching prompt playground is `playgrounds/insights-coach-playground.html`.
- Tests live in `tests/codex-session-insights.test.mjs`.

## Commands

- Run unit tests with `npm test`.
- Validate the plugin manifest with `npm run validate:plugin`.
- Run a safe real-data smoke test with:

  ```bash
  npm run insight -- --days 7 --no-ai --no-open --output-dir .
  ```

- Use `--no-ai` or `CODEX_INSIGHTS_NO_AI=1` when testing against real local Codex sessions unless the user explicitly approves sending the bounded, redacted synthesis payload through `codex exec`.

## Safety Rules

- Treat `~/.codex/history.jsonl`, `~/.codex/sessions/**/*.jsonl`, and `~/.codex/memories/MEMORY.md` as private local data.
- Default HTML reports are always named `codex-insights.html` and written to the folder where the command or skill was triggered. Do not commit generated reports.
- Preserve redaction behavior for secrets, bearer tokens, GitHub tokens, API-key assignments, passwords, URLs, emails, private-key blocks, and noisy config-like evidence.
- Do not add raw session dumps, memory dumps, generated reports, or temp exports to git.
- For playground or report UI that renders editable/user-controlled text, use `textContent` or explicit escaping rather than interpolating raw text into `innerHTML`.

## Implementation Guidance

- Before non-trivial recommendations or edits, inspect the applicable `AGENTS.md`, current `git status`, package scripts, and relevant source/tests.
- Keep the analyzer dependency-free unless there is a strong reason to add a package.
- Prefer small pure functions with direct tests for parsing, redaction, grouping, synthesis parsing, rendering, and export behavior.
- Keep JSONL ingestion bounded so mature Codex installs do not exhaust memory.
- The LLM synthesis pass should produce human-readable coaching: working-style narrative, friction coaching, prompt-quality feedback, copy-ready rules, and reusable prompts.
- Deterministic fallback output must remain useful when `codex exec` fails, is unavailable, or is disabled.
- Keep HTML/CSS responsive and inspect generated output when changing layout.

## Git Expectations

- Commit early and commit coherent units of work.
- Keep commits focused; do not mix generated temp reports or unrelated cleanup with product changes.
- Before committing, run `npm test`, `npm run validate:plugin`, and `git diff --check`.
- When pushing, use the existing feature branch unless the user asks for a new branch.
