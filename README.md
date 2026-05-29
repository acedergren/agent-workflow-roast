# Codex Insights

Codex Insights is a local Codex plugin that turns recent Codex sessions into a coaching report. It helps answer: where is agent work going, what keeps slowing it down, and which durable prompts, `AGENTS.md` rules, skills, agents, scripts, or checklists would make the next run better?

Reports are local-first. The HTML dashboard is always written as `codex-insights.html` in the folder where `/insight` or `@insight` was triggered, unless you pass a different output directory.

## What You Get

- `/insight` slash command and `@insight` skill trigger.
- Local session ingestion from `~/.codex/history.jsonl` and `~/.codex/sessions/**/*.jsonl`.
- Optional memory context from `~/.codex/memories/MEMORY.md`.
- Secret, URL, email, and noisy-config redaction before rendering or synthesis.
- AI coaching pass over a bounded, redacted payload, with deterministic `--no-ai` fallback.
- Copy-ready custom instructions, project workflow prompts, suggested `AGENTS.md` rules, and artifact-creation prompts.
- Token spend scenario chart using measured Codex token-count rows when available, with estimated fallback clearly labeled.

## Quick Start

Install the plugin from the public repo marketplace:

```bash
codex plugin marketplace add acedergren/codex-insights --ref v0.1.3
codex plugin add codex-session-insights@codex-insights
```

If you added the marketplace before `v0.1.3`, refresh it first:

```bash
codex plugin marketplace upgrade codex-insights
```

Then start or restart Codex and run:

```text
/insight --days 7
```

Run the analyzer directly from the repository:

```bash
npm run insight -- --no-open
```

Run a deterministic local-only report:

```bash
npm run insight -- --days 30 --no-ai --no-open
```

Export a durable Markdown report:

```bash
npm run insight -- --export markdown --output codex-insights.md
```

The command prints the generated path. Default HTML reports are written to `./codex-insights.html` and opened automatically on macOS unless `--no-open` is passed.

## Report Sections

- **Good / Bad / Ugly**: what to keep doing, what is costing loops, the useful roast, and the next best move.
- **Coaching Targets**: token spend over the lookback window, improved-workflow scenario, estimated enterprise API cost delta, prompt quality, output effectiveness, planning clarity, and tool follow-through.
- **Coach's Read**: human-readable synthesis after raw signals are cooked down.
- **Top Actions**: one canonical list of copy-ready prompts for scripts, `AGENTS.md` rules, project skills, specialist agents, custom instructions, or checklists.
- **Prompt Quality**: a concrete score, diagnosis, and better prompt pattern.
- **Evidence**: source-backed signal cards with counts, confidence, and rules.

Copy buttons are included for copy-ready sections in the HTML report.

## Current Release

`v0.1.3` fixes the public marketplace packaging so `codex plugin add codex-session-insights@codex-insights` discovers and installs the plugin. See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Token Accounting

Token spend prefers measured local Codex `token_count` rows and API `usage` fields, including cached input tokens when present. The chart shows:

- exact local date range
- measured tokens
- estimated fallback tokens
- actual estimated spend
- projected spend after workflow improvements
- estimated enterprise API cost delta

If no measured token data exists for a row, the report falls back to a redacted text-volume estimate. Corporate dashboards may show higher numbers because they can include Codex Web, cloud tasks, workspace-level aggregation, or other-machine usage that is not present in local `~/.codex` files.

## Options

```text
--days <n>                  Lookback window in days, default 14
--no-memory                 Exclude ~/.codex/memories/MEMORY.md
--no-ai                     Skip codex exec synthesis and use deterministic coaching
--export markdown|html|json Export format, default html
--output <path>             Output path for markdown/json; directory for HTML
--output-dir <path>         Directory for the default codex-insights.html artifact
--no-open                   Do not open generated HTML
--codex-home <path>         Override ~/.codex input root
```

## Privacy Model

Codex Insights reads local Codex history, session, and memory files. Before synthesis or rendering, it redacts obvious secrets, bearer tokens, GitHub tokens, API-key assignments, passwords, URLs, emails, private-key blocks, and noisy config-looking evidence snippets.

By default, the analyzer attempts qualitative synthesis with `codex exec` using a bounded, redacted payload. Use `--no-ai` or `CODEX_INSIGHTS_NO_AI=1` when you want deterministic local-only coaching without sending that payload through a model call. If synthesis fails or returns unusable JSON, the deterministic report still renders.

## Plugin Layout

```text
.agents/plugins/marketplace.json                         Repo marketplace catalog
plugins/codex-session-insights/.codex-plugin/plugin.json  Plugin manifest
plugins/codex-session-insights/commands/insight.md        /insight command
plugins/codex-session-insights/skills/insight/SKILL.md    @insight skill
plugins/codex-session-insights/scripts/codex-session-insights.mjs
                                                          Analyzer, redaction, synthesis, rendering
plugins/codex-session-insights/templates/report.html      HTML report template
plugins/codex-session-insights/assets/report.css          Report styling
plugins/codex-session-insights/playgrounds/insights-coach-playground.html
tests/codex-session-insights.test.mjs
```

## Development

Run the test suite:

```bash
npm test
```

Validate the plugin manifest:

```bash
npm run validate:plugin
```

Run a safe real-data smoke test without AI synthesis:

```bash
npm run insight -- --days 7 --no-ai --no-open --output-dir .
```

## Playground

Open the coaching playground to tune the report shape and prompt strategy:

```bash
open plugins/codex-session-insights/playgrounds/insights-coach-playground.html
```

It is a self-contained HTML file with controls for tone, outcome, evidence strictness, example friction, live preview, and a copyable analyzer prompt.

## Requirements

- Node.js 20 or newer.
- Codex CLI for the optional AI synthesis pass.
- Local Codex history/session files for meaningful reports.

## Status

This is an initial public implementation of a local Codex insights plugin. The current focus is personal workflow coaching: make session patterns visible, then convert repeated friction into durable guidance and copy-ready artifacts.
