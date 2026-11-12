import { z } from "zod";
import { planSchema } from "./engine.ts";

const diagram = z.object({ ir: z.record(z.string(), z.unknown()), html: z.string().optional(), status: z.enum(["rendered", "unavailable", "failed"]) });
export const artifactSchema = z.object({
  id: z.string().uuid(),
  plan: planSchema,
  files: z.record(z.string(), z.string()),
  findings: z.array(z.object({ severity: z.enum(["ERROR", "WARN"]), code: z.string(), message: z.string(), file: z.string().optional() })),
  diagrams: z.object({ architecture: diagram, erd: diagram, class: diagram, tree: diagram }),
  createdAt: z.string(),
});
export const messageSchema = z.object({
  requestId: z.string().uuid(),
  type: z.enum(["generate", "apply", "export", "diagram", "configure"]),
  payload: z.unknown(),
}).strict();
export const replySchema = z.object({ requestId: z.string().uuid().optional(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() });
