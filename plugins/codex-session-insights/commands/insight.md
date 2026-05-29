---
description: Generate a Codex session insights report in the current workspace
argument-hint: [--days 30] [--no-memory] [--no-ai] [--output-dir .] [--export markdown|html|json]
allowed-tools: [Bash, Read]
---

# Codex Session Insights

The user invoked `/insight` with: `$ARGUMENTS`

Capture the folder where `/insight` was invoked before changing directories. Run the local analyzer from the plugin root with that folder as `CODEX_INSIGHTS_OUTPUT_DIR`:

```bash
CODEX_INSIGHTS_OUTPUT_DIR="$INVOKED_DIR" node scripts/codex-session-insights.mjs $ARGUMENTS
```

Report the generated file path back to the user. The HTML artifact must be named `codex-insights.html` and land in the folder where the command was invoked, unless the user explicitly passes an output directory.
