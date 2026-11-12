import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import path from "node:path";
import { configFromEnv } from "./engine.ts";
import type { LlmConfig } from "./engine.ts";

export async function localConfig(root: string): Promise<LlmConfig> {
  let contents: string;
  try { contents = await readFile(path.join(root, ".env"), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return configFromEnv();
    throw error;
  }
  return configFromEnv({ ...process.env, ...parseEnv(contents) });
}
