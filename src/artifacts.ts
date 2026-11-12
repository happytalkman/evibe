import { randomUUID } from "node:crypto";
import { mkdir, lstat, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import { configFromEnv, EvideError, interpret } from "./engine.ts";
import type { Files, Finding, LlmConfig, Plan } from "./engine.ts";
import { analyzeSource, diagramKinds, makeDiagrams, renderDiagrams } from "./diagrams.ts";
import type { Diagrams } from "./diagrams.ts";
import { generateProject } from "./generator.ts";

export interface Artifact { id: string; plan: Plan; files: Files; findings: Finding[]; diagrams: Diagrams; createdAt: string }
export const generateInput = z.object({ prompt: z.string().trim().min(1).max(12000) }).strict();
export const idInput = z.object({ id: z.string().uuid() }).strict();

export class GenerationSession {
  private current?: Artifact;
  private busy = false;
  private readonly options: { config?: () => LlmConfig | Promise<LlmConfig>; archifyCli: string };
  constructor(options: { config?: () => LlmConfig | Promise<LlmConfig>; archifyCli: string }) { this.options = options; }
  async generate(prompt: string): Promise<Artifact> {
    if (this.busy) throw new EvideError("A generation is already in progress.", 409);
    generateInput.parse({ prompt });
    this.busy = true;
    this.current = undefined;
    try {
      const plan = await interpret(prompt, await (this.options.config ?? configFromEnv)());
      const { files, findings } = generateProject(plan);
      files["diagrams/source-analysis.json"] = JSON.stringify(analyzeSource(files), null, 2);
      const diagrams = makeDiagrams(plan, files);
      for (const kind of diagramKinds) files[`diagrams/${kind}.json`] = JSON.stringify(diagrams[kind].ir, null, 2);
      await renderDiagrams(diagrams, this.options.archifyCli, findings);
      for (const kind of diagramKinds) {
        const html = diagrams[kind].html;
        if (html) files[`diagrams/${kind}.html`] = html;
      }
      files["docs/validation.json"] = JSON.stringify({ scope: "bounded-static-rules", certification: false, javaTests: "NOT_RUN", findings }, null, 2);
      this.current = { id: randomUUID(), plan, files, findings, diagrams, createdAt: new Date().toISOString() };
      return this.current;
    } finally { this.busy = false; }
  }
  get(id: string): Artifact {
    if (this.busy || !this.current || this.current.id !== id || Date.now() - Date.parse(this.current.createdAt) > 30 * 60 * 1000) {
      throw new EvideError("Generation is missing, expired, busy or stale. Generate again.", 409);
    }
    return this.current;
  }
}

function validRelative(file: string): void {
  if (!file || file.length > 220 || file.includes("\\") || file.includes(":") || path.posix.isAbsolute(file) ||
      file.split("/").some((part) => !part || part === "." || part === ".." || /[<>"|?*]/.test(part) || [...part].some((c) => c.charCodeAt(0) < 32) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(part))) {
    throw new EvideError("Invalid generated file path.", 422);
  }
}

export async function applyArtifact(root: string, artifact: Artifact): Promise<string> {
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(artifact.plan.projectName)) throw new EvideError("Invalid project folder.", 422);
  for (const file of Object.keys(artifact.files)) validRelative(file);
  const absolute = path.resolve(root);
  await mkdir(absolute, { recursive: true });
  const rootInfo = await lstat(absolute);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new EvideError("Output root must be a real directory.", 409);
  const canonical = await realpath(absolute);
  if (path.normalize(canonical).toLowerCase() !== path.normalize(absolute).toLowerCase()) {
    throw new EvideError("Output root must not traverse symlinks.", 409);
  }
  const destination = path.join(canonical, artifact.plan.projectName);
  try {
    await lstat(destination);
    throw new EvideError("Destination already exists. Existing files are never overwritten.", 409);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const staging = await mkdtemp(path.join(canonical, ".evide-stage-"));
  try {
    for (const [file, contents] of Object.entries(artifact.files)) {
      const target = path.join(staging, ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, { encoding: "utf8", flag: "wx" });
    }
    await rename(staging, destination);
    return destination;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function zipArtifact(artifact: Artifact): Promise<Buffer> {
  const zip = new JSZip();
  for (const [file, content] of Object.entries(artifact.files)) {
    validRelative(file);
    zip.file(`${artifact.plan.projectName}/${file}`, content);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export function errorMessage(error: unknown): string {
  if (error instanceof EvideError) return error.message;
  if (error instanceof z.ZodError) return "Invalid request payload.";
  return "Operation failed. Inspect the local host output for details.";
}
