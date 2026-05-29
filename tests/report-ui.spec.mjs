import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

import { buildReport, renderHtml } from "../plugins/codex-session-insights/scripts/codex-session-insights.mjs";

function reportUrl() {
  const root = mkdtempSync(join(tmpdir(), "codex-insights-ui-"));
  const rows = [];
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  for (let offset = 6; offset >= 0; offset -= 1) {
    const timestamp = new Date(today);
    timestamp.setUTCDate(today.getUTCDate() - offset);
    rows.push({
      timestamp: timestamp.toISOString(),
      cwd: "/tmp/codex-insights",
      content: "build error, failed action, auth check, missing proof, and retry before acceptance",
      usage: {
        input_tokens: 140_000 + offset * 7_500,
        cached_input_tokens: 12_000,
        output_tokens: 28_000 + offset * 1_500,
      },
    });
  }
  const report = buildReport(
    {
      rows,
      malformedRows: 0,
      memoryText: "",
      jsonlFiles: [],
    },
    { days: 7, includeMemory: false, useAi: false },
  );
  const htmlPath = join(root, "report.html");
  writeFileSync(htmlPath, renderHtml(report));
  return pathToFileURL(htmlPath).href;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copiedText = text;
        },
      },
    });
  });
});

test("generated report stays responsive, charts token spend, and copies prompts", async ({ page }) => {
  await page.goto(reportUrl());

  await expect(page.getByRole("heading", { name: "Top Actions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Evidence", exact: true })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await expect(page.locator(".token-spend-chart svg")).toBeVisible();
  await expect(page.locator(".token-spend-chart figcaption")).toContainText("7-day token spend scenario");
  await expect(page.locator(".spend-coverage")).toContainText("Dates:");
  await expect(page.locator(".chart-legend")).toContainText("Actual estimated tokens");

  const visibleBars = await page.locator(".actual-token-bar").evaluateAll((bars) =>
    bars.filter((bar) => {
      const box = bar.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    }).length,
  );
  expect(visibleBars).toBeGreaterThan(0);

  const copyButton = page.getByRole("button", { name: "Copy prompt" }).first();
  await copyButton.click();
  await expect(copyButton).toHaveText("Copied");
  const copied = await page.evaluate(() => window.__copiedText || "");
  expect(copied).toContain("Inspect AGENTS.md");
});
