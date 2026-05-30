import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { parseCommandArgvJson } from "../plugins/agent-workflow-roast/scripts/agent-workflow-roast-command.mjs";
import {
  analyzeRows,
  applyVoiceContract,
  applySessionCwd,
  buildRecommendations,
  buildCoachingPrompt,
  buildEditorPrompt,
  buildDeterministicInsights,
  buildReport,
  buildSignals,
  cleanupOldTempReports,
  collectSessionFiles,
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
} from "../plugins/agent-workflow-roast/scripts/agent-workflow-roast.mjs";

process.env.AGENT_WORKFLOW_ROAST_NO_AI = "1";

function sectionText(html, id) {
  const match = html.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`));
  return (match?.[0] || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

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

test("redactSecrets catches JWTs DSNs provider tokens and multiline sensitive values", () => {
  const jwt = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFjZSJ9",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ].join(".");
  const providerToken = ["sk", "proj", "abc1234567890abcdef"].join("-");
  const slackToken = ["xoxb", "1234567890", "1234567890", "abcdefghijklmnopqrstuvwx"].join("-");
  const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  const input = [
    `standalone jwt ${jwt}`,
    "DATABASE_URL=postgres://user:secret-pass@db.internal.example/app",
    `provider tokens ${providerToken} ${slackToken} ${awsKey}`,
    "client_secret: |\n  first-sensitive-line\n  second-sensitive-line",
  ].join("\n");

  const redacted = redactSecrets(input);

  assert.equal(redacted.includes(jwt), false);
  assert.equal(redacted.includes(providerToken), false);
  assert.equal(redacted.includes(slackToken), false);
  assert.equal(redacted.includes(awsKey), false);
  assert.doesNotMatch(redacted, /secret-pass|first-sensitive-line|second-sensitive-line/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("analyzeRows groups projects, tools, and friction markers", () => {
  const rows = [
    {
      timestamp: new Date().toISOString(),
      cwd: "/Users/acedergr/Documents/agent-workflow-roast",
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
  assert.equal(stats.projects[0].name, "agent-workflow-roast");
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
      { timestamp: new Date().toISOString(), cwd: "/tmp/agent-workflow-roast", content: "build error in package step" },
      { timestamp: new Date().toISOString(), cwd: "/tmp/agent-workflow-roast", content: "failed action needs logs" },
      { timestamp: new Date().toISOString(), cwd: "/tmp/agent-workflow-roast", content: "failure after rerun" },
      { timestamp: new Date().toISOString(), cwd: "/tmp/agent-workflow-roast", content: "auth token check without values" },
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
      { timestamp: new Date().toISOString(), cwd: "/tmp/agent-workflow-roast", content: "build error in package step" },
      { timestamp: new Date().toISOString(), cwd: "/tmp/agent-workflow-roast", content: "failed action needs logs" },
      { timestamp: new Date().toISOString(), cwd: "/tmp/agent-workflow-roast", content: "failure after rerun" },
      { timestamp: new Date().toISOString(), cwd: "/tmp/agent-workflow-roast", content: "auth token check without values" },
    ],
    { days: 30 },
  );
  const signals = buildSignals(stats);
  const insights = buildDeterministicInsights(stats, []);

  insights.actionPrompts = [
    {
      title: "Create failure triage",
      artifact: "script",
      target: "agent-workflow-roast",
      rationale: "Repeated failures need one command path.",
      prompt: "Inspect this project first: read AGENTS.md, git status, package scripts, and CI logs. Create a failure triage script and run validation.",
    },
    {
      title: "Create failure triage script",
      artifact: "script",
      target: "agent-workflow-roast",
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
      body: "Run npm test and inspect /Users/acedergr/Documents/agent-workflow-roast before editing.",
    },
  });

  assert.doesNotMatch(result.value.summary, /pivotal|landscape|leverage/i);
  assert.match(result.value.nested.body, /npm test/);
  assert.match(result.value.nested.body, /\/Users\/acedergr\/Documents\/agent-workflow-roast/);
  assert.ok(result.review.rewrites.length >= 1);
});

test("buildReport exposes signals recommendations and voice review with deterministic fallback", () => {
  const report = buildReport(
    {
      rows: [
        { timestamp: new Date().toISOString(), cwd: "/tmp/agent-workflow-roast", content: "build error in package step" },
        { timestamp: new Date().toISOString(), cwd: "/tmp/agent-workflow-roast", content: "failed action needs logs" },
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
      cwd: "/tmp/agent-workflow-roast",
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
      cwd: "/tmp/agent-workflow-roast",
      content: "Token usage: 7.49K total (7.38K input + 105 output)",
    },
  ]);

  assert.equal(stats.tokenSpend.measured, 7490);
  assert.equal(stats.tokenSpend.actual.input, 7380);
  assert.equal(stats.tokenSpend.actual.output, 105);
});

test("applySessionCwd carries session cwd into later rows", () => {
  const rows = applySessionCwd([
    { type: "session_meta", payload: { cwd: "/Users/acedergr/Documents/agent-workflow-roast" } },
    { type: "response_item", content: "continued work" },
  ]);

  const stats = analyzeRows(rows, { days: 30 });

  assert.equal(stats.projects[0].name, "agent-workflow-roast");
  assert.equal(stats.projects[0].count, 2);
});

test("selectMemoryHits returns project-related memory context", () => {
  const memory = ["# Memory", "agent-workflow-roast should prefer ephemeral reports", "other line"].join("\n");
  const hits = selectMemoryHits(memory, [{ name: "agent-workflow-roast", count: 2 }]);

  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
});

test("renderers include required report sections", () => {
  const stats = analyzeRows([
    {
      timestamp: new Date().toISOString(),
      cwd: "/tmp/agent-workflow-roast",
      content: "blocked retry",
    },
  ]);
  const signals = buildSignals(stats);
  const insights = buildDeterministicInsights(stats, []);
  const recommendations = buildRecommendations(stats, insights, signals);
  insights.recommendations = recommendations;
  const report = {
    title: "Agent Workflow Roast",
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
  assert.match(html, /Do first/);
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

test("Good Bad Ugly cards do not repeat Coach's Read text verbatim", () => {
  const stats = analyzeRows([
    { timestamp: new Date().toISOString(), cwd: "/tmp/agent-workflow-roast", content: "blocked retry missing proof" },
  ]);
  const signals = buildSignals(stats);
  const insights = buildDeterministicInsights(stats, []);
  const recommendations = buildRecommendations(stats, insights, signals);
  insights.recommendations = recommendations;
  const html = renderHtml({
    title: "Agent Workflow Roast",
    stats,
    memoryHits: [],
    signals,
    recommendations,
    voiceReview: applyVoiceContract(insights).review,
    insights,
  });
  const goodBadUgly = sectionText(html, "good-bad-ugly");
  const coachRead = sectionText(html, "coach-s-read");

  assert.equal(coachRead.includes(insights.roast), true);
  for (const repeated of [
    insights.atAGlance.working,
    insights.atAGlance.hindering,
    insights.atAGlance.quickWins,
    insights.atAGlance.ambitious,
    insights.roast,
  ]) {
    assert.equal(goodBadUgly.includes(repeated), false, repeated);
  }
  assert.match(goodBadUgly, /Roast stays valid|repeat archaeology/);
  assert.equal(coachRead.includes("Roast stays valid"), false);
});

test("buildCoachingPrompt asks for actionable coaching schema", () => {
  const stats = analyzeRows([{ cwd: "/tmp/agent-workflow-roast", content: "missing verification caused retry" }]);
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
  assert.match(prompt, /System prompt for Agent Workflow Roast synthesis/);
  assert.match(prompt, /Humanizer skill guidance/);
  assert.match(prompt, /Do not merely delete AI phrases/);
  assert.match(prompt, /rule-of-three addiction/);
  assert.match(prompt, /technical coaching report/);
});

test("buildEditorPrompt includes humanizer system guidance", () => {
  const stats = analyzeRows([{ cwd: "/tmp/agent-workflow-roast", content: "failed retry missing verification" }]);
  const signals = buildSignals(stats);
  const insights = buildDeterministicInsights(stats, []);
  const recommendations = buildRecommendations(stats, insights, signals);
  const prompt = buildEditorPrompt(insights, signals, recommendations);

  assert.match(prompt, /System prompt for Agent Workflow Roast humanizer\/editor pass/);
  assert.match(prompt, /Humanizer skill guidance/);
  assert.match(prompt, /Inject a clear human voice/);
  assert.match(prompt, /Preserve exact commands, file paths, artifact types, JSON keys, and safety-critical wording/);
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
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-roast-test-"));
  mkdirSync(join(root, "sessions", "2026", "05", "29"), { recursive: true });
  writeFileSync(join(root, "history.jsonl"), '{"cwd":"/tmp/agent-workflow-roast"}\n');
  writeFileSync(join(root, "sessions", "2026", "05", "29", "rollout.jsonl"), '{"cwd":"/tmp/portal"}\nnope\n');

  const inputs = loadInputs(root);

  assert.equal(inputs.rows.length, 2);
  assert.equal(inputs.malformedRows, 1);
  assert.equal(inputs.memoryText, "");
});

test("loadInputs only reads the expected dated session layout", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-roast-layout-"));
  mkdirSync(join(root, "sessions", "2026", "05", "29"), { recursive: true });
  mkdirSync(join(root, "sessions", "not-a-date", "deep", "tree"), { recursive: true });
  writeFileSync(join(root, "sessions", "2026", "05", "29", "rollout.jsonl"), '{"cwd":"/tmp/dated"}\n');
  writeFileSync(join(root, "sessions", "not-a-date", "deep", "tree", "ignored.jsonl"), '{"cwd":"/tmp/ignored"}\n');

  const inputs = loadInputs(root, { days: 3650 });

  assert.equal(inputs.jsonlFiles.length, 1);
  assert.equal(inputs.jsonlFiles[0], join(root, "sessions", "2026", "05", "29", "rollout.jsonl"));
  assert.equal(inputs.rows[0].cwd, "/tmp/dated");
});

test("collectSessionFiles caps dated session file results", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-roast-session-cap-"));
  const day = join(root, "sessions", "2026", "05", "29");
  mkdirSync(day, { recursive: true });
  for (let index = 0; index < 250; index += 1) {
    writeFileSync(join(day, `rollout-${String(index).padStart(3, "0")}.jsonl`), '{"cwd":"/tmp/capped"}\n');
  }

  const files = collectSessionFiles(join(root, "sessions"), { cutoffMs: 0 });

  assert.equal(files.length, 200);
});

test("readJsonlTail reads only the bounded tail of large jsonl files", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-roast-tail-"));
  const path = join(root, "large.jsonl");
  writeFileSync(path, '{"i":1}\n{"i":2}\n{"i":3}\n');

  const text = readJsonlTail(path, 10);

  assert.match(text, /\{"i":3\}/);
  assert.doesNotMatch(text, /\{"i":1\}/);
});

test("writeReport writes default HTML to agent-workflow-roast.html in outputDir", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-roast-output-dir-"));
  const inputs = { rows: [{ cwd: "/tmp/agent-workflow-roast", content: "ok" }], malformedRows: 0, memoryText: "", jsonlFiles: [] };
  const report = buildReport(inputs, { days: 7, includeMemory: false, useAi: false });
  const output = writeReport(report, { outputDir: root });

  assert.equal(output, join(root, "agent-workflow-roast.html"));
  assert.equal(existsSync(output), true);
});

test("writeReport keeps canonical HTML filename even when output path is supplied", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-roast-html-output-"));
  const inputs = { rows: [{ cwd: "/tmp/agent-workflow-roast", content: "ok" }], malformedRows: 0, memoryText: "", jsonlFiles: [] };
  const report = buildReport(inputs, { days: 7, includeMemory: false, useAi: false });
  const output = writeReport(report, {
    exportFormat: "html",
    output: join(root, "custom-name.html"),
  });

  assert.equal(output, join(root, "agent-workflow-roast.html"));
  assert.equal(existsSync(output), true);
});

test("writeReport refuses hidden home output directories", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-workflow-roast-home-"));
  const inputs = { rows: [{ cwd: "/tmp/agent-workflow-roast", content: "ok" }], malformedRows: 0, memoryText: "", jsonlFiles: [] };
  const report = buildReport(inputs, { days: 7, includeMemory: false, useAi: false });

  assert.throws(
    () => writeReport(report, { outputDir: join(home, ".ssh"), homeDir: home }),
    /Refusing to write report inside hidden home directory/,
  );
  assert.equal(existsSync(join(home, ".ssh", "agent-workflow-roast.html")), false);
});

test("writeReport refuses hidden files in the home directory", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-workflow-roast-home-file-"));
  const inputs = { rows: [{ cwd: "/tmp/agent-workflow-roast", content: "ok" }], malformedRows: 0, memoryText: "", jsonlFiles: [] };
  const report = buildReport(inputs, { days: 7, includeMemory: false, useAi: false });

  assert.throws(
    () =>
      writeReport(report, {
        exportFormat: "markdown",
        output: join(home, ".zshrc"),
        homeDir: home,
      }),
    /Refusing to write report to hidden home file/,
  );
});

test("slash command uses argv wrapper instead of shell-interpolating raw arguments", () => {
  const command = readFileSync("plugins/agent-workflow-roast/commands/roast.md", "utf8");

  assert.doesNotMatch(command, /node\s+scripts\/agent-workflow-roast\.mjs\s+\$ARGUMENTS/);
  assert.match(command, /AGENT_WORKFLOW_ROAST_ARGV_JSON/);
  assert.match(command, /Never paste raw `\$ARGUMENTS` into a shell command/);
});

test("command wrapper passes parsed arguments as argv without shell interpretation", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-roast-command-"));
  const codexHome = join(root, "codex-home");
  const outputDir = join(root, "reports; touch pwned");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "history.jsonl"), '{"cwd":"/tmp/agent-workflow-roast","content":"ok"}\n');

  const result = spawnSync(process.execPath, ["plugins/agent-workflow-roast/scripts/agent-workflow-roast-command.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_WORKFLOW_ROAST_OUTPUT_DIR: outputDir,
      AGENT_WORKFLOW_ROAST_ARGV_JSON: JSON.stringify(["--days", "1", "--no-ai", "--no-open", "--codex-home", codexHome]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, "pwned")), false);
  assert.equal(existsSync(join(outputDir, "agent-workflow-roast.html")), true);
});

test("parseCommandArgvJson accepts only a JSON array of strings", () => {
  assert.deepEqual(parseCommandArgvJson('["--days","7","--no-ai"]'), ["--days", "7", "--no-ai"]);
  assert.throws(() => parseCommandArgvJson('{"days":7}'), /JSON array of strings/);
  assert.throws(() => parseCommandArgvJson('["--days",7]'), /JSON array of strings/);
});

test("each run remeasures token spend from current input files", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "agent-workflow-roast-remeasure-home-"));
  const outputDir = mkdtempSync(join(tmpdir(), "agent-workflow-roast-remeasure-out-"));
  const historyPath = join(codexHome, "history.jsonl");
  const writeHistory = (input, output) => {
    writeFileSync(
      historyPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        cwd: "/tmp/agent-workflow-roast",
        content: "verification token measurement",
        usage: { input_tokens: input, output_tokens: output },
      })}\n`,
    );
  };
  const runReport = () => {
    const inputs = loadInputs(codexHome, { days: 7 });
    const report = buildReport(inputs, { days: 7, includeMemory: false, useAi: false });
    const output = writeReport(report, { outputDir });
    return { output, report, html: readFileSync(output, "utf8") };
  };

  writeHistory(1000, 500);
  const first = runReport();
  writeHistory(4000, 1000);
  const second = runReport();

  assert.equal(first.output, join(outputDir, "agent-workflow-roast.html"));
  assert.equal(second.output, first.output);
  assert.equal(first.report.stats.tokenSpend.actual.total, 1500);
  assert.equal(second.report.stats.tokenSpend.actual.total, 5000);
  assert.match(first.html, /1,500/);
  assert.match(second.html, /5,000/);
});

test("writeReport exports markdown to the requested path", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-roast-export-"));
  const inputs = { rows: [{ cwd: "/tmp/agent-workflow-roast", content: "ok" }], malformedRows: 0, memoryText: "", jsonlFiles: [] };
  const report = buildReport(inputs, { days: 7, includeMemory: false, useAi: false });
  const output = writeReport(report, {
    exportFormat: "markdown",
    output: join(root, "report.md"),
  });

  assert.equal(output, join(root, "report.md"));
});

test("cleanupOldTempReports removes stale report directories", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-roast-cleanup-"));
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

test("parseArgs defaults to a rolling 7-day window", () => {
  const options = parseArgs(["--no-open", "--no-ai"]);

  assert.equal(options.days, 7);
});

test("marketplace catalog points at the installable plugin package", () => {
  const marketplace = JSON.parse(readFileSync(".agents/plugins/marketplace.json", "utf8"));
  const plugin = marketplace.plugins.find((entry) => entry.name === "agent-workflow-roast");

  assert.equal(plugin?.source?.path, "./plugins/agent-workflow-roast");
  assert.equal(existsSync("plugins/agent-workflow-roast/.codex-plugin/plugin.json"), true);
  assert.equal(existsSync("plugins/agent-workflow-roast/commands/roast.md"), true);
  assert.equal(existsSync("plugins/agent-workflow-roast/scripts/agent-workflow-roast.mjs"), true);
  assert.equal(existsSync("plugins/agent-workflow-roast/skills/roast/SKILL.md"), true);
  assert.equal(existsSync("plugins/agent-workflow-roast/skills/coachs-read/SKILL.md"), false);
});

test("roast skill handles precomputed report coaching without reading raw sessions", () => {
  const skill = readFileSync("plugins/agent-workflow-roast/skills/roast/SKILL.md", "utf8");

  assert.match(skill, /precomputed metrics and redacted report content/);
  assert.match(skill, /Do not read raw session JSONL/);
});
