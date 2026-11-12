import { z } from "zod";
import { artifactSchema, replySchema } from "../contracts.ts";
import type { Artifact } from "../artifacts.ts";
import type { DiagramKind } from "../diagrams.ts";

declare const acquireVsCodeApi: undefined | (() => { postMessage(message: unknown): void });
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
const status = document.querySelector<HTMLElement>("#status")!;
const resultPanel = document.querySelector<HTMLElement>("#result")!;
const file = document.querySelector<HTMLSelectElement>("#file")!;
const diagram = document.querySelector<HTMLSelectElement>("#diagram")!;
const preview = document.querySelector<HTMLElement>("#preview")!;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let token = "", current: Artifact | undefined, busy = false, tab = "files";
function notify(message: string, error = false): void { status.textContent = message; status.classList.toggle("error", error); }
function setBusy(value: boolean): void {
  busy = value;
  for (const button of document.querySelectorAll<HTMLButtonElement>("button")) button.disabled = value;
  prompt.disabled = value;
  updateDiagram();
}
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const parsed = replySchema.safeParse(event.data);
  if (!parsed.success || !parsed.data.requestId) return;
  const entry = pending.get(parsed.data.requestId);
  if (!entry) return;
  pending.delete(parsed.data.requestId);
  clearTimeout(entry.timer);
  if (parsed.data.ok) entry.resolve(parsed.data.result);
  else entry.reject(new Error(parsed.data.error ?? "Extension operation failed."));
});
async function request(type: string, payload: unknown): Promise<unknown> {
  if (vscode) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Extension request timed out.")); }, 420000);
      pending.set(requestId, { resolve, reject, timer });
      vscode.postMessage({ requestId, type, payload });
    });
  }
  if (type === "configure") return { message: "서버 시작 전 EVIDE_LLM_BASE_URL, EVIDE_LLM_MODEL, EVIDE_LLM_API_KEY 환경변수를 설정하세요. 기본 URL에는 /v1을 포함하세요." };
  const response = await fetch(`/api/${type}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Evide-Token": token }, body: JSON.stringify(payload), signal: AbortSignal.timeout(420000) });
  const data = replySchema.parse(await response.json());
  if (!response.ok || !data.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data.result;
}
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function showFile(): void {
  preview.textContent = current?.files[file.value] ?? "";
}
function updateDiagram(): void {
  if (!current) return;
  const parsed = z.enum(["architecture", "erd", "class", "tree"]).safeParse(diagram.value);
  if (!parsed.success) return;
  const data = current.diagrams[parsed.data];
  document.querySelector<HTMLElement>("#ir")!.textContent = JSON.stringify(data.ir, null, 2);
  document.querySelector<HTMLElement>("#diagram-status")!.textContent = data.status === "rendered" ? "실제 Archify HTML 생성 완료" : `WARN · ${data.status} · IR은 보존되었습니다. Archify CLI를 설치·점검하세요.`;
  document.querySelector<HTMLButtonElement>("#view-diagram")!.disabled = busy || data.status !== "rendered";
}
function setTab(name: string): void {
  tab = name;
  document.querySelector<HTMLElement>("#file-panel")!.hidden = tab === "archify";
  document.querySelector<HTMLElement>("#diagram-panel")!.hidden = tab !== "archify";
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) button.setAttribute("aria-pressed", String(button.dataset.tab === tab));
  if (!current) return;
  const names = Object.keys(current.files).filter((name) => tab === "pmo" ? name.startsWith("docs/pmo/") : tab === "analysis" ? name === "diagrams/source-analysis.json" : !name.endsWith(".html")).sort();
  file.replaceChildren(...names.map((name) => new Option(name, name)));
  showFile(); updateDiagram();
}
async function action(work: () => Promise<void>): Promise<void> {
  if (busy) return;
  setBusy(true);
  try { await work(); }
  catch (error) { notify(error instanceof Error ? error.message : "작업에 실패했습니다.", true); }
  finally { setBusy(false); }
}
document.querySelector("#generate")!.addEventListener("click", () => { void action(async () => {
  if (!prompt.value.trim()) throw new Error("자연어 요구사항을 입력하세요.");
  current = undefined; resultPanel.hidden = true;
  const frame = document.querySelector<HTMLIFrameElement>("#diagram-frame")!;
  frame.hidden = true; frame.removeAttribute("src");
  notify("LLM 설계 해석 → 코드·DDL·문서 생성 → 정적 검증 → 선택적 Archify 렌더링 중…");
  current = artifactSchema.parse(await request("generate", { prompt: prompt.value }));
  resultPanel.hidden = false;
  document.querySelector<HTMLElement>("#title")!.textContent = current.plan.title;
  document.querySelector<HTMLElement>("#summary")!.textContent = current.plan.summary;
  document.querySelector("#assumptions")!.replaceChildren(...current.plan.assumptions.map((text) => { const li = document.createElement("li"); li.textContent = text; return li; }));
  document.querySelector("#findings")!.replaceChildren(...current.findings.map((finding) => { const li = document.createElement("li"); li.textContent = `${finding.severity} ${finding.code}: ${finding.message}`; return li; }));
  setTab("files");
  notify(`${Object.keys(current.files).length}개 파일 생성 완료. 정적 검사 범위만 검증했으며 Maven 시험·기관 준수 심사는 미실행입니다. 가정을 검토한 뒤 적용하세요.`);
}); });
document.querySelector("#configure")!.addEventListener("click", () => { void action(async () => {
  const response = z.object({ message: z.string() }).parse(await request("configure", {})); notify(response.message);
}); });
document.querySelector("#apply")!.addEventListener("click", () => { void action(async () => {
  if (!current) throw new Error("먼저 생성하세요.");
  const response = z.object({ message: z.string() }).parse(await request("apply", { id: current.id })); notify(response.message);
}); });
document.querySelector("#export")!.addEventListener("click", () => { void action(async () => {
  if (!current) throw new Error("먼저 생성하세요.");
  if (vscode) {
    const response = z.object({ message: z.string() }).parse(await request("export", { id: current.id })); notify(response.message);
  } else {
    const response = await fetch(`/api/export?id=${encodeURIComponent(current.id)}`, { headers: { "X-Evide-Token": token } });
    if (!response.ok) throw new Error(replySchema.parse(await response.json()).error ?? "ZIP export failed.");
    download(await response.blob(), `${current.plan.projectName}.zip`); notify("ZIP 내보내기 완료.");
  }
}); });
document.querySelector("#save")!.addEventListener("click", () => {
  if (!current || !file.value) return;
  download(new Blob([current.files[file.value] ?? ""], { type: "text/plain;charset=utf-8" }), file.value.split("/").at(-1) ?? "artifact.txt");
});
document.querySelector("#view-diagram")!.addEventListener("click", () => { void action(async () => {
  if (!current) return;
  const kind: DiagramKind = z.enum(["architecture", "erd", "class", "tree"]).parse(diagram.value);
  if (vscode) {
    const response = z.object({ message: z.string() }).parse(await request("diagram", { id: current.id, kind })); notify(response.message);
  } else {
    const frame = document.querySelector<HTMLIFrameElement>("#diagram-frame")!;
    frame.src = `/api/diagram?id=${encodeURIComponent(current.id)}&kind=${kind}`; frame.hidden = false;
  }
}); });
file.addEventListener("change", showFile);
diagram.addEventListener("change", updateDiagram);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) button.addEventListener("click", () => setTab(button.dataset.tab ?? "files"));
if (!vscode) {
  setBusy(true);
  void fetch("/api/session").then(async (response) => {
    if (!response.ok) throw new Error(`Local session failed (HTTP ${response.status}).`);
    const data = z.object({ ok: z.literal(true), result: z.object({ token: z.string(), outputRoot: z.string() }) }).parse(await response.json());
    token = data.result.token; notify(`준비됨 · 적용 위치: ${data.result.outputRoot}\\프로젝트명 · LLM 설정이 필요합니다.`); setBusy(false);
  }).catch((error: unknown) => { notify(error instanceof Error ? error.message : "서버 연결 실패", true); });
}
