import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";
const llm = env.agentLlm();
const client = new Anthropic({ apiKey: llm.apiKey, ...(llm.baseURL ? { baseURL: llm.baseURL } : {}) });
const t0 = Date.now();
try {
  const r = await client.messages.create({
    model: llm.model, max_tokens: 1024,
    tools: [{ name: "run_command", description: "Run a bash command", input_schema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }],
    messages: [{ role: "user", content: "List the files in the current directory using the run_command tool." }],
  } as any);
  console.log(JSON.stringify({ ms: Date.now() - t0, model: r.model, stop_reason: r.stop_reason, content: r.content.map((b: any) => b.type === "tool_use" ? { tool_use: b.name, input: b.input } : { [b.type]: (b.text ?? "").slice(0, 120) }) }, null, 1));
} catch (e: any) { console.log("ERROR", e?.status, e?.message?.slice(0, 300)); }
process.exit(0);
