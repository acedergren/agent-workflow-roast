# Release Notes

## v0.2.0

Agent Workflow Roast is now the public name, report title, and plugin surface. The report is still local-first and coaching-heavy, but the branding is cleaner: `/roast`, `@roast`, and `agent-workflow-roast.html`.

Tagline: "A coaching report for your agent workflow, with receipts."

### Highlights

- Product/plugin name: Agent Workflow Roast.
- Report title: Agent Workflow Roast.
- Primary command and skill: `/roast` and `@roast`.
- Default output file: `agent-workflow-roast.html`.
- Marketplace plugin id: `agent-workflow-roast`.
- GitHub repo stays at `acedergren/codex-insights` for install continuity.

### Install

```bash
codex plugin marketplace add acedergren/codex-insights --ref v0.2.0
codex plugin add agent-workflow-roast@agent-workflow-roast
```

If you already added the old marketplace:

```bash
codex plugin marketplace upgrade codex-insights
codex plugin add agent-workflow-roast@agent-workflow-roast
```

### Verification

- `npm test`
- `npm run test:ui`
- `npm run validate:plugin`
- `git diff --check`
- Clean marketplace install smoke with `codex plugin add agent-workflow-roast@agent-workflow-roast`
