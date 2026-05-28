# Codex Insights

Codex Insights is a local Codex plugin that turns recent Codex session history and optional memory context into an ephemeral operational dashboard. It is meant for quick workflow reflection: what projects are taking attention, where loops or friction keep appearing, and which practical instruction changes might help next.

## What It Does

- Adds a `/insight` slash command for on-demand reports.
- Adds an `@insight` skill trigger for conversational use.
- Reads `~/.codex/history.jsonl`, `~/.codex/sessions/**/*.jsonl`, and, by default, `~/.codex/memories/MEMORY.md`.
- Redacts obvious secrets before synthesis and rendering.
- Uses an LLM coaching pass to turn raw stats into a working-style narrative, friction coaching, prompt-quality feedback, generated rules, and ready-to-use prompts.
- Writes reports to a short-lived temp directory by default.
- Persists output only when `--export markdown|html|json` is supplied.

## Quick Start

Run the analyzer directly from the repository:

```bash
npm run insight -- --no-open
```

Generate a 30-day report:

```bash
npm run insight -- --days 30 --no-open
```

Export a durable Markdown report:

```bash
npm run insight -- --export markdown --output codex-insights-report.md
```

The command prints the generated report path. On macOS, default ephemeral HTML reports are opened automatically unless `--no-open` is passed.

## Plugin Layout

- `.codex-plugin/plugin.json` declares the local plugin metadata.
- `commands/insight.md` defines the `/insight` slash command.
- `skills/insight/SKILL.md` defines the `@insight` skill trigger.
- `scripts/codex-session-insights.mjs` ingests, analyzes, redacts, synthesizes, and writes reports.
- `templates/report.html` and `assets/report.css` render the compact dashboard UI.
- `playgrounds/insights-coach-playground.html` is a single-file playground for tuning the coaching prompt and expected report shape.
- `tests/codex-session-insights.test.mjs` covers parsing, grouping, redaction, rendering, export, and temp cleanup.

## Options

```text
--days <n>                  Lookback window in days, default 14
--no-memory                 Exclude ~/.codex/memories/MEMORY.md
--export markdown|html|json Persist a report instead of temp-only HTML
--output <path>             Output path for --export
--no-open                   Do not open generated HTML
--no-ai                     Skip codex exec synthesis and use deterministic coaching
--codex-home <path>         Override ~/.codex input root
```

## Validation

Run the test suite:

```bash
npm test
```

Validate the plugin manifest:

```bash
npm run validate:plugin
```

## Privacy Model

Codex Insights is local-first. It reads local Codex session and memory files, redacts obvious secrets, and creates ephemeral reports under the OS temp directory unless export is explicit. Qualitative synthesis uses `codex exec` when available; if that call fails or returns unusable JSON, the deterministic report still renders.

Use `--no-ai` or `CODEX_INSIGHTS_NO_AI=1` when you want session-only deterministic coaching without sending the bounded, redacted synthesis payload through `codex exec`.

## Status

This is an initial implementation of the plan in `/Users/acedergr/Downloads/PLAN.md`. The report UI follows the provided mockup: a Codex-style insights workspace with at-a-glance metrics, a workflow pattern map, improvement cards, friction signals, suggested instruction changes, and reusable prompt patterns.
