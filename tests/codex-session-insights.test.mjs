import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeRows,
  applySessionCwd,
  buildCoachingPrompt,
  buildDeterministicInsights,
  buildReport,
  cleanupOldTempReports,
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
  ];

  const stats = analyzeRows(rows, { days: 30 });

  assert.equal(stats.totalRows, 2);
  assert.equal(stats.projects[0].name, "codex-insights");
  assert.equal(stats.tools.find((item) => item.name === "exec_command").count, 1);
  assert.ok(stats.friction.some((item) => item.name === "failed"));
  assert.equal(stats.tokenSpend.actual.total >= 1400, true);
  assert.equal(stats.tokenSpend.daily.length >= 1, true);
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
  const report = {
    title: "Codex Session Insights (14 days)",
    stats,
    memoryHits: [],
    insights: buildDeterministicInsights(stats, []),
  };

  const html = renderHtml(report);
  const markdown = renderMarkdown(report);

  assert.match(html, /Coaching targets/);
  assert.match(html, /Top Improvements/);
  assert.match(html, /Good \/ Bad \/ Ugly/);
  assert.match(html, /Coaching Targets/);
  assert.match(html, /token spend scenario/);
  assert.match(html, /API cost delta/);
  assert.match(html, /Coach&#39;s Read/);
  assert.match(html, /Custom Instructions/);
  assert.match(html, /Create These Artifacts/);
  assert.match(html, /Why this artifact/);
  assert.match(markdown, /Project Workflow Prompts/);
  assert.match(markdown, /Create These Artifacts/);
  assert.match(markdown, /Estimated enterprise API savings/);
  assert.match(markdown, /Why this artifact/);
  assert.match(markdown, /Prompt Quality/);
  assert.match(markdown, /Codex Settings &gt; Custom instructions|Codex Settings > Custom instructions/);
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

test("writeReport exports durable markdown only when requested", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-insights-export-"));
  const inputs = { rows: [{ cwd: "/tmp/codex-insights", content: "ok" }], malformedRows: 0, memoryText: "", jsonlFiles: [] };
  const report = buildReport(inputs, { days: 7, includeMemory: false });
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
  const options = parseArgs(["--days", "30", "--no-memory", "--export", "json", "--no-open", "--no-ai"]);

  assert.equal(options.days, 30);
  assert.equal(options.includeMemory, false);
  assert.equal(options.exportFormat, "json");
  assert.equal(options.open, false);
  assert.equal(options.useAi, false);
});
