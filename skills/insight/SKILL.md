---
name: insight
description: Generate an ephemeral Codex session insights dashboard from recent session history and optional memory context. Use when the user invokes @insight or asks for Codex workflow/session insights.
---

# Codex Session Insights

Use this skill when the user asks for `@insight`, `/insight`, or an operational summary of recent Codex work.

## Workflow

1. From the plugin root, run:

   ```bash
   node scripts/codex-session-insights.mjs
   ```

2. Pass through user options when supplied:

   ```bash
   node scripts/codex-session-insights.mjs --days 30 --no-memory
   node scripts/codex-session-insights.mjs --no-ai
   node scripts/codex-session-insights.mjs --export markdown
   ```

3. Share the generated report path. Default reports are ephemeral temp files; durable artifacts are written only when `--export` is used.

## Notes

- The analyzer redacts obvious secrets before synthesis or rendering.
- Missing history, session, or memory files should degrade into a sparse report instead of failing.
- If qualitative synthesis is unavailable, use the deterministic report sections.
