import { spawn } from "node:child_process";
import { generateKeyPair, randomUUID, sign } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parsePlan } from "../src/engine.ts";
import { className } from "../src/generator.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), projectIndex = args.indexOf("--project");
const smokeOnly = args.includes("--smoke-only");
if (projectIndex < 0 || !args[projectIndex + 1]) throw new Error("Usage: npm run local:java -- --project <generated-project> [--smoke-only]");
const project = await realpath(path.resolve(args[projectIndex + 1]));
const plan = parsePlan(JSON.parse(await readFile(path.join(project, "design.json"), "utf8")));
const logs = path.join(project, ".evide-local");
await mkdir(logs, { recursive: true });
const children = new Set();
let helper, shuttingDown = false;
async function exists(file) {
  try { await access(file); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
const env = { ...process.env };
delete env.EVIDE_LLM_API_KEY;
let javaHome = env.JAVA_HOME;
if (!javaHome && await exists(path.join(root, ".tools", "jdk"))) {
  const entries = await readdir(path.join(root, ".tools", "jdk"), { withFileTypes: true });
  const folder = entries.find((entry) => entry.isDirectory());
  if (folder) javaHome = path.join(root, ".tools", "jdk", folder.name);
}
if (javaHome) { env.JAVA_HOME = javaHome; env.PATH = `${path.join(javaHome, "bin")}${path.delimiter}${env.PATH ?? env.Path ?? ""}`; delete env.Path; }
const java = javaHome ? path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
const localMaven = path.join(root, ".tools", "apache-maven-3.9.9", "bin", process.platform === "win32" ? "mvn.cmd" : "mvn");
const maven = await exists(localMaven) ? localMaven : process.platform === "win32" ? "mvn.cmd" : "mvn";
const modules = [
  { name: "ConfigServer", port: 8888 },
  { name: "EurekaServer", port: 8761 },
  ...plan.services.map((s, i) => ({ name: className(s), port: 9101 + i, domain: s })),
  { name: "GatewayServer", port: 9000 },
];
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  if (helper) {
    helper.closeAllConnections();
    await new Promise((resolve) => helper.close(resolve));
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void shutdown(); });
function run(command, parameters, name, extraEnv = {}, shell = false) {
  const stream = createWriteStream(path.join(logs, `${name}.log`));
  const child = spawn(shell ? `"${command}"` : command, parameters, {
    cwd: project, env: { ...env, ...extraEnv }, shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  child.once("close", () => { stream.end(); children.delete(child); });
  child.once("error", (error) => { console.error(`${name}: ${error.message}`); });
  return child;
}
async function free(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(new Error(`Cannot bind port ${port} (${error.code}); it may be occupied or reserved by Windows. No existing process was stopped.`)));
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(url, child, headers = {}) {
  const deadline = Date.now() + 180000;
  let last = "no response";
  while (Date.now() < deadline && !shuttingDown) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`JAR exited before readiness. See ${logs}`);
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      last = `HTTP ${response.status}`; await response.body?.cancel();
      if (response.ok) return;
    } catch (error) { last = error.name; }
    await delay(500);
  }
  throw new Error(`Readiness failed: ${url} (${last}). See ${logs}`);
}
const { privateKey, publicKey } = await promisify(generateKeyPair)("rsa", { modulusLength: 2048 });
const kid = randomUUID(), jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub: "local-developer", iss: "http://127.0.0.1:4546", aud: "evide-local", iat: now, exp: now + 300, scope: "records.read records.write records.approve" })).toString("base64url");
  const data = `${header}.${claims}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
}
function startHelper() {
  helper = createServer((request, response) => {
    const handle = async () => {
      const host = request.headers.host;
      if (!["127.0.0.1:4546", "localhost:4546"].includes(host) ||
          (request.headers.origin && !["http://127.0.0.1:4546", "http://localhost:4546"].includes(request.headers.origin)) ||
          request.headers["sec-fetch-site"] === "cross-site") { response.writeHead(403); response.end("Forbidden"); return; }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:9000; base-uri 'none'; frame-ancestors 'none'");
      if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname === "/jwks") {
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ keys: [jwk] }));
      } else if (url.pathname === "/token") {
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ token: token() }));
      } else if (url.pathname === "/plan") {
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(plan));
      } else {
        const file = url.pathname === "/" ? "dist/local-web/index.html" : url.pathname === "/app.js" ? "dist/local-web/app.js" : url.pathname === "/style.css" ? "dist/web/style.css" : undefined;
        if (!file) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8" });
        response.end(await readFile(path.resolve(root, file)));
      }
    };
    void handle().catch((error) => { console.error("Developer helper failed:", error.message); if (!response.headersSent) response.writeHead(500); response.end("Local helper failed."); });
  });
  return new Promise((resolve, reject) => { helper.once("error", reject); helper.listen(4546, "127.0.0.1", resolve); });
}
function sample(service) {
  return Object.fromEntries(service.fields.map((field) => [field.name, ({ string: "local-test".slice(0, field.maxLength), long: 1, decimal: 1.25, boolean: true, date: "2026-01-01" })[field.type]]));
}
async function api(service, method, suffix = "", data, expected = 200) {
  const response = await fetch(`http://127.0.0.1:9000/api/${service.name}${suffix}`, {
    method, headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  if (response.status !== expected) throw new Error(`${method} ${service.name}${suffix}: expected ${expected}, got ${response.status}. See ${logs}`);
  return text ? JSON.parse(text) : undefined;
}
async function main() {
  console.log(`Project: ${project}\nMode: local JVM + isolated H2; development-only JWT; NOT Docker/PostgreSQL verification.`);
  await Promise.all([4546, ...modules.map((m) => m.port)].map(free));
  console.log(`Running Maven package with tests. Log: ${path.join(logs, "maven.log")}`);
  const build = run(maven, ["-B", "-ntp", "package"], "maven", {}, process.platform === "win32");
  await new Promise((resolve, reject) => {
    build.once("error", reject);
    build.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Maven failed (${code}); no JARs were started. See ${path.join(logs, "maven.log")}`)));
  });
  console.log("Maven package and tests passed.");
  await startHelper();
  let gateway;
  for (const module of modules) {
    const extra = {
      JWT_JWK_SET_URI: "http://127.0.0.1:4546/jwks",
      EUREKA_URL: "http://127.0.0.1:8761/eureka/",
      CONFIG_SERVER_URL: "http://127.0.0.1:8888",
      CORS_ALLOWED_ORIGIN: "http://127.0.0.1:4546,http://localhost:4546",
      ...(module.domain ? { DB_URL: `jdbc:h2:mem:${module.domain.name};MODE=PostgreSQL;DB_CLOSE_DELAY=-1`, DB_USER: "sa", DB_PASSWORD: "" } : {}),
    };
    const child = run(java, ["-Xms32m", "-Xmx256m", "-jar", path.join(project, module.name, "target", "app.jar"), ...(module.name === "ConfigServer" || module.name === "EurekaServer" ? [] : ["--spring.profiles.active=cloud"])], module.name, extra);
    await waitFor(`http://127.0.0.1:${module.port}/actuator/health`, child);
    console.log(`Ready: ${module.name} http://127.0.0.1:${module.port}/actuator/health`);
    if (module.name === "GatewayServer") gateway = child;
  }
  for (const service of plan.services) await waitFor(`http://127.0.0.1:9000/api/${service.name}`, gateway, { Authorization: `Bearer ${token()}` });
  const unauthorized = await fetch(`http://127.0.0.1:9000/api/${plan.services[0].name}`);
  await unauthorized.body?.cancel();
  if (unauthorized.status !== 401) throw new Error("Gateway did not reject an unauthenticated API request.");
  console.log("Verified: authenticated routed API reads and unauthenticated 401.");
  if (smokeOnly) {
    for (const service of plan.services) {
      const data = sample(service), record = await api(service, "POST", "", data, 201);
      if (record.frstRegisterId !== "local-developer") throw new Error("Audit actor did not originate from JWT.");
      const suffix = `/${record.id}`;
      await api(service, "GET", suffix);
      await api(service, "PUT", suffix, data);
      if (service.approval) {
        await api(service, "PATCH", `${suffix}/approval`, { decision: "REJECTED" }, 400);
        await api(service, "PATCH", `${suffix}/approval`, { decision: "APPROVED" });
        await api(service, "PATCH", `${suffix}/approval`, { decision: "APPROVED" }, 409);
        await api(service, "PUT", suffix, data, 409);
      } else { await api(service, "DELETE", suffix, undefined, 204); await api(service, "GET", suffix, undefined, 404); }
      console.log(`SMOKE PASS: ${service.name} CRUD${service.approval ? ", approval state transitions, JWT audit" : ""}`);
    }
    await shutdown();
  } else console.log("Open http://127.0.0.1:4546/ to exercise your generated APIs. Ctrl+C stops only this runner's JARs.");
}
try { await main(); }
catch (error) { console.error(error.message); process.exitCode = 1; await shutdown(); }
