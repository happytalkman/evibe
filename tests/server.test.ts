import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "../src/server-app.ts";
import { GenerationSession } from "../src/artifacts.ts";
import { provider } from "./fixtures.ts";

test("web API protects origin, token and stale IDs; produces ZIP and non-overwriting apply", async () => {
  const p = await provider(), outputRoot = await mkdtemp(path.join(os.tmpdir(), "evide-http-test-"));
  const session = new GenerationSession({ config: () => p.config, archifyCli: path.join(outputRoot, "missing.mjs") });
  const server = createApp({ session, outputRoot, webRoot: path.resolve("src/web") });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const { result: { token } } = await (await fetch(`${base}/api/session`)).json();
    assert.equal((await fetch(`${base}/api/generate`, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/api/session`, { headers: { Origin: "https://foreign.invalid" } })).status, 403);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/session`, { headers: { Host: "foreign.invalid" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(hostStatus, 403);
    const post = (route: string, value: unknown) => fetch(`${base}/api/${route}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Evide-Token": token }, body: JSON.stringify(value) });
    assert.equal((await post("generate", { prompt: "" })).status, 400);
    const generated = await post("generate", { prompt: "민원 생성" });
    assert.equal(generated.status, 200);
    const { result: artifact } = await generated.json();
    assert.ok(artifact.files["pom.xml"]);
    const exported = await fetch(`${base}/api/export?id=${artifact.id}`, { headers: { "X-Evide-Token": token } });
    assert.equal(exported.headers.get("content-type"), "application/zip");
    assert.ok((await exported.arrayBuffer()).byteLength > 1000);
    assert.equal((await post("apply", { id: artifact.id })).status, 200);
    assert.equal((await post("apply", { id: artifact.id })).status, 409);
    assert.equal((await post("apply", { id: crypto.randomUUID() })).status, 409);
    assert.equal((await post("apply", { id: artifact.id, files: { "../escape": "x" } })).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await p.close(); await rm(outputRoot, { recursive: true, force: true });
  }
});
