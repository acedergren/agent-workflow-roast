import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeRows,
  applyVoiceContract,
  applySessionCwd,
  buildRecommendations,
  buildCoachingPrompt,
  buildDeterministicInsights,
  buildReport,
  buildSignals,
  cleanupOldTempReports,
  hasNearDuplicatePrompts,
  loadInputs,
  mapSignalToArtifact,
  parseArgs,
  parseCodexJsonOutput,
  parseJsonl,
  readJsonlTail,
  redactSecrets,
  renderHtml,
  renderMarkdown,
  selectMemoryHits,
  writeReport,
} from "../scripts/codex-session-insights.mjs";

process.env.CODEX_INSIGHTS_NO_AI = "1";

test("parseJsonl keeps valid rows and reports malformed lines", () => {
  const result = parseJsonl('{"cwd":"/tmp/a"}\nnope\n{"cwd":"/tmp/b"}\n');

  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.malformed, [{ line: 2, message: "Unexpected token 'o', \"nope\" is not valid JSON" }]);
});

test("redactSecrets removes obvious tokens and credentials", () => {
  const input =
    "Bearer abc.def.ghi password = super-secret OPENAI_API_KEY=sk-real ghp_abcdefghijklmnopqrstuvwxyz https://internal.example.test user@example.com";
  const redacted = redactSecrets(input);

  assert.doesNotMatch(redacted, /super-secret|sk-real|ghp_|internal\.example|user@example/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("analyzeRows groups projects, tools, and friction markers", () => {
  const rows = [
    {
      timestamp: new Date().toISOString(),
      cwd: "/Users/acedergr/Documents/codex-insights",
      type: "function_call",
      name: "exec_command",
      content: "Tests failed because a file was missing",
      usage: { input_tokens: 1000, output_tokens: 400 },
    },
    {
      timestamp: new Date().toISOString(),
      cwd: "/Users/acedergr/Projects/oci-self-service-portal",
      recipient: "apply_patch",
      text: "Permission retry fixed the error",
    },
    {
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 99000,
            cached_input_tokens: 80000,
            output_tokens: 900,
            reasoning_output_tokens: 100,
            total_tokens: 99900,
          },
          last_token_usage: {
            input_tokens: 2000,
            cached_input_tokens: 500,
            output_tokens: 300,
            reasoning_output_tokens: 20,
            total_tokens: 2300,
          },
        },
      },
    },
  ];

  const stats = analyzeRows(rows, { days: 30 });

  assert.equal(stats.totalRows, 3);
  assert.equal(stats.projects[0].name, "codex-insights");
  assert.equal(stats.tools.find((item) => item.name === "exec_command").count, 1);
  assert.ok(stats.friction.some((item) => item.name === "failed"));
  assert.equal(stats.tokenSpend.actual.total >= 3700, true);
  assert.equal(stats.tokenSpend.actual.total < 99900, true);
  assert.equal(stats.tokenSpend.actual.cachedInput >= 500, true);
  assert.equal(stats.tokenSpend.daily.length >= 1, true);
  assert.ok(stats.tokenSpend.coverage.startDate);
  assert.ok(stats.tokenSpend.coverage.endDate);
});

test("buildSignals collapses raw failure markers into one source-backed signal", () => {
  const stats = analyzeRows(
    [
      { timestamp: new Date().toISOString(), cwd: "/tmp/codex-insights", content: "build error in package step" },
      { timestamp: new Date().toISOString(), cwd: "/tmp/codex-insights", content: "failed action needs logs" },
      { timestamp: new Date().toISOString(), cwd: "/tmp/codex-insights", content: "failure after rerun" },
      { timestamp: new Date().toISOString(), cwd: "/tmp/codex-insights", content: "auth token check without values" },
    ],
    { days: 30 },
  );

  const signals = buildSignals(stats);
  const failure = signals.find((signal) => signal.id === "build-action-failures");

  assert.equal(failure.count, 3);
  assert.deepEqual(
    signals.map((signal) => signal.id).filter((id) => ["error", "failed", "failure"].includes(id)),
    [],
  );
  assert.ok(failure.examples.length > 0);
  assert.ok(failure.sourceKinds.includes("friction-marker"));
});

test("buildRecommendations cites valid signal ids and dedupes copy prompts", () => {
  const stats = analyzeRows(
    [
      { timestamp: new Date().toISOString(), cwd: "/tmp/codex-insights", content: "build error in package step" },
      { timestamp: new Date().toISOString(), cwd: "/tmp/codex-insights", content: "failed action needs logs" },
      { timestamp: new Date().toISOString(), cwd: "/tmp/codex-insights", content: "failure after rerun" },
      { timestamp: new Date().toISOString(), cwd: "/tmp/codex-insights", content: "auth token check without values" },
    ],
    { days: 30 },
  );
  const signals = buildSignals(stats);
  const insights = buildDeterministicInsights(stats, []);

  insights.actionPrompts = [
    {
      title: "Create failure triage",
      artifact: "script",
      target: "codex-insights",
      rationale: "Repeated failures need one command path.",
      prompt: "Inspect this project first: read AGENTS.md, git status, package scripts, and CI logs. Create a failure triage script and run validation.",
    },
    {
      title: "Create failure triage script",
      artifact: "script",
      target: "codex-insights",
      rationale: "Repeated failures need one command path.",
      prompt: "Inspect this project first: read AGENTS.md, git status, package scripts, and CI logs. Create a failure triage script and run validation.",
    },
  ];

  const recommendations = buildRecommendations(stats, insights, signals);
  const signalIds = new Set(signals.map((signal) => signal.id));

  assert.ok(recommendations.length > 0);
  assert.equal(hasNearDuplicatePrompts(recommendations), false);
  for (const recommendation of recommendations) {
    assert.ok(recommendation.signalIds.length > 0, recommendation.title);
    assert.ok(recommendation.signalIds.every((id) => signalIds.has(id)), recommendation.title);
  }
});

test("applyVoiceContract removes AI tells while preserving commands and paths", () => {
  const result = applyVoiceContract({
    summary: "This pivotal workflow landscape unlocks leverage for the team.",
    nested: {
      body: "Run npm test and inspect /Users/acedergr/Documents/codex-insights before editing.",
    },
  });

  assert.doesNotMatch(result.value.summary, /pivotal|landscape|leverage/i);
  assert.match(result.value.nested.body, /npm test/);
  assert.match(result.value.nested.body, /\/Users\/acedergr\/Documents\/codex-insights/);
  assert.ok(result.review.rewrites.length >= 1);
});

test("buildReport exposes signals recommendations and voice review with deterministic fallback", () => {
  const report = buildReport(
    {
      rows: [
        { timestamp: new Date().toISOString(), cwd: "/tmp/codex-insights", content: "build error in package step" },
        { timestamp: new Date().toISOString(), cwd: "/tmp/codex-insights", content: "failed action needs logs" },
      ],
      malformedRows: 0,
      memoryText: "",
      jsonlFiles: [],
    },
    { days: 7, includeMemory: false, useAi: false },
  );

  assert.ok(report.signals.some((signal) => signal.id === "build-action-failures"));
  assert.ok(report.recommendations.length > 0);
  assert.equal(hasNearDuplicatePrompts(report.recommendations), false);
  assert.ok(report.voiceReview);
});

test("analyzeRows stores short redacted evidence snippets", () => {
  const stats = analyzeRows([
    {
      timestamp: new Date().toISOString(),
      cwd: "/tmp/codex-insights",
      content: "base_url = https://internal.example.test\nTests failed because auth config was stale.",
    },
  ]);

  assert.equal(stats.examples[0], "Tests failed because auth config was stale.");
  assert.doesNotMatch(stats.examples.join("\n"), /internal\.example|base_url/);
});

test("analyzeRows parses status-style token usage text", () => {
  const stats = analyzeRows([
    {
      timestamp: new Date().toISOString(),
      cwd: "/tmp/codex-insights",
      content: "Token usage: 7.49K total (7.38K input + 105 output)",
    },
  ]);

  assert.equal(stats.tokenSpend.measured, 7490);
  assert.equal(stats.tokenSpend.actual.input, 7380);
  assert.equal(stats.tokenSpend.actual.output, 105);
});

test("applySessionCwd carries session cwd into later rows", () => {
  const rows = applySessionCwd([
    { type: "session_meta", payload: { cwd: "/Users/acedergr/Documents/codex-insights" } },
    { type: "response_item", content: "continued work" },
  ]);

  const stats = analyzeRows(rows, { days: 30 });

  assert.equal(stats.projects[0].name, "codex-insights");
  assert.equal(stats.projects[0].count, 2);
});

test("selectMemoryHits returns project-related memory context", () => {
  const memory = ["# Memory", "codex-insights should prefer ephemeral reports", "other line"].join("\n");
  const hits = selectMemoryHits(memory, [{ name: "codex-insights", count: 2 }]);

  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
});

test("renderers include required report sections", () => {
  const stats = analyzeRows([
    {
      timestamp: new Date().toISOString(),
      cwd: "/tmp/codex-insights",
      content: "blocked retry",
    },
  ]);
  const signals = buildSignals(stats);
  const insights = buildDeterministicInsights(stats, []);
  const recommendations = buildRecommendations(stats, insights, signals);
  insights.recommendations = recommendations;
  const report = {
    title: "Codex Session Insights (14 days)",
    stats,
    memoryHits: [],
    signals,
    recommendations,
    voiceReview: applyVoiceContract(insights).review,
    insights,
  };

  const html = renderHtml(report);
  const markdown = renderMarkdown(report);

  assert.match(html, /Coaching targets/);
  assert.doesNotMatch(html, /Top Improvements/);
  assert.match(html, /Good \/ Bad \/ Ugly/);
  assert.match(html, /Coaching Targets/);
  assert.match(html, /token spend scenario/);
  assert.match(html, /API cost delta/);
  assert.match(html, /Dates:/);
  assert.match(html, /Measured:/);
  assert.match(html, /Coach&#39;s Read/);
  assert.match(html, /Top Actions/);
  assert.match(html, /Prompt Quality/);
  assert.match(html, /Evidence/);
  assert.match(html, /Why this artifact/);
  assert.match(html, /Source:/);
  assert.match(html, /data-copy-text/);
  assert.match(html, /Copy prompt/);
  assert.doesNotMatch(html, /Suggested Instruction Changes/);
  assert.match(markdown, /Top Actions/);
  assert.match(markdown, /Evidence/);
  assert.doesNotMatch(markdown, /Create These Artifacts/);
  assert.match(markdown, /Estimated enterprise API savings/);
  assert.match(markdown, /Why this artifact/);
  assert.match(markdown, /Prompt Quality/);
});

test("buildCoachingPrompt asks for actionable coaching schema", () => {
  const stats = analyzeRows([{ cwd: "/tmp/codex-insights", content: "missing verification caused retry" }]);
  const prompt = buildCoachingPrompt(stats, []);

  assert.match(prompt, /engineering coach/);
  assert.match(prompt, /frictionAnalysis/);
  assert.match(prompt, /promptQuality/);
  assert.match(prompt, /Coaching Targets/);
  assert.match(prompt, /effectivenessMetrics/);
  assert.match(prompt, /workflowPrompts/);
  assert.match(prompt, /actionPrompts/);
  assert.match(prompt, /skillAgentSuggestions/);
  assert.match(prompt, /rationale/);
  assert.match(prompt, /roast/);
  assert.match(prompt, /customInstructions/);
  assert.match(prompt, /Codex Settings > Custom instructions/);
});

test("mapSignalToArtifact explains durable artifact placement", () => {
  assert.deepEqual(mapSignalToArtifact("prompt quality needs clearer constraints").artifact, "custom instructions");
  assert.deepEqual(mapSignalToArtifact("auth secret verification rule", "portal").artifact, "AGENTS.md rule");
  assert.match(mapSignalToArtifact("rerun validation command loop").rationale, /script|command/i);
});

test("parseCodexJsonOutput extracts JSON from event streams", () => {
  const output = [
    JSON.stringify({ type: "started" }),
    JSON.stringify({ output: '```json\\n{"summary":"ok","improvements":[],"instructions":[],"prompts":[]}\\n```' }),
  ].join("\n");

  const parsed = parseCodexJsonOutput(output);

  assert.equal(parsed.summary, "ok");
});

test("parseCodexJsonOutput extracts nested codex item text", () => {
  const output = [
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: '{"summary":"nested","improvements":[],"instructions":[],"prompts":[]}',
      },
    }),
  ].join("\n");

  const parsed = parseCodexJsonOutput(output);

  assert.equal(parsed.summary, "nested");
});

test("loadInputs handles missing memory and malformed jsonl", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-insights-test-"));
  mkdirSync(join(root, "sessions", "2026", "05"), { recursive: true });
  writeFileSync(join(root, "history.jsonl"), '{"cwd":"/tmp/codex-insights"}\n');
  writeFileSync(join(root, "sessions", "2026", "05", "rollout.jsonl"), '{"cwd":"/tmp/portal"}\nnope\n');

  const inputs = loadInputs(root);

  assert.equal(inputs.rows.length, 2);
  assert.equal(inputs.malformedRows, 1);
  assert.equal(inputs.memoryText, "");
});

test("readJsonlTail reads only the bounded tail of large jsonl files", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-insights-tail-"));
  const path = join(root, "large.jsonl");
  writeFileSync(path, '{"i":1}\n{"i":2}\n{"i":3}\n');

  const text = readJsonlTail(path, 10);

  assert.match(text, /\{"i":3\}/);
  assert.doesNotMatch(text, /\{"i":1\}/);
});

test("writeReport writes default HTML to codex-insights.html in outputDir", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-insights-output-dir-"));
  const inputs = { rows: [{ cwd: "/tmp/codex-insights", content: "ok" }], malformedRows: 0, memoryText: "", jsonlFiles: [] };
  const report = buildReport(inputs, { days: 7, includeMemory: false, useAi: false });
  const output = writeReport(report, { outputDir: root });

  assert.equal(output, join(root, "codex-insights.html"));
  assert.equal(existsSync(output), true);
});

test("writeReport keeps canonical HTML filename even when output path is supplied", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-insights-html-output-"));
  const inputs = { rows: [{ cwd: "/tmp/codex-insights", content: "ok" }], malformedRows: 0, memoryText: "", jsonlFiles: [] };
  const report = buildReport(inputs, { days: 7, includeMemory: false, useAi: false });
  const output = writeReport(report, {
    exportFormat: "html",
    output: join(root, "custom-name.html"),
  });

  assert.equal(output, join(root, "codex-insights.html"));
  assert.equal(existsSync(output), true);
});

test("writeReport exports markdown to the requested path", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-insights-export-"));
  const inputs = { rows: [{ cwd: "/tmp/codex-insights", content: "ok" }], malformedRows: 0, memoryText: "", jsonlFiles: [] };
  const report = buildReport(inputs, { days: 7, includeMemory: false, useAi: false });
  const output = writeReport(report, {
    exportFormat: "markdown",
    output: join(root, "report.md"),
  });

  assert.equal(output, join(root, "report.md"));
});

test("cleanupOldTempReports removes stale report directories", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-insights-cleanup-"));
  const stale = join(root, "stale");
  mkdirSync(stale);

  const removed = cleanupOldTempReports(root, Date.now() + 72 * 60 * 60 * 1000);

  assert.equal(removed, 1);
});

test("parseArgs supports plan options", () => {
  const options = parseArgs(["--days", "30", "--no-memory", "--export", "json", "--output-dir", "/tmp/reports", "--no-open", "--no-ai"]);

  assert.equal(options.days, 30);
  assert.equal(options.includeMemory, false);
  assert.equal(options.exportFormat, "json");
  assert.equal(options.outputDir, "/tmp/reports");
  assert.equal(options.open, false);
  assert.equal(options.useAi, false);
});

test("Coach's Read skill preserves the required coaching contract", () => {
  const skill = readFileSync("skills/coachs-read/SKILL.md", "utf8");

  assert.match(skill, /precomputed Codex session metrics/);
  assert.match(skill, /Do not read raw Codex session JSONL/);
  assert.match(skill, /Do not infer identities, private context, root causes, dates, costs, or behavioral patterns/);
  for (const section of [
    "Friction Coaching",
    "Custom Instructions",
    "Workflow Prompts",
    "Action Prompts",
    "Skill/Agent Suggestions",
    "Effectiveness Metrics",
  ]) {
    assert.match(skill, new RegExp(section.replace("/", "\\/")));
  }
  assert.match(skill, /Label proxy metrics honestly/);
});
