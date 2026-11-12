import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { applyArtifact, errorMessage, generateInput, GenerationSession, idInput, zipArtifact } from "./artifacts.ts";
import { EvideError } from "./engine.ts";
import { diagramKinds } from "./diagrams.ts";

const rootCsp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const diagramCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 64 * 1024) throw new EvideError("Request body exceeds 64 KiB.", 413);
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new EvideError("Invalid JSON request."); }
}

function json(response: ServerResponse, status: number, result: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(result));
}

export function createApp(options: { session: GenerationSession; outputRoot: string; webRoot: string }) {
  const token = randomBytes(32).toString("hex");
  return createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const handle = async () => {
      const local = request.socket.localPort;
      const hosts = [`localhost:${local}`, `127.0.0.1:${local}`, `[::1]:${local}`];
      if (!request.headers.host || !hosts.includes(request.headers.host.toLowerCase())) throw new EvideError("Untrusted Host.", 403);
      if (request.headers.origin && !hosts.map((h) => `http://${h}`).includes(request.headers.origin)) throw new EvideError("Foreign Origin is not allowed.", 403);
      if (request.headers["sec-fetch-site"] === "cross-site") throw new EvideError("Cross-site requests are not allowed.", 403);
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const method = request.method ?? "GET";
      if (method === "POST" || url.pathname === "/api/export") {
        if (request.headers["x-evide-token"] !== token) throw new EvideError("Missing or invalid local request token.", 403);
      }
      if (method === "GET" && url.pathname === "/api/session") {
        json(response, 200, { ok: true, result: { token, outputRoot: options.outputRoot } });
      } else if (method === "POST" && url.pathname === "/api/generate") {
        const input = generateInput.parse(await body(request));
        json(response, 200, { ok: true, result: await options.session.generate(input.prompt) });
      } else if (method === "POST" && url.pathname === "/api/apply") {
        const { id } = idInput.parse(await body(request));
        const destination = await applyArtifact(options.outputRoot, options.session.get(id));
        json(response, 200, { ok: true, result: { message: `Applied to ${destination}` } });
      } else if (method === "GET" && url.pathname === "/api/export") {
        const { id } = idInput.parse({ id: url.searchParams.get("id") });
        const artifact = options.session.get(id), zip = await zipArtifact(artifact);
        response.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${artifact.plan.projectName}.zip"` });
        response.end(zip);
      } else if (method === "GET" && url.pathname === "/api/diagram") {
        const input = z.object({ id: z.string().uuid(), kind: z.enum(diagramKinds) }).parse({ id: url.searchParams.get("id"), kind: url.searchParams.get("kind") });
        const diagram = options.session.get(input.id).diagrams[input.kind];
        if (!diagram.html) throw new EvideError("Archify HTML is unavailable. Use the preserved IR.", 404);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": diagramCsp });
        response.end(diagram.html);
      } else if (method === "GET" && ["/", "/app.js", "/style.css"].includes(url.pathname)) {
        const filename = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        let contents = await readFile(path.join(options.webRoot, filename), "utf8");
        if (filename === "index.html") contents = contents.replace("{{CSP}}", rootCsp).replace("{{STYLE}}", "/style.css").replace("{{SCRIPT}}", "/app.js");
        response.writeHead(200, { "Content-Type": filename.endsWith(".js") ? "text/javascript; charset=utf-8" : filename.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8", "Content-Security-Policy": rootCsp });
        response.end(contents);
      } else { throw new EvideError("Route not found.", 404); }
    };
    void handle().catch((error: unknown) => {
      console.error("[Evide] request failed:", error instanceof Error ? error.name : "UnknownError");
      if (response.headersSent) { response.destroy(); return; }
      json(response, error instanceof EvideError ? error.status : error instanceof z.ZodError ? 400 : 500, { ok: false, error: errorMessage(error) });
    });
  });
}
