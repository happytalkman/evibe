import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { generateProject } from "../src/generator.ts";
import { makeDiagrams, renderDiagrams } from "../src/diagrams.ts";
import { plan } from "./fixtures.ts";

test("installed Archify actually validates and renders all four native IRs", async (t) => {
  const cli = process.env.EVIDE_ARCHIFY_CLI ?? path.resolve("vendor/archify/archify/bin/archify.mjs");
  try { await access(cli); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { t.skip("Optional Archify is not installed."); return; }
    throw error;
  }
  const maximum = { ...plan, services: Array.from({ length: 4 }, (_, i) => ({
    name: `domain${"a".repeat(17)}${i}`, label: `Domain ${i}`, approval: true,
    fields: Array.from({ length: 12 }, (_, j) => ({ name: `property${"aB".repeat(10)}${String(j).padStart(2, "0")}`, label: `Property ${j}`, type: "string" as const, required: j === 0, maxLength: 2000 })),
  })) };
  for (const candidate of [plan, maximum]) {
    const { files, findings } = generateProject(candidate), diagrams = makeDiagrams(candidate, files);
    await renderDiagrams(diagrams, cli, findings);
    for (const [kind, diagram] of Object.entries(diagrams)) {
      assert.equal(diagram.status, "rendered", `${kind}: ${JSON.stringify(findings)}`);
      assert.match(diagram.html ?? "", /<html/);
    }
  }
});
