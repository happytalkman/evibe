import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { localConfig } from "../src/local-config.ts";

test("operator .env reloads asynchronously without copying credentials into process environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evide-config-test-"));
  const original = process.env.EVIDE_LLM_API_KEY;
  try {
    await writeFile(path.join(root, ".env"), "EVIDE_LLM_BASE_URL=http://127.0.0.1:1234/v1\nEVIDE_LLM_MODEL=local-test\nEVIDE_LLM_API_KEY=fixture-only-value\n");
    const config = await localConfig(root);
    assert.equal(config.model, "local-test");
    assert.equal(config.apiKey, "fixture-only-value");
    assert.equal(process.env.EVIDE_LLM_API_KEY, original);
    await writeFile(path.join(root, ".env"), "EVIDE_LLM_BASE_URL=http://127.0.0.1:1234/v1\nEVIDE_LLM_MODEL=updated-test\nEVIDE_LLM_API_KEY=fixture-only-value\n");
    assert.equal((await localConfig(root)).model, "updated-test");
  } finally { await rm(root, { recursive: true, force: true }); }
});
