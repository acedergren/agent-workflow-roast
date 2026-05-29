---
description: Generate an Agent Workflow Roast report in the current workspace
argument-hint: [--days 7] [--no-memory] [--no-ai] [--output-dir .] [--export markdown|html|json]
allowed-tools: [Bash, Read]
---

# Agent Workflow Roast

The user invoked `/roast` with: `$ARGUMENTS`

Capture the folder where `/roast` was invoked before changing directories. Never paste raw `$ARGUMENTS` into a shell command.

Parse the supplied arguments into an argv JSON array first, using only the analyzer options shown in the argument hint. If the argument text is ambiguous, ask a short clarifying question. Run the local command wrapper from the plugin root with that folder as `AGENT_WORKFLOW_ROAST_OUTPUT_DIR`; the wrapper will pass parsed arguments to Node as argv without a shell:

```bash
AGENT_WORKFLOW_ROAST_OUTPUT_DIR="$INVOKED_DIR" node scripts/agent-workflow-roast-command.mjs <<'AGENT_WORKFLOW_ROAST_ARGV_JSON'
[]
AGENT_WORKFLOW_ROAST_ARGV_JSON
```

Replace `[]` with the parsed argv array when options are supplied, for example `["--days","7","--no-ai","--no-open"]`.

Report the generated file path back to the user. The HTML artifact must be named `agent-workflow-roast.html` and land in the folder where the command was invoked, unless the user explicitly passes an output directory.
