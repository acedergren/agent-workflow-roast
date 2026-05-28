---
description: Generate an ephemeral Codex session insights report
argument-hint: [--days 30] [--no-memory] [--no-ai] [--export markdown|html|json]
allowed-tools: [Bash, Read]
---

# Codex Session Insights

The user invoked `/insight` with: `$ARGUMENTS`

Run the local analyzer from the plugin root:

```bash
node scripts/codex-session-insights.mjs $ARGUMENTS
```

Report the generated file path or export path back to the user. By default the report is written to a short-lived temp directory and opened immediately when the host supports it.
