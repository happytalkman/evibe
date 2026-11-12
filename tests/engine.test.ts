import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { configFromEnv, interpret, parsePlan } from "../src/engine.ts";
import { generateProject, validateFiles } from "../src/generator.ts";
import { analyzeSource, makeDiagrams, renderDiagrams } from "../src/diagrams.ts";
import { applyArtifact, GenerationSession, zipArtifact } from "../src/artifacts.ts";
import type { Artifact } from "../src/artifacts.ts";
import { plan, provider } from "./fixtures.ts";

const missingCli = path.join(os.tmpdir(), "evide-not-installed", "archify.mjs");
function artifact(): Artifact {
  const generated = generateProject(plan);
  return { id: crypto.randomUUID(), plan, ...generated, diagrams: makeDiagrams(plan, generated.files), createdAt: new Date().toISOString() };
}

test("real provider HTTP contract interprets natural language without local fallback", async () => {
  let observed = false;
  const p = await provider({ inspect(data, authorization) {
    const body = JSON.parse(JSON.stringify(data));
    assert.equal(body.model, "test-model");
    assert.equal(body.messages[1].content, "민원 승인과 공지를 만들어줘");
    assert.match(authorization ?? "", /^Bearer test-only/);
    observed = true;
  } });
  try { assert.deepEqual(await interpret("민원 승인과 공지를 만들어줘", p.config), plan); assert.ok(observed); }
  finally { await p.close(); }
});

test("provider/configuration failures never return a generated project", async () => {
  assert.throws(() => configFromEnv({}), /No offline fallback/);
  for (const options of [{ status: 401 }, { content: "not json" }, { content: JSON.stringify({ ...plan, unsupportedRequirements: ["파일 첨부"] }) }]) {
    const p = await provider(options);
    try { await assert.rejects(interpret("민원", p.config)); } finally { await p.close(); }
  }
  const p = await provider({ delay: 100 });
  try { await assert.rejects(interpret("민원", { ...p.config, timeoutMs: 5 }), /timed out/); }
  finally { await p.close(); }
  await assert.rejects(interpret("민원", { baseUrl: "http://example.com/v1", model: "test", apiKey: "not-real" }), /HTTPS/);
});

test("strict plan names, audit ownership, cardinalities and duplicates are validated", () => {
  assert.throws(() => parsePlan({ ...plan, projectName: "../outside" }), /Invalid design/);
  assert.throws(() => parsePlan({ ...plan, services: [plan.services[0], plan.services[0]] }), /Duplicate/);
  const copy = structuredClone(plan);
  copy.services[0]!.fields[0]!.name = "frstRegisterId";
  assert.throws(() => parsePlan(copy), /Reserved/);
  copy.services[0]!.fields[0]!.name = "title";
  copy.services[0]!.fields.push({ ...copy.services[0]!.fields[0]! });
  assert.throws(() => parsePlan(copy), /Duplicate fields/);
});

test("all generated surfaces share domain, approval, audit, namespace and deployment rules", () => {
  const { files, findings } = generateProject(plan);
  assert.equal(findings.filter((f) => f.severity === "ERROR").length, 0);
  assert.equal(Object.keys(files).filter((f) => f.startsWith("docs/pmo/")).length, 5);
  assert.match(files["pom.xml"]!, /5\.0\.0/);
  assert.match(files["pom.xml"]!, /https:\/\/maven.egovframe.go.kr/);
  const entries = Object.entries(files);
  const java = entries.filter(([name]) => name.endsWith(".java"));
  assert.ok(java.length > 20);
  assert.ok(java.every(([, text]) => !text.includes("javax.")));
  assert.ok(entries.filter(([name]) => name.endsWith("Mapper.xml")).every(([, text]) => !text.includes("${") && text.includes("#{")));
  const impl = java.find(([name]) => name.endsWith("EgovComplaintServiceImpl.java"))![1];
  assert.match(impl, /extends EgovAbstractServiceImpl/);
  assert.match(impl, /Rejection requires a reason/);
  assert.match(java.find(([name]) => name.endsWith("EgovComplaintMapper.java"))![1], /@EgovMapper\("complaintMapper"\)/);
  assert.ok(entries.some(([name]) => name.endsWith("EgovComplaintApproval.java")));
  assert.ok(!entries.some(([name]) => name.endsWith("EgovNoticeApproval.java")));
  assert.match(files["ddl/complaint.sql"]!, /frst_register_id[\s\S]*frst_regist_pnttm[\s\S]*last_updusr_id[\s\S]*last_updt_pnttm/);
  assert.match(files["ddl/complaint.sql"]!, /CHECK \(status IN/);
  assert.ok(!files["ddl/notice.sql"]!.includes("status"));
  assert.match(files["GatewayServer/src/main/resources/application.yml"]!, /lb:\/\/EGOVCOMPLAINT/);
  assert.match(files["deploy/k8s/egovcomplaint.yml"]!, /readinessProbe:[\s\S]*livenessProbe:[\s\S]*limits:/);
  for (const [name, text] of entries.filter(([name]) => name.endsWith("/Dockerfile"))) {
    assert.match(text, /FROM .* AS build/);
    assert.ok(text.includes("USER 10001:10001"), name);
  }
  assert.equal(validateFiles({ "x.java": "import javax.servlet.Test;", "XMapper.xml": "${unsafe}" }).filter((f) => f.severity === "ERROR").length, 2);
});

test("source analysis carries real file/line evidence and four IRs preserve isolated databases", () => {
  const { files } = generateProject(plan);
  const source = JSON.stringify(analyzeSource(files));
  assert.match(source, /EgovComplaintController/);
  assert.match(source, /"line":/);
  const diagrams = makeDiagrams(plan, files);
  assert.deepEqual(Object.keys(diagrams), ["architecture", "erd", "class", "tree"]);
  assert.deepEqual(diagrams.erd.ir.relationships, []);
  for (const diagram of Object.values(diagrams)) assert.equal(diagram.ir.schema_version, 1);
});

test("missing and failing Archify visibly degrade while retaining IR", async () => {
  const { files, findings } = generateProject(plan), diagrams = makeDiagrams(plan, files);
  await renderDiagrams(diagrams, missingCli, findings);
  assert.ok(findings.some((f) => f.code === "ARCHIFY_MISSING"));
  assert.ok(Object.values(diagrams).every((d) => d.status === "unavailable" && d.ir));
  const temp = await mkdtemp(path.join(os.tmpdir(), "evide-cli-test-"));
  try {
    const cli = path.join(temp, "failed.mjs");
    await writeFile(cli, "process.exit(2);");
    await renderDiagrams(diagrams, cli, findings);
    assert.equal(findings.filter((f) => f.code === "ARCHIFY_RENDER_FAILED").length, 4);
    assert.ok(Object.values(diagrams).every((d) => d.status === "failed"));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("apply is non-overwriting, rejects traversal/symlinks, and ZIP contains real files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evide-apply-test-")), a = artifact();
  try {
    const dest = await applyArtifact(root, a);
    assert.equal(await readFile(path.join(dest, "pom.xml"), "utf8"), a.files["pom.xml"]);
    await assert.rejects(applyArtifact(root, a), /already exists/);
    const bad = { ...a, files: { "../escape.txt": "bad" } };
    await assert.rejects(applyArtifact(root, bad), /Invalid generated file path/);
    const real = path.join(root, "real"), alias = path.join(root, "alias");
    await mkdir(real);
    await symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(applyArtifact(alias, a), /real directory|symlinks/);
    const zip = await JSZip.loadAsync(await zipArtifact(a));
    assert.equal(await zip.file(`${plan.projectName}/pom.xml`)!.async("string"), a.files["pom.xml"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session serializes generation and invalidates stale results, including on failure", async () => {
  const p = await provider({ delay: 20 });
  try {
    const session = new GenerationSession({ config: () => p.config, archifyCli: missingCli });
    const first = session.generate("민원");
    await assert.rejects(session.generate("중복"), /already in progress/);
    const a = await first;
    assert.equal(session.get(a.id).id, a.id);
    const b = await session.generate("공지");
    assert.throws(() => session.get(a.id), /stale/);
    assert.equal(session.get(b.id).id, b.id);
    await p.close();
    await assert.rejects(session.generate("실패"), /connection failed/);
    assert.throws(() => session.get(b.id), /stale/);
  } finally { await p.close(); }
});
