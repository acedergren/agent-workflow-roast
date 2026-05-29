# Agent Workflow Roast

<p align="center">
  <img src="plugins/agent-workflow-roast/assets/agent-workflow-roast-icon.png" alt="Cartoon robot calmly roasting agent workflow chaos" width="180" />
</p>

Agent Workflow Roast is a local plugin that turns recent agent sessions into coaching. It helps answer: where is the work going, what keeps slowing it down, and which durable prompts, `AGENTS.md` rules, skills, agents, scripts, or checklists would make the next run better?

> A coaching report for your agent workflow, with receipts.

Reports are local-first. By default, each report uses a rolling 7-day window. The HTML dashboard is always written as `agent-workflow-roast.html` in the folder where `/roast` or `@roast` was triggered, unless you pass a different output directory.

## What You Get

- `/roast` slash command and `@roast` skill trigger.
- Local session ingestion from `~/.codex/history.jsonl` and `~/.codex/sessions/**/*.jsonl`.
- Optional memory context from `~/.codex/memories/MEMORY.md`.
- Secret, URL, email, and noisy-config redaction before rendering or synthesis.
- AI coaching pass over a bounded, redacted payload, with deterministic `--no-ai` fallback.
- Copy-ready custom instructions, project workflow prompts, suggested `AGENTS.md` rules, and artifact-creation prompts.
- Token spend scenario chart using measured Codex token-count rows when available, with estimated fallback clearly labeled.

## Quick Start

Install the plugin from the public repo marketplace:

```bash
codex plugin marketplace add acedergren/agent-workflow-roast --ref v0.2.1
codex plugin add agent-workflow-roast@agent-workflow-roast
```

If you added the marketplace before `v0.2.1`, refresh it first:

```bash
codex plugin marketplace upgrade agent-workflow-roast
codex plugin add agent-workflow-roast@agent-workflow-roast
```

If your local marketplace is still listed as `codex-insights`, upgrade that name once and then add the plugin:

```bash
codex plugin marketplace upgrade codex-insights
codex plugin add agent-workflow-roast@agent-workflow-roast
```

Then start or restart Codex and run:

```text
/roast
```

Run the analyzer directly from the repository:

```bash
npm run roast -- --no-open
```

Run a deterministic local-only report:

```bash
npm run roast -- --days 30 --no-ai --no-open
```

Export a durable Markdown report:

```bash
npm run roast -- --export markdown --output agent-workflow-roast.md
```

The command prints the generated path. Default HTML reports are written to `./agent-workflow-roast.html` and opened automatically on macOS unless `--no-open` is passed.

## Report Sections

- **Good / Bad / Ugly**: what to keep doing, what is costing loops, the useful roast, and the next best move.
- **Coaching Targets**: token spend over the lookback window, improved-workflow scenario, estimated enterprise API cost delta, prompt quality, output effectiveness, planning clarity, and tool follow-through.
- **Coach's Read**: human-readable synthesis after raw signals are cooked down.
- **Top Actions**: one canonical list of copy-ready prompts for scripts, `AGENTS.md` rules, project skills, specialist agents, custom instructions, or checklists.
- **Prompt Quality**: a concrete score, diagnosis, and better prompt pattern.
- **Evidence**: source-backed signal cards with counts, confidence, and rules.

Copy buttons are included for copy-ready sections in the HTML report.

## Current Release

`v0.2.1` moves the public GitHub repository to `acedergren/agent-workflow-roast` and makes the default report window a rolling 7 days. See [CHANGELOG.md](CHANGELOG.md) and [RELEASE_NOTES.md](RELEASE_NOTES.md) for details.

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
--days <n>                  Lookback window in days, default 7
--no-memory                 Exclude ~/.codex/memories/MEMORY.md
--no-ai                     Skip codex exec synthesis and use deterministic coaching
--export markdown|html|json Export format, default html
--output <path>             Output path for markdown/json; directory for HTML
--output-dir <path>         Directory for the default agent-workflow-roast.html artifact
--no-open                   Do not open generated HTML
--codex-home <path>         Override ~/.codex input root
```

## Privacy Model

Agent Workflow Roast reads local Codex history, session, and memory files. Before synthesis or rendering, it redacts obvious secrets, bearer tokens, GitHub tokens, API-key assignments, passwords, URLs, emails, private-key blocks, and noisy config-looking evidence snippets.

By default, the analyzer attempts qualitative synthesis with `codex exec` using a bounded, redacted payload. Use `--no-ai` or `AGENT_WORKFLOW_ROAST_NO_AI=1` when you want deterministic local-only coaching without sending that payload through a model call. If synthesis fails or returns unusable JSON, the deterministic report still renders.

## Plugin Layout

```text
.agents/plugins/marketplace.json                         Repo marketplace catalog
plugins/agent-workflow-roast/.codex-plugin/plugin.json  Plugin manifest
plugins/agent-workflow-roast/commands/roast.md        /roast command
plugins/agent-workflow-roast/skills/roast/SKILL.md    @roast skill
plugins/agent-workflow-roast/scripts/agent-workflow-roast.mjs
                                                          Analyzer, redaction, synthesis, rendering
plugins/agent-workflow-roast/templates/report.html      HTML report template
plugins/agent-workflow-roast/assets/report.css          Report styling
plugins/agent-workflow-roast/playgrounds/roast-coach-playground.html
tests/agent-workflow-roast.test.mjs
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
npm run roast -- --days 7 --no-ai --no-open --output-dir .
```

## Playground

Open the coaching playground to tune the report shape and prompt strategy:

```bash
open plugins/agent-workflow-roast/playgrounds/roast-coach-playground.html
```

It is a self-contained HTML file with controls for tone, outcome, evidence strictness, example friction, live preview, and a copyable analyzer prompt.

## Requirements

- Node.js 20 or newer.
- Codex CLI for the optional AI synthesis pass.
- Local Codex history/session files for meaningful reports.

## Status

This is an early public implementation of Agent Workflow Roast. The current focus is personal workflow coaching: make session patterns visible, then convert repeated friction into durable guidance and copy-ready artifacts.
