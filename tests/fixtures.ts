import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import type { Plan } from "../src/engine.ts";

export const plan: Plan = {
  projectName: "citizen-platform", title: "민원·공지 플랫폼", summary: "독립 민원 승인 서비스와 공지 CRUD",
  assumptions: ["서비스별 단일 엔터티, 별도 DB, JWT scope로 권한 제어"],
  unsupportedRequirements: [],
  services: [
    { name: "complaint", label: "민원", approval: true, fields: [
      { name: "title", label: "제목", type: "string", required: true, maxLength: 100 },
      { name: "content", label: "내용", type: "string", required: true, maxLength: 1000 },
      { name: "quantity", label: "수량", type: "long", required: false, maxLength: 100 },
      { name: "amount", label: "금액", type: "decimal", required: false, maxLength: 100 },
      { name: "enabled", label: "활성", type: "boolean", required: false, maxLength: 100 },
      { name: "dueDate", label: "기한", type: "date", required: false, maxLength: 100 },
    ] },
    { name: "notice", label: "공지", approval: false, fields: [
      { name: "title", label: "제목", type: "string", required: false, maxLength: 80 },
    ] },
  ],
};

export async function provider(options: { status?: number; content?: string; delay?: number; inspect?: (data: unknown, authorization: string | undefined) => void } = {}) {
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => {
      options.inspect?.(JSON.parse(data), req.headers.authorization);
      setTimeout(() => {
        res.writeHead(options.status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: options.content ?? JSON.stringify(plan) } }] }));
      }, options.delay ?? 0);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    config: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model", apiKey: "test-only-not-a-real-key" },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
