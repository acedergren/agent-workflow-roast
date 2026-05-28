# Codex Insights

Codex Insights is a local Codex plugin that turns recent Codex sessions into an ephemeral coaching report. It helps answer: where is my agent work going, what keeps slowing it down, and what local rules or prompts would make the next run better?

The report is local-first and temporary by default. Durable files are written only when you explicitly export them.

## Highlights

- `/insight` slash command for on-demand reports.
- `@insight` skill trigger for conversational use.
- Session ingestion from `~/.codex/history.jsonl` and `~/.codex/sessions/**/*.jsonl`.
- Optional memory context from `~/.codex/memories/MEMORY.md`.
- Bounded JSONL reads so large Codex installs do not exhaust memory.
- Secret, URL, email, and noisy-config redaction before rendering or synthesis.
- LLM coaching pass that turns raw stats into a working-style narrative, friction coaching, prompt-quality feedback, a playful roast, a copy-ready Codex custom-instructions artifact, generated rules, and project workflow prompts.
- `--no-ai` mode for deterministic local-only coaching.
- Single-file playground for tuning the coaching prompt and report shape.

## Quick Start

Run the analyzer directly from the repository:

```bash
npm run insight -- --no-open
```

Generate a 30-day deterministic report without LLM synthesis:

```bash
npm run insight -- --days 30 --no-ai --no-open
```

Export a durable Markdown report:

```bash
npm run insight -- --export markdown --output codex-insights-report.md
```

The command prints the generated path. Default HTML reports are written under the OS temp directory and opened automatically on macOS unless `--no-open` is passed.

## Report Sections

- **Good / Bad / Ugly**: a coaching-first top read that names what to keep, what to fix, the useful roast, and the next best move.
- **Coaching Targets**: estimated token spend over the lookback window, an improved-workflow scenario, estimated enterprise API cost delta, prompt quality, output effectiveness, planning clarity, and tool leverage with coaching.
- **Create These Artifacts**: one prioritized queue of copy-ready prompts for scripts, `AGENTS.md` rules, project skills, specialist agents, custom instructions, or checklists, each with artifact rationale.
- **Context Snapshot**: compact project and session counts without taking over the report.
- **Coach's Read**: human-readable synthesis after raw signals are cooked down.
- **Top Improvements**: practical behavior changes based on recent patterns.
- **Friction Signals**: repeated markers such as auth drift, missing proof, failed checks, retries, or timeouts.
- **Prompt Quality**: a coaching score, diagnosis, and better prompt pattern.
- **Custom Instructions**: paste-ready text for Codex Settings > Custom instructions.
- **Suggested Instruction Changes**: copy-ready rules for AGENTS.md or local instructions.
- **Project Workflow Prompts**: prompts to run inside projects to improve `AGENTS.md`, create project skills, or define specialist agents.

## Options

```text
--days <n>                  Lookback window in days, default 14
--no-memory                 Exclude ~/.codex/memories/MEMORY.md
--no-ai                     Skip codex exec synthesis and use deterministic coaching
--export markdown|html|json Persist a report instead of temp-only HTML
--output <path>             Output path for --export
--no-open                   Do not open generated HTML
--codex-home <path>         Override ~/.codex input root
```

## Privacy Model

Codex Insights reads local Codex history, session, and memory files. Before synthesis or rendering, it redacts obvious secrets, bearer tokens, GitHub tokens, API-key assignments, passwords, URLs, emails, private-key blocks, and noisy config-looking evidence snippets.

Token spend prefers measured Codex `token_count` rows and API `usage` fields, including cached input tokens when present. The chart shows the exact local date range and measured-versus-estimated split. If no measured token data exists for a row, the report falls back to a redacted text-volume estimate and labels the chart accordingly. Corporate dashboards may include additional Codex Web, cloud task, workspace, or other-machine usage that is not present in local `~/.codex` files.

By default, the analyzer attempts qualitative synthesis with `codex exec` using a bounded, redacted payload. Use `--no-ai` or `CODEX_INSIGHTS_NO_AI=1` when you want deterministic local-only coaching without sending that payload through a model call. If synthesis fails or returns unusable JSON, the deterministic report still renders.

## Playground

Open the coaching playground to tune the report shape and prompt strategy:

```bash
open playgrounds/insights-coach-playground.html
```

It is a self-contained HTML file with controls for tone, outcome, evidence strictness, example friction, a live preview, and a copyable analyzer prompt.

## Plugin Layout

```text
.codex-plugin/plugin.json          Plugin manifest
commands/insight.md                /insight command
skills/insight/SKILL.md            @insight skill
scripts/codex-session-insights.mjs Analyzer, redaction, synthesis, rendering
templates/report.html              HTML report template
assets/report.css                  Report styling
playgrounds/insights-coach-playground.html
tests/codex-session-insights.test.mjs
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

Run a safe real-data smoke test:

```bash
npm run insight -- --days 7 --no-ai --no-open --export html --output /private/tmp/codex-insights.html
```

## Requirements

- Node.js 20 or newer.
- Codex CLI for the optional LLM synthesis pass.
- Local Codex history/session files for meaningful reports.

## Status

This is an initial public implementation of a local Codex insights plugin. The report UI follows the provided mockup: a Codex-style insights workspace with metrics, workflow mapping, coaching, friction signals, prompt quality, suggested instructions, and reusable prompts.
