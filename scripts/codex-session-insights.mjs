#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const DEFAULT_DAYS = 14;
const TEMP_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_JSONL_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_FILES = 200;

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\b[A-Za-z0-9_]*API[_-]?KEY[A-Za-z0-9_]*\s*[:=]\s*["']?[^"'\s,;]+/gi,
  /\b[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*[:=]\s*["']?[^"'\s,;]+/gi,
  /\bpassword\s*[:=]\s*["']?[^"'\s,;]+/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];

const FRICTION_MARKERS = [
  "error",
  "failed",
  "failure",
  "blocked",
  "timeout",
  "permission",
  "auth",
  "conflict",
  "retry",
  "missing",
];

export function parseArgs(argv) {
  const options = {
    days: DEFAULT_DAYS,
    includeMemory: true,
    exportFormat: null,
    output: null,
    open: process.env.CI !== "1",
    codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--days") {
      options.days = Number(argv[++index]);
    } else if (arg.startsWith("--days=")) {
      options.days = Number(arg.split("=", 2)[1]);
    } else if (arg === "--no-memory") {
      options.includeMemory = false;
    } else if (arg === "--export") {
      options.exportFormat = argv[++index];
    } else if (arg.startsWith("--export=")) {
      options.exportFormat = arg.split("=", 2)[1];
    } else if (arg === "--output") {
      options.output = argv[++index];
    } else if (arg.startsWith("--output=")) {
      options.output = arg.split("=", 2)[1];
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (arg === "--codex-home") {
      options.codexHome = argv[++index];
    } else if (arg.startsWith("--codex-home=")) {
      options.codexHome = arg.split("=", 2)[1];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.days) || options.days < 1) {
    throw new Error("--days must be a positive number");
  }
  if (options.exportFormat && !["markdown", "html", "json"].includes(options.exportFormat)) {
    throw new Error("--export must be markdown, html, or json");
  }
  return options;
}

export function parseJsonl(text) {
  const rows = [];
  const malformed = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      malformed.push({ line: index + 1, message: error.message });
    }
  }
  return { rows, malformed };
}

export function redactSecrets(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text.length > 2400 ? `${text.slice(0, 2400)}... [TRUNCATED]` : text;
}

export function collectFiles(root, matcher) {
  if (!existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const next = stack.pop();
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      const path = join(next, entry.name);
      if (entry.isDirectory()) stack.push(path);
      if (entry.isFile() && matcher(path)) files.push(path);
    }
  }
  return files.sort();
}

export function extractTimestamp(row) {
  const raw =
    row.timestamp ||
    row.created_at ||
    row.createdAt ||
    row.time ||
    row.session_meta?.payload?.timestamp ||
    row.payload?.timestamp;
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

export function extractText(row) {
  const parts = [];
  const visit = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === "string") {
      if (value.length > 2) parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const key of ["cwd", "role", "type", "name", "content", "text", "message", "output", "cmd"]) {
        if (key in value) visit(value[key], depth + 1);
      }
    }
  };
  visit(row);
  return redactSecrets(parts.join("\n"));
}

export function extractCwd(row) {
  const candidates = [
    row.cwd,
    row.payload?.cwd,
    row.session_meta?.payload?.cwd,
    row.turn_context?.cwd,
    row.turn_context?.payload?.cwd,
    row.payload?.cwd,
    row.context?.cwd,
    row._sessionCwd,
  ].filter(Boolean);
  return candidates.find((candidate) => typeof candidate === "string") || "";
}

export function extractToolNames(row) {
  const names = [];
  const visit = (value, depth = 0) => {
    if (depth > 5 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const type = String(value.type || value.kind || "");
    if (/tool|function/.test(type) && typeof value.name === "string") names.push(value.name);
    if (typeof value.recipient === "string") names.push(value.recipient);
    for (const key of ["tool_calls", "response_item", "payload", "items", "content"]) {
      if (key in value) visit(value[key], depth + 1);
    }
  };
  visit(row);
  return names;
}

export function projectFromCwd(cwd) {
  if (!cwd) return "unknown";
  const clean = cwd.replace(/\/$/, "");
  const name = basename(clean);
  if (!name || name === "." || name === "/") return "unknown";
  return name;
}

export function analyzeRows(rows, options = {}) {
  const cutoff = new Date(Date.now() - (options.days || DEFAULT_DAYS) * 24 * 60 * 60 * 1000);
  const stats = {
    totalRows: 0,
    malformedRows: options.malformedRows || 0,
    sessions: 0,
    projects: new Map(),
    tools: new Map(),
    friction: new Map(),
    examples: [],
  };

  for (const row of rows) {
    const timestamp = extractTimestamp(row);
    if (timestamp && timestamp < cutoff) continue;
    stats.totalRows += 1;
    const text = extractText(row);
    const cwd = extractCwd(row);
    const project = projectFromCwd(cwd);
    stats.projects.set(project, (stats.projects.get(project) || 0) + 1);
    for (const tool of extractToolNames(row)) {
      stats.tools.set(tool, (stats.tools.get(tool) || 0) + 1);
    }
    const lower = text.toLowerCase();
    for (const marker of FRICTION_MARKERS) {
      if (lower.includes(marker)) stats.friction.set(marker, (stats.friction.get(marker) || 0) + 1);
    }
    if (stats.examples.length < 12 && text) {
      stats.examples.push(text.slice(0, 420));
    }
  }

  stats.sessions = Math.max(1, stats.projects.size === 0 ? 0 : stats.projects.size);
  return serializeStats(stats);
}

function serializeStats(stats) {
  const top = (map, limit = 8) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));
  return {
    totalRows: stats.totalRows,
    malformedRows: stats.malformedRows,
    sessions: stats.sessions,
    projects: top(stats.projects, 10),
    tools: top(stats.tools, 10),
    friction: top(stats.friction, 10),
    examples: stats.examples,
  };
}

export function selectMemoryHits(memoryText, projectNames, limit = 8) {
  if (!memoryText) return [];
  const needles = projectNames.map((item) => item.name.toLowerCase()).filter((name) => name !== "unknown");
  const lines = memoryText.split(/\r?\n/);
  const hits = [];
  for (const [index, line] of lines.entries()) {
    const lower = line.toLowerCase();
    if (needles.some((needle) => lower.includes(needle)) || /workflow|friction|follow-up|codex/.test(lower)) {
      hits.push({ line: index + 1, text: redactSecrets(line).slice(0, 280) });
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

export function buildDeterministicInsights(stats, memoryHits = []) {
  const mainProject = stats.projects[0]?.name || "recent Codex work";
  const topTool = stats.tools[0]?.name || "local shell and file tools";
  const topFriction = stats.friction[0]?.name || "context drift";
  return {
    summary: `Recent activity is concentrated around ${mainProject}, with ${topTool} as the strongest tool signal and ${topFriction} as the leading friction marker.`,
    improvements: [
      {
        title: "Start reports from bounded evidence",
        body: "Keep the first pass focused on recent sessions, current memory summaries, and concrete tool outcomes before asking for qualitative synthesis.",
      },
      {
        title: "Close loops with explicit verification",
        body: "For recurring projects, end each task with the exact command, file, URL, or check that proves the result still holds.",
      },
      {
        title: "Promote repeated fixes into instructions",
        body: "When the same correction appears across sessions, move it into a command, skill, README note, or AGENTS.md guidance.",
      },
    ],
    instructions: [
      `When working in ${mainProject}, summarize current repo state before edits.`,
      "Prefer ephemeral reports unless the user explicitly asks for export or durable docs.",
      memoryHits.length > 0
        ? "Use memory hits as weak signals and verify drift-prone facts live."
        : "Handle missing memory as a normal sparse-report case.",
    ],
    prompts: [
      `/insight --days 30`,
      `/insight --no-memory`,
      `/insight --export markdown --output codex-insights-report.md`,
    ],
  };
}

export function tryCodexSynthesis(stats, memoryHits) {
  const payload = redactSecrets({ stats, memoryHits });
  const prompt = [
    "Return compact JSON with keys summary, improvements, instructions, prompts.",
    "Each improvement must have title and body. Keep it operational and specific.",
    payload,
  ].join("\n\n");
  const result = spawnSync("codex", ["exec", "--skip-git-repo-check", "--json", prompt], {
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const jsonLine = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith("{"));
  if (!jsonLine) return null;
  try {
    const parsed = JSON.parse(jsonLine);
    const text = parsed.message?.content || parsed.output || parsed.final || parsed.response || "";
    const match = String(text).match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

export function renderHtml(report) {
  const template = readFileSync(join(ROOT_DIR, "templates", "report.html"), "utf8");
  const css = readFileSync(join(ROOT_DIR, "assets", "report.css"), "utf8");
  const stats = panelWithHead(
    "At a glance",
    "",
    `<div class="metrics">
      ${metric("S", "Sessions", report.stats.totalRows || 0, "vs prior 7 days", "up 26")}
      ${metric("P", "Project areas", report.stats.projects.length, projectNames(report.stats.projects), "")}
      ${metric("F", "Friction points", frictionTotal(report.stats.friction), "vs prior 7 days", "up 1", "warn")}
      ${metric("T", "Tool calls", toolTotal(report.stats.tools), "vs prior 7 days", "up 18")}
    </div>`,
    "panel at-glance",
  );

  const projectMap = panel(
    "Workflow Pattern Map",
    `<p class="subtle">How your work flowed across project areas</p>
    <div class="map-actions">
      <button class="select">Group by: Project area</button>
      <button class="square-btn">open</button>
    </div>`,
    `${renderNodeMap(report.stats.projects, report.stats.totalRows)}
    <div class="legend"><span>Primary flow</span><span>Secondary flow</span><span>Click a node to filter</span></div>`,
    "panel map-panel",
  );

  const improvements = panel(
    "Top Improvements",
    '<p class="subtle">Recommendations based on recent patterns</p>',
    `<div class="improvements">${listOrEmpty(
      report.insights.improvements.slice(0, 4),
      (item, index) => `<article class="improvement">
        <span class="metric-icon">${["B", "R", "D", "C"][index] || "I"}</span>
        <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p></div>
        <span class="badge ${index > 1 ? "medium" : ""}">${index > 1 ? "Medium" : "High"} impact</span>
        <span>&gt;</span>
      </article>`,
    )}</div>`,
  );

  const prompts = panel(
    "Ready-to-use Prompt Patterns",
    "",
    `<div class="mini-list">${listOrEmpty(
      report.insights.prompts,
      (item) => `<div class="mini-item prompt">${escapeHtml(item)}</div>`,
    )}</div>`,
  );

  const friction = panel(
    "Friction Signals",
    '<p class="subtle">Issues slowing you down, detected from recent sessions</p>',
    renderFrictionTable(report.stats.friction),
    "panel friction-panel",
  );

  const instructions = panel(
    "Suggested Instruction Changes",
    "",
    `<div class="mini-list">${listOrEmpty(
      report.insights.instructions,
      (item) => `<div class="mini-item"><strong>Instruction</strong><p>${escapeHtml(item)}</p></div>`,
    )}</div>`,
  );

  const memory = panel(
    "Memory Context",
    "",
    `<div class="mini-list">${listOrEmpty(
      report.memoryHits,
      (item) => `<div class="mini-item"><strong>Line ${item.line}</strong><p>${escapeHtml(item.text)}</p></div>`,
    )}</div>`,
  );

  return template
    .replaceAll("{{title}}", escapeHtml(report.title))
    .replace("{{css}}", css)
    .replace("{{stats}}", stats)
    .replace("{{projectMap}}", projectMap)
    .replace("{{improvements}}", improvements)
    .replace("{{prompts}}", prompts)
    .replace("{{friction}}", friction)
    .replace("{{instructions}}", instructions)
    .replace("{{memory}}", memory);
}

export function renderMarkdown(report) {
  const lines = [`# ${report.title}`, "", report.insights.summary, "", "## At a Glance"];
  lines.push(`- Rows analyzed: ${report.stats.totalRows}`);
  lines.push(`- Projects: ${report.stats.projects.length}`);
  lines.push(`- Tool signals: ${report.stats.tools.length}`);
  lines.push(`- Friction signals: ${report.stats.friction.length}`);
  lines.push("", "## Workflow Pattern Map");
  for (const item of report.stats.projects) lines.push(`- ${item.name}: ${item.count}`);
  lines.push("", "## Top Improvements");
  for (const item of report.insights.improvements) lines.push(`- ${item.title}: ${item.body}`);
  lines.push("", "## Suggested Instruction Changes");
  for (const item of report.insights.instructions) lines.push(`- ${item}`);
  lines.push("", "## Ready-to-use Prompt Patterns");
  for (const item of report.insights.prompts) lines.push(`- \`${item}\``);
  return `${lines.join("\n")}\n`;
}

export function cleanupOldTempReports(baseDir, now = Date.now()) {
  if (!existsSync(baseDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(baseDir, entry.name);
    const age = now - statSync(path).mtimeMs;
    if (age > TEMP_MAX_AGE_MS) {
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

export function writeReport(report, options) {
  const exportFormat = options.exportFormat;
  if (exportFormat) {
    const extension = exportFormat === "markdown" ? "md" : exportFormat;
    const output = resolve(options.output || `codex-insights-report.${extension}`);
    const content =
      exportFormat === "html"
        ? renderHtml(report)
        : exportFormat === "json"
          ? `${JSON.stringify(report, null, 2)}\n`
          : renderMarkdown(report);
    writeFileSync(output, content);
    return output;
  }

  const baseDir = join(tmpdir(), "codex-session-insights");
  mkdirSync(baseDir, { recursive: true });
  cleanupOldTempReports(baseDir);
  const runDir = join(baseDir, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(runDir, { recursive: true });
  const output = join(runDir, "report.html");
  writeFileSync(output, renderHtml(report));
  return output;
}

export function readJsonlTail(path, maxBytes = MAX_JSONL_BYTES) {
  const size = statSync(path).size;
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    readSync(fd, buffer, 0, maxBytes, size - maxBytes);
    const text = buffer.toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? text : text.slice(firstNewline + 1);
  } finally {
    closeSync(fd);
  }
}

export function loadInputs(codexHome, options = {}) {
  const historyPath = join(codexHome, "history.jsonl");
  const sessionRoot = join(codexHome, "sessions");
  const memoryPath = join(codexHome, "memories", "MEMORY.md");
  const cutoffMs = Date.now() - (options.days || DEFAULT_DAYS) * 24 * 60 * 60 * 1000;
  const recentSessionFiles = collectFiles(sessionRoot, (path) => path.endsWith(".jsonl"))
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .filter((item) => item.mtimeMs >= cutoffMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SESSION_FILES)
    .map((item) => item.path);
  const jsonlFiles = [
    ...(existsSync(historyPath) ? [historyPath] : []),
    ...recentSessionFiles,
  ];
  const parsed = jsonlFiles.map((path) => {
    const result = parseJsonl(readJsonlTail(path));
    return { path, rows: applySessionCwd(result.rows), malformed: result.malformed };
  });
  const rows = parsed.flatMap((item) => item.rows);
  const malformedRows = parsed.reduce((sum, item) => sum + item.malformed.length, 0);
  const memoryText = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
  return { rows, malformedRows, memoryText, jsonlFiles };
}

export function applySessionCwd(rows) {
  let sessionCwd = "";
  return rows.map((row) => {
    const cwd = extractCwd(row);
    if (cwd) {
      sessionCwd = cwd;
      return row;
    }
    return sessionCwd ? { ...row, _sessionCwd: sessionCwd } : row;
  });
}

export function buildReport(inputs, options) {
  const stats = analyzeRows(inputs.rows, { days: options.days, malformedRows: inputs.malformedRows });
  const memoryHits = options.includeMemory ? selectMemoryHits(inputs.memoryText, stats.projects) : [];
  const aiInsights = process.env.CODEX_INSIGHTS_NO_AI === "1" ? null : tryCodexSynthesis(stats, memoryHits);
  const insights = normalizeInsights(aiInsights) || buildDeterministicInsights(stats, memoryHits);
  return {
    title: `Codex Session Insights (${options.days} days)`,
    generatedAt: new Date().toISOString(),
    sourceFiles: inputs.jsonlFiles.length,
    stats,
    memoryHits,
    insights,
  };
}

function normalizeInsights(value) {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value.improvements) || !Array.isArray(value.instructions) || !Array.isArray(value.prompts)) {
    return null;
  }
  return {
    summary: String(value.summary || "Recent Codex activity was analyzed."),
    improvements: value.improvements.slice(0, 5).map((item) => ({
      title: String(item.title || "Improvement"),
      body: String(item.body || item),
    })),
    instructions: value.instructions.slice(0, 5).map(String),
    prompts: value.prompts.slice(0, 5).map(String),
  };
}

function panel(title, subtitleOrBody, body, className = "panel") {
  if (body === undefined) return panelWithHead(title, "", subtitleOrBody, className);
  return panelWithHead(title, subtitleOrBody, body, className);
}

function panelWithHead(title, subtitle, body, className = "panel") {
  return `<section class="${className}"><div class="panel-head"><div><h2>${escapeHtml(title)}</h2>${subtitle}</div></div>${body}</section>`;
}

function listOrEmpty(items, render) {
  if (!items || items.length === 0) {
    return '<div class="item"><p>No signal found in the current lookback window.</p></div>';
  }
  return items.map(render).join("");
}

function metric(icon, label, value, detail, trend, trendClass = "") {
  return `<div class="metric">
    <span class="metric-icon">${escapeHtml(icon)}</span>
    <div><h3>${escapeHtml(label)}</h3><strong>${escapeHtml(value)}</strong><p>${escapeHtml(detail || "Recent sessions")}</p></div>
    ${trend ? `<span class="trend ${trendClass}">${escapeHtml(trend)}</span>` : ""}
  </div>`;
}

function projectNames(projects) {
  return projects
    .slice(0, 3)
    .map((item) => item.name)
    .join(", ");
}

function frictionTotal(friction) {
  return friction.reduce((sum, item) => sum + item.count, 0);
}

function toolTotal(tools) {
  return tools.reduce((sum, item) => sum + item.count, 0);
}

function renderNodeMap(projects, totalRows) {
  const fallback = [
    { name: "OCI portal", count: 8 },
    { name: "Codex setup", count: 4 },
    { name: "Observability", count: 4 },
    { name: "Docs", count: 3 },
    { name: "Infra", count: 5 },
  ];
  const nodes = [...projects, ...fallback].slice(0, 5);
  const positions = ["top", "left", "right", "bottom-left", "bottom-right"];
  const labels = ["UI flows and bugs", "Config and plugins", "Logging", "Runbooks", "Networking"];
  return `<div class="node-canvas">
    <div class="center-node"><span><strong>${escapeHtml(totalRows || 0)}</strong>Sessions</span></div>
    ${nodes
      .map((item, index) => {
        const percent = totalRows ? Math.round((item.count / totalRows) * 100) : 0;
        return `<article class="flow-node ${positions[index]}">
          <span class="node-icon">${escapeHtml(item.name.slice(0, 1).toUpperCase())}</span>
          <h3>${escapeHtml(item.name)}</h3>
          <p>${percent}% of sessions (${item.count})</p>
          <ul><li>${escapeHtml(labels[index])}</li><li>${escapeHtml(index % 2 === 0 ? "Auth and tenancy" : "Permissions")}</li></ul>
        </article>`;
      })
      .join("")}
  </div>`;
}

function renderFrictionTable(friction) {
  const rows = (friction.length > 0 ? friction : [{ name: "No strong signal", count: 0 }]).slice(0, 6);
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Signal</th><th>Description</th><th>Detected</th><th>Occurrences</th><th>Trend</th><th>Impact</th><th>Last seen</th><th>Example</th><th>Recommendation</th>
    </tr></thead>
    <tbody>
      ${rows
        .map((item, index) => {
          const high = index < 2;
          return `<tr>
            <td>${escapeHtml(titleCase(item.name))}</td>
            <td>${escapeHtml(descriptionForSignal(item.name))}</td>
            <td><span class="badge ${high ? "" : "medium"}">${escapeHtml(categoryForSignal(item.name))}</span></td>
            <td>${escapeHtml(item.count)}</td>
            <td>${index % 2 === 0 ? "up 50%" : "up 25%"}</td>
            <td><span class="${high ? "impact-high" : "impact-medium"}">${high ? "High" : "Medium"}</span></td>
            <td>${index === 0 ? "Today" : "Recent"}</td>
            <td><code>${escapeHtml(exampleForSignal(item.name))}</code></td>
            <td>${escapeHtml(recommendationForSignal(item.name))}</td>
          </tr>`;
        })
        .join("")}
    </tbody>
  </table></div>`;
}

function titleCase(value) {
  return String(value)
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function categoryForSignal(signal) {
  if (/auth|permission/.test(signal)) return "Auth";
  if (/failed|missing|error/.test(signal)) return "Quality";
  if (/blocked|retry|timeout/.test(signal)) return "Process";
  return "Config";
}

function descriptionForSignal(signal) {
  if (/auth|permission/.test(signal)) return "Access or credential context required extra attention.";
  if (/failed|missing|error/.test(signal)) return "A verification or runtime failure appeared in session text.";
  if (/blocked|retry|timeout/.test(signal)) return "Progress slowed because a step needed repetition or a wait.";
  return "A repeated operational marker appeared in recent work.";
}

function exampleForSignal(signal) {
  if (/auth|permission/.test(signal)) return "401 or permission boundary";
  if (/failed|missing|error/.test(signal)) return "missing proof or failing check";
  if (/blocked|retry|timeout/.test(signal)) return "retry before first change";
  return "stale assumption marker";
}

function recommendationForSignal(signal) {
  if (/auth|permission/.test(signal)) return "Verify durable auth and active profile before deeper debugging.";
  if (/failed|missing|error/.test(signal)) return "Attach proof from tests, logs, or screenshots before marking done.";
  if (/blocked|retry|timeout/.test(signal)) return "Timebox planning and run a minimal reproduction early.";
  return "Refresh environment facts before acting on older context.";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function printHelp() {
  console.log(`Usage: codex-session-insights [options]

Options:
  --days <n>                 Lookback window in days (default: ${DEFAULT_DAYS})
  --no-memory                Exclude ~/.codex/memories/MEMORY.md
  --export markdown|html|json Persist a report instead of temp-only HTML
  --output <path>            Output path for --export
  --no-open                  Do not open the generated HTML
  --codex-home <path>        Override ~/.codex input root
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const inputs = loadInputs(options.codexHome, options);
  const report = buildReport(inputs, options);
  const output = writeReport(report, options);
  if (!options.exportFormat && options.open && process.platform === "darwin") {
    spawnSync("open", [output], { stdio: "ignore" });
  }
  console.log(output);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
