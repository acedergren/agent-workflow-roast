#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ANALYZER_PATH = join(SCRIPT_DIR, "agent-workflow-roast.mjs");

export function parseCommandArgvJson(value = "[]") {
  const source = String(value || "[]").trim() || "[]";
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`AGENT_WORKFLOW_ROAST_ARGV_JSON must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("AGENT_WORKFLOW_ROAST_ARGV_JSON must be a JSON array of strings");
  }
  return parsed;
}

function readArgvJsonFromStdin() {
  if (process.stdin.isTTY) return "";
  return readFileSync(0, "utf8");
}

export function runCommandWrapper(env = process.env) {
  const argvJson = env.AGENT_WORKFLOW_ROAST_ARGV_JSON || readArgvJsonFromStdin() || "[]";
  const argv = parseCommandArgvJson(argvJson);
  const result = spawnSync(process.execPath, [ANALYZER_PATH, ...argv], {
    env,
    stdio: "inherit",
    shell: false,
  });
  if (typeof result.status === "number") return result.status;
  return result.signal ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCommandWrapper();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
