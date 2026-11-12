import { z } from "zod";

export class EvideError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "EvideError";
    this.status = status;
  }
}

const reserved = new Set(("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public record return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var yield sealed permits id status approver rejectReason frstRegisterId frstRegistPnttm lastUpdusrId lastUpdtPnttm select insert update delete table from where order group user values schema key limit offset").toLowerCase().split(" "));
const identifier = z.string().regex(/^[a-z][a-zA-Z0-9]{1,31}$/).refine(
  (value) => !reserved.has(value.toLowerCase()), "Reserved identifier",
);
export const fieldSchema = z.object({
  name: identifier,
  label: z.string().min(1).max(100),
  type: z.enum(["string", "long", "decimal", "boolean", "date"]),
  required: z.boolean(),
  maxLength: z.number().int().min(1).max(2000),
}).strict();
export const planSchema = z.object({
  projectName: z.string().regex(/^[a-z][a-z0-9-]{2,40}$/).refine((s) => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(s)),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(2000),
  assumptions: z.array(z.string().min(1).max(500)).max(20),
  unsupportedRequirements: z.array(z.string().min(1).max(500)).max(20),
  services: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9]{2,23}$/).refine((s) => !reserved.has(s)),
    label: z.string().min(1).max(100),
    approval: z.boolean(),
    fields: z.array(fieldSchema).min(1).max(12),
  }).strict()).min(1).max(4),
}).strict().superRefine((plan, ctx) => {
  if (new Set(plan.services.map((s) => s.name)).size !== plan.services.length) {
    ctx.addIssue({ code: "custom", path: ["services"], message: "Duplicate service names" });
  }
  for (const [index, service] of plan.services.entries()) {
    if (new Set(service.fields.map((f) => f.name.toLowerCase())).size !== service.fields.length) {
      ctx.addIssue({ code: "custom", path: ["services", index, "fields"], message: "Duplicate fields" });
    }
    if (!service.fields.some((f) => f.type === "string")) {
      ctx.addIssue({ code: "custom", path: ["services", index, "fields"], message: "At least one string field is required for whitelist search" });
    }
  }
});

export type Plan = z.infer<typeof planSchema>;
export type Domain = Plan["services"][number];
export type Field = z.infer<typeof fieldSchema>;
export type Files = Record<string, string>;
export interface Finding { severity: "ERROR" | "WARN"; code: string; message: string; file?: string }
export interface LlmConfig { baseUrl: string; model: string; apiKey: string; timeoutMs?: number }

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const { EVIDE_LLM_BASE_URL: baseUrl, EVIDE_LLM_MODEL: model, EVIDE_LLM_API_KEY: apiKey } = env;
  if (!baseUrl || !model || !apiKey) {
    throw new EvideError("Configure EVIDE_LLM_BASE_URL, EVIDE_LLM_MODEL and EVIDE_LLM_API_KEY. No offline fallback is enabled.", 503);
  }
  return { baseUrl, model, apiKey };
}

export async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new EvideError("Empty provider response.", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new EvideError("Provider response exceeded size limit.", 502);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

export function parsePlan(value: unknown): Plan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    throw new EvideError(`Invalid design: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, 422);
  }
  if (parsed.data.unsupportedRequirements.length) {
    throw new EvideError(`Unsupported requirements require a design extension: ${parsed.data.unsupportedRequirements.join("; ")}`, 422);
  }
  return parsed.data;
}

export async function interpret(prompt: string, config: LlmConfig): Promise<Plan> {
  if (!prompt.trim() || prompt.length > 12000) throw new EvideError("Enter a prompt of 1–12000 characters.");
  let base: URL;
  try { base = new URL(config.baseUrl); } catch { throw new EvideError("Invalid LLM base URL.", 503); }
  if (base.username || base.password || base.search || base.hash ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
    throw new EvideError("LLM endpoints require HTTPS (HTTP is allowed only on loopback), without URL credentials or query parameters.", 503);
  }
  const system = `You are a requirements analyst for an eGovFrame 5 generator. Return JSON only.
Do not generate code. Match ALL user requirements or list unsupported ones.
Supported: 1-4 isolated domain services, one entity each, CRUD, bounded string/long/decimal/boolean/date fields,
whitelist string search, optional PENDING->APPROVED/REJECTED approval. No arbitrary workflows, attachments,
external integrations, multi-entity relations, frontend generation, or extra endpoints are supported.
Do NOT substitute these unsupported features with CRUD. Include them in unsupportedRequirements, which blocks generation.
Never include reserved server fields id, status, approver, rejectReason, frstRegisterId, frstRegistPnttm,
lastUpdusrId, lastUpdtPnttm in fields. They are generated automatically. Names must not be Java or SQL keywords.
At least one string field per service. Domain names are lowercase ASCII letters/digits, 3-24 chars.
Field names are ASCII camelCase, 2-32 chars. projectName is lowercase kebab-case, 3-41 chars.
Use human-readable Korean labels if the prompt is Korean. Explicitly state interpretation assumptions.
Shape (all keys required; maxLength is 1-2000 and used for strings):
{"projectName":"citizen-service","title":"민원 서비스","summary":"...","assumptions":["..."],
"unsupportedRequirements":[],"services":[{"name":"complaint","label":"민원","approval":true,
"fields":[{"name":"title","label":"제목","type":"string","required":true,"maxLength":200}]}]}`;
  let response: Response;
  try {
    response = await fetch(`${base.href.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, temperature: 0, max_tokens: 6000, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 120000),
      redirect: "error",
    });
  } catch (error) {
    throw new EvideError(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      ? "LLM request timed out. No project was generated." : "LLM connection failed. Check the endpoint and network.", 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new EvideError(`LLM returned HTTP ${response.status}. Check provider credentials, model and quota.`, 502);
  }
  const text = await boundedText(response, 1024 * 1024);
  const envelope = z.object({ choices: z.array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({ content: z.string() }) })).min(1) });
  try {
    const data = envelope.parse(JSON.parse(text));
    const first = data.choices[0];
    if (!first || (first.finish_reason && first.finish_reason !== "stop")) throw new EvideError("LLM output was incomplete or refused.", 502);
    return parsePlan(JSON.parse(first.message.content));
  } catch (error) {
    if (error instanceof EvideError) throw error;
    throw new EvideError("LLM response was not a complete JSON project design.", 502);
  }
}
