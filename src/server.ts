import path from "node:path";
import { createApp } from "./server-app.ts";
import { GenerationSession } from "./artifacts.ts";
import { localConfig } from "./local-config.ts";

const root = process.cwd();
const port = Number(process.env.EVIDE_PORT ?? 4545);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("EVIDE_PORT must be 1–65535.");
const session = new GenerationSession({ config: () => localConfig(root), archifyCli: process.env.EVIDE_ARCHIFY_CLI ?? path.join(root, "vendor", "archify", "archify", "bin", "archify.mjs") });
const app = createApp({ session, outputRoot: path.resolve(process.env.EVIDE_OUTPUT_DIR ?? path.join(root, "generated")), webRoot: path.join(root, "dist", "web") });
app.on("error", (error) => { console.error("[Evide] server failed:", error.message); process.exitCode = 1; });
app.listen(port, "127.0.0.1", () => { console.log(`Evide is ready: http://127.0.0.1:${port}/ (localhost:${port})`); });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { app.close(); app.closeAllConnections(); });
}
