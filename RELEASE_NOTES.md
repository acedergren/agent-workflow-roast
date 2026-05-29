# Release Notes

## v0.1.4

Codex Insights now bakes the Humanizer guidance into the report-generation prompts themselves. The synthesis pass and the editor/dedupe pass both ask the model to remove obvious AI tells, keep exact commands and safety wording intact, and add a more specific coaching voice instead of sanding everything down into bland correctness.

### Highlights

- Humanizer instructions are part of the LLM prompt for generating insight reports.
- The editor pass now checks for AI-shaped phrasing while deduping recommendations.
- Deterministic cleanup catches more common AI tells.
- Regression tests prove the humanizer guidance remains wired into both prompt passes.

### Install

```bash
codex plugin marketplace add acedergren/codex-insights --ref v0.1.4
codex plugin add codex-session-insights@codex-insights
```

If you already added the marketplace:

```bash
codex plugin marketplace upgrade codex-insights
codex plugin add codex-session-insights@codex-insights
```

### Verification

- `npm test`
- `npm run validate:plugin`
- `git diff --check`
- Fresh AI-enabled report generation to `codex-insights.html`
