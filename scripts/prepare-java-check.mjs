import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { generateProject } from "../src/generator.ts";
import { makeDiagrams } from "../src/diagrams.ts";
import { applyArtifact } from "../src/artifacts.ts";
import { plan } from "../tests/fixtures.ts";

const generated = generateProject(plan);
const artifact = { id: randomUUID(), plan, ...generated, diagrams: makeDiagrams(plan, generated.files), createdAt: new Date().toISOString() };
await mkdir(".tools", { recursive: true });
const root = await mkdtemp(path.resolve(".tools", "java-check-"));
console.log(await applyArtifact(root, artifact));
