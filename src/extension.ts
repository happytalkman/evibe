import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { applyArtifact, errorMessage, generateInput, GenerationSession, idInput, zipArtifact } from "./artifacts.ts";
import { configFromEnv, EvideError } from "./engine.ts";
import { messageSchema } from "./contracts.ts";
import { diagramKinds } from "./diagrams.ts";

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Evide");
  context.subscriptions.push(output);
  let apiKey = await context.secrets.get("llmApiKey");
  context.subscriptions.push(vscode.commands.registerCommand("egovvibe.configure", async () => {
    const base = await vscode.window.showInputBox({ title: "Evide: OpenAI-compatible base URL (include /v1)", value: context.globalState.get<string>("llmBaseUrl", "https://api.openai.com/v1"), ignoreFocusOut: true });
    if (!base) return;
    const model = await vscode.window.showInputBox({ title: "Evide: Model ID", value: context.globalState.get<string>("llmModel", ""), ignoreFocusOut: true });
    if (!model) return;
    const key = await vscode.window.showInputBox({ title: "Evide: API key (stored in VS Code SecretStorage)", password: true, ignoreFocusOut: true });
    if (!key) return;
    await context.globalState.update("llmBaseUrl", base);
    await context.globalState.update("llmModel", model);
    await context.secrets.store("llmApiKey", key);
    apiKey = key;
    void vscode.window.showInformationMessage("Evide LLM configuration saved.");
  }));
  const session = new GenerationSession({
    config: () => configFromEnv({
      ...process.env,
      EVIDE_LLM_BASE_URL: process.env.EVIDE_LLM_BASE_URL ?? context.globalState.get<string>("llmBaseUrl"),
      EVIDE_LLM_MODEL: process.env.EVIDE_LLM_MODEL ?? context.globalState.get<string>("llmModel"),
      EVIDE_LLM_API_KEY: process.env.EVIDE_LLM_API_KEY ?? apiKey,
    }),
    archifyCli: process.env.EVIDE_ARCHIFY_CLI ?? path.join(context.extensionPath, "vendor", "archify", "archify", "bin", "archify.mjs"),
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("egovvibe.sidebar", {
    resolveWebviewView(view) {
      const resources = vscode.Uri.joinPath(context.extensionUri, "dist", "web");
      view.webview.options = { enableScripts: true, localResourceRoots: [resources] };
      const initialize = async () => {
        const nonce = randomBytes(24).toString("hex");
        const csp = `default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource} data:; base-uri 'none'; form-action 'none'`;
        const html = await readFile(path.join(context.extensionPath, "dist", "web", "index.html"), "utf8");
        view.webview.html = html.replace("{{CSP}}", csp).replace("{{STYLE}}", view.webview.asWebviewUri(vscode.Uri.joinPath(resources, "style.css")).toString())
          .replace("{{SCRIPT}}", view.webview.asWebviewUri(vscode.Uri.joinPath(resources, "app.js")).toString()).replace("<script ", `<script nonce="${nonce}" `);
      };
      void initialize().catch((error: unknown) => { output.appendLine(`Webview initialization failed: ${errorMessage(error)}`); void vscode.window.showErrorMessage(errorMessage(error)); });
      context.subscriptions.push(view.webview.onDidReceiveMessage((raw: unknown) => {
        const handle = async () => {
          const message = messageSchema.parse(raw);
          if (!vscode.workspace.isTrusted) throw new EvideError("Trust this workspace before using Evide.");
          let result: unknown;
          if (message.type === "configure") {
            await vscode.commands.executeCommand("egovvibe.configure");
            result = { message: "Configuration command completed." };
          } else if (message.type === "generate") {
            result = await session.generate(generateInput.parse(message.payload).prompt);
          } else if (message.type === "apply") {
            const artifact = session.get(idInput.parse(message.payload).id);
            const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Choose the workspace receiving a NEW generated project folder" });
            if (!folder) throw new EvideError("Apply canceled.");
            if (folder.uri.scheme !== "file") throw new EvideError("Apply currently requires a local filesystem workspace.");
            const answer = await vscode.window.showWarningMessage(`Create ${Object.keys(artifact.files).length} files in ${artifact.plan.projectName} beneath ${folder.name}? Existing project folders will not be overwritten.`, { modal: true }, "Apply");
            if (answer !== "Apply") throw new EvideError("Apply canceled.");
            session.get(artifact.id);
            const location = await applyArtifact(folder.uri.fsPath, artifact);
            result = { message: `Applied to ${location}` };
          } else if (message.type === "export") {
            const artifact = session.get(idInput.parse(message.payload).id);
            const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath, `${artifact.plan.projectName}.zip`)), filters: { ZIP: ["zip"] } });
            if (!uri) throw new EvideError("Export canceled.");
            await vscode.workspace.fs.writeFile(uri, await zipArtifact(artifact));
            result = { message: "ZIP exported." };
          } else {
            const { id, kind } = z.object({ id: z.string().uuid(), kind: z.enum(diagramKinds) }).strict().parse(message.payload);
            const html = session.get(id).diagrams[kind].html;
            if (!html) throw new EvideError("Archify is unavailable; IR is preserved.");
            const panel = vscode.window.createWebviewPanel("egovvibe.diagram", `Archify: ${kind}`, vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [] });
            panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"></head><body style="margin:0"><iframe sandbox="allow-scripts" style="border:0;width:100vw;height:100vh" srcdoc="${escape(html)}"></iframe></body></html>`;
            result = { message: "Diagram opened in an isolated panel." };
          }
          await view.webview.postMessage({ requestId: message.requestId, ok: true, result });
        };
        void handle().catch(async (error: unknown) => {
          output.appendLine(`Operation failed: ${error instanceof Error ? error.name : "UnknownError"} — ${errorMessage(error)}`);
          const request = messageSchema.safeParse(raw);
          if (request.success) await view.webview.postMessage({ requestId: request.data.requestId, ok: false, error: errorMessage(error) });
          else void vscode.window.showErrorMessage("Evide rejected an invalid Webview message.");
        });
      }));
    },
  }));
}
