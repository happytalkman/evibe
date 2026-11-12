import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Files, Finding, Plan } from "./engine.ts";
import { className, javaType, snake, sqlType } from "./generator.ts";

export const diagramKinds = ["architecture", "erd", "class", "tree"] as const;
export type DiagramKind = typeof diagramKinds[number];
export interface Diagram { ir: Record<string, unknown>; html?: string; status: "rendered" | "unavailable" | "failed" }
export type Diagrams = Record<DiagramKind, Diagram>;
const exec = promisify(execFile);

export function analyzeSource(files: Files): object {
  const declarations: object[] = [], imports: object[] = [], queries: object[] = [];
  for (const [file, text] of Object.entries(files)) {
    text.split("\n").forEach((line, i) => {
      if (file.endsWith(".java")) {
        const declaration = line.match(/\b(class|interface|record)\s+([A-Za-z0-9_]+)([^{]*)/);
        if (declaration) declarations.push({ file, line: i + 1, kind: declaration[1], name: declaration[2], signature: declaration[0].trim() });
        const imported = line.match(/^import\s+([^;]+);/);
        if (imported) imports.push({ file, line: i + 1, target: imported[1] });
      }
      if (file.endsWith("Mapper.xml") && /<(select|insert|update|delete)\b/.test(line)) {
        queries.push({ file, line: i + 1, declaration: line.trim() });
      }
    });
  }
  return { scope: "generated-source-declarations-and-mapper-statements", semanticCallGraph: false, declarations, imports, queries };
}

export function makeDiagrams(plan: Plan, files: Files): Diagrams {
  const meta = (kind: DiagramKind) => ({ title: `${plan.title} — ${kind}`, output: `${kind}.html`, quality_profile: "standard" });
  const components: object[] = [
    { id: "client", type: "frontend", label: "API client", row: 0, col: 0 },
    { id: "gateway", type: "backend", label: "Gateway :9000", row: 0, col: 1 },
    { id: "eureka", type: "backend", label: "Eureka :8761", row: 1, col: 0 },
    { id: "config", type: "backend", label: "Config :8888", row: 2, col: 0 },
  ];
  const connections: object[] = [{ from: "client", to: "gateway", label: "JWT / REST" }, { from: "gateway", to: "eureka", label: "discovery" }, { from: "gateway", to: "config", label: "configuration" }];
  const entities: object[] = [], types: object[] = [{ id: "base", label: "EgovAbstractServiceImpl", kind: "class", row: 0, col: 5 }], relationships: object[] = [];
  for (const [i, s] of plan.services.entries()) {
    const c = className(s);
    components.push({ id: s.name, type: "backend", label: `${c} :${9101 + i}`, row: i, col: 2 }, { id: `${s.name}_db`, type: "database", label: `${s.name} DB`, row: i, col: 3 });
    connections.push({ from: "gateway", to: s.name, label: `/api/${s.name}` }, { from: s.name, to: `${s.name}_db`, label: "MyBatis" }, { from: s.name, to: "eureka", label: "register", labelDy: 90 }, { from: s.name, to: "config", label: "load" });
    const attributes = [
      { name: "id", type: "BIGINT", key: "pk" },
      ...s.fields.map((f) => ({ name: snake(f.name), type: sqlType(f) })),
      { name: "frst_register_id", type: "VARCHAR(100)" }, { name: "frst_regist_pnttm", type: "TIMESTAMPTZ" },
      { name: "last_updusr_id", type: "VARCHAR(100)" }, { name: "last_updt_pnttm", type: "TIMESTAMPTZ" },
      ...(s.approval ? [{ name: "status", type: "VARCHAR(16)" }, { name: "approver", type: "VARCHAR(100)" }, { name: "reject_reason", type: "VARCHAR(1000)" }] : []),
    ];
    const width = Math.max(340, ...attributes.map((a) => a.name.length * 8 + a.type.length * 7 + 80));
    entities.push({ id: s.name, label: `${s.name}.${s.name}`, tag: s.name, row: 0, col: i, width, attributes });
    for (const [col, suffix] of ["Controller", "Service", "ServiceImpl", "Mapper", "VO"].entries()) {
      types.push({ id: `${s.name}_${suffix}`, label: `${c}${suffix}`, kind: suffix === "Service" || suffix === "Mapper" ? "interface" : "class", row: i + 1, col, width: 580,
        ...(suffix === "VO" ? { attributes: s.fields.map((f) => ({ name: f.name, type: javaType(f), visibility: "private" })) } : {}) });
    }
    for (const [from, to, kind] of [["Controller", "Service", "dependency"], ["ServiceImpl", "Service", "realization"], ["ServiceImpl", "Mapper", "dependency"], ["Mapper", "VO", "dependency"]]) {
      relationships.push({ id: `${s.name}_${from}_${to}`, from: `${s.name}_${from}`, to: `${s.name}_${to}`, kind });
    }
    relationships.push({ id: `${s.name}_base`, from: `${s.name}_ServiceImpl`, to: "base", kind: "inheritance" });
  }
  const treeNodes: object[] = [{ id: "root", label: plan.projectName }];
  const ids = new Map<string, string>([["", "root"]]);
  for (const file of Object.keys(files).sort()) {
    let parent = "";
    for (const part of file.split("/")) {
      const current = parent ? `${parent}/${part}` : part;
      if (!ids.has(current)) {
        const id = `n${ids.size}`;
        treeNodes.push({ id, label: part, parent: ids.get(parent) });
        ids.set(current, id);
      }
      parent = current;
    }
  }
  const wrap = (kind: DiagramKind, rest: object): Diagram => ({ status: "unavailable", ir: { schema_version: 1, diagram_type: kind, meta: meta(kind), ...rest } });
  return {
    architecture: wrap("architecture", { layout: { mode: "grid", cellW: 320, cellH: 100, gapX: 180, gapY: 140 }, components: components.map((component) => ({ ...component, size: [320, 90] })), connections }),
    erd: wrap("erd", { layout: { mode: "grid" }, entities, relationships: [] }),
    class: wrap("class", { layout: { mode: "grid" }, types, relationships }),
    tree: wrap("tree", { nodes: treeNodes }),
  };
}

export async function renderDiagrams(diagrams: Diagrams, cli: string, findings: Finding[]): Promise<void> {
  try { await stat(cli); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    findings.push({ severity: "WARN", code: "ARCHIFY_MISSING", message: "Archify is not installed. All four typed IR files and source analysis are preserved; generation continues." });
    return;
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), "evide-archify-"));
  try {
    for (const kind of diagramKinds) {
      const diagram = diagrams[kind], input = path.join(temp, `${kind}.json`), output = path.join(temp, `${kind}.html`);
      await writeFile(input, JSON.stringify(diagram.ir), "utf8");
      try {
        await exec(process.execPath, [cli, "deliver", kind, input, output, "--json"], { timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
        const info = await stat(output);
        if (info.size > 20 * 1024 * 1024) throw new Error("Rendered artifact exceeds 20 MiB.");
        const html = await readFile(output, "utf8");
        if (!/<html[\s>]/i.test(html)) throw new Error("CLI did not produce HTML.");
        diagram.html = html;
        diagram.status = "rendered";
      } catch {
        diagram.status = "failed";
        findings.push({ severity: "WARN", code: "ARCHIFY_RENDER_FAILED", message: `Archify ${kind} delivery failed, timed out, or produced invalid output. The IR remains available; run the local CLI on diagrams/${kind}.json for its diagnostic receipt.` });
      }
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
}
