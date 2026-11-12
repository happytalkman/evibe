import { planSchema } from "../engine.ts";
import type { Domain, Plan } from "../engine.ts";
import { z } from "zod";

const service = document.querySelector<HTMLSelectElement>("#service")!;
const operation = document.querySelector<HTMLSelectElement>("#operation")!;
const body = document.querySelector<HTMLTextAreaElement>("#body")!;
const id = document.querySelector<HTMLInputElement>("#record-id")!;
const status = document.querySelector<HTMLElement>("#status")!;
const send = document.querySelector<HTMLButtonElement>("#send")!;
let plan: Plan;
function current(): Domain {
  const value = plan.services.find((s) => s.name === service.value);
  if (!value) throw new Error("Unknown service.");
  return value;
}
function update(): void {
  const selected = current();
  for (const name of ["approve", "reject"]) operation.querySelector<HTMLOptionElement>(`option[value="${name}"]`)!.disabled = !selected.approval;
  if (!selected.approval && ["approve", "reject"].includes(operation.value)) operation.value = "list";
  const approval = ["approve", "reject"].includes(operation.value);
  body.value = JSON.stringify(approval ? { decision: operation.value === "approve" ? "APPROVED" : "REJECTED", ...(operation.value === "reject" ? { rejectReason: "로컬 검증 반려 사유" } : {}) } :
    Object.fromEntries(selected.fields.map((f) => [f.name, ({ string: "local-test".slice(0, f.maxLength), long: 1, decimal: 1.25, boolean: true, date: "2026-01-01" })[f.type]])), null, 2);
  body.disabled = ["list", "get", "delete"].includes(operation.value);
  id.disabled = ["list", "create"].includes(operation.value);
}
send.disabled = true;
void fetch("/plan").then(async (response) => {
  if (!response.ok) throw new Error(`Plan HTTP ${response.status}`);
  plan = planSchema.parse(await response.json());
  document.querySelector<HTMLElement>("#title")!.textContent = `${plan.title} · ${plan.projectName}`;
  service.replaceChildren(...plan.services.map((s) => new Option(s.label, s.name)));
  const ports = [{ name: "Gateway", port: 9000 }, { name: "Config", port: 8888 }, { name: "Eureka", port: 8761 }, ...plan.services.map((s, i) => ({ name: s.label, port: 9101 + i }))];
  document.querySelector("#health")!.replaceChildren(...ports.map((p) => {
    const li = document.createElement("li"), link = document.createElement("a");
    link.href = `http://127.0.0.1:${p.port}/actuator/health`; link.textContent = `${p.name} :${p.port}`; link.target = "_blank"; link.rel = "noopener"; li.append(link); return li;
  }));
  update(); send.disabled = false; status.textContent = "실제 JAR 서비스에 요청할 준비가 되었습니다.";
}).catch((error: unknown) => { status.textContent = error instanceof Error ? error.message : "Local setup failed."; });
service.addEventListener("change", update); operation.addEventListener("change", update);
send.addEventListener("click", () => {
  send.disabled = true;
  void (async () => {
    const selected = current(), op = operation.value;
    const record = z.coerce.number().int().positive().safeParse(id.value);
    if (!id.disabled && !record.success) throw new Error("양의 정수 ID가 필요합니다.");
    const suffix = id.disabled ? "" : `/${record.data}`;
    const approval = ["approve", "reject"].includes(op);
    const method = op === "create" ? "POST" : op === "update" ? "PUT" : op === "delete" ? "DELETE" : approval ? "PATCH" : "GET";
    const tokenResponse = await fetch("/token");
    if (!tokenResponse.ok) throw new Error(`Local JWT helper HTTP ${tokenResponse.status}`);
    const { token } = z.object({ token: z.string() }).parse(await tokenResponse.json());
    const requestBody: unknown = body.disabled ? undefined : JSON.parse(body.value);
    const response = await fetch(`http://127.0.0.1:9000/api/${selected.name}${suffix}${approval ? "/approval" : ""}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(requestBody ? { body: JSON.stringify(requestBody) } : {}), signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    status.textContent = `${method} /api/${selected.name}${suffix}${approval ? "/approval" : ""} → HTTP ${response.status}`;
    status.classList.toggle("error", !response.ok);
    document.querySelector<HTMLElement>("#response")!.textContent = text ? JSON.stringify(JSON.parse(text), null, 2) : "(empty response)";
    if (response.status === 201) {
      const parsed = z.object({ id: z.number().int().positive() }).safeParse(JSON.parse(text));
      if (parsed.success) id.value = String(parsed.data.id);
    }
  })().catch((error: unknown) => { status.textContent = error instanceof Error ? error.message : "API request failed."; status.classList.add("error"); }).finally(() => { send.disabled = false; });
});
