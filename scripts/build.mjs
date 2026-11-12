import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await Promise.all([mkdir("dist/web", { recursive: true }), mkdir("dist/local-web", { recursive: true })]);
await Promise.all([
  build({ entryPoints: ["src/server.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: "dist/server.cjs" }),
  build({ entryPoints: ["src/extension.ts"], bundle: true, platform: "node", format: "cjs", target: "node20", external: ["vscode"], outfile: "dist/extension.cjs" }),
  build({ entryPoints: ["src/web/app.ts"], bundle: true, platform: "browser", target: "es2022", outfile: "dist/web/app.js" }),
  build({ entryPoints: ["src/local-web/app.ts"], bundle: true, platform: "browser", target: "es2022", outfile: "dist/local-web/app.js" }),
  cp("src/web/index.html", "dist/web/index.html"),
  cp("src/web/style.css", "dist/web/style.css"),
  cp("src/local-web/index.html", "dist/local-web/index.html"),
]);
