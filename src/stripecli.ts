import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse as parseDotenv } from "dotenv";
import { registerSecret, scrub } from "./runcard.js";

/** Run a Stripe CLI command on the HOST (the agent never holds a Stripe session). Returns parsed JSON when present. */
export function stripeCli(args: string[], timeoutMs = 120_000): Promise<{ code: number; json: any; text: string }> {
  return new Promise((resolve) => {
    execFile("stripe", args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, cwd: process.cwd() }, (err, stdout, stderr) => {
      const text = `${stdout}${stderr}`;
      let json: any = null;
      const s = stdout.indexOf("{") >= 0 ? stdout.indexOf("{") : stdout.indexOf("[");
      if (s >= 0) {
        const tail = stdout.slice(s);
        try { json = JSON.parse(tail); } catch {
          const e = Math.max(tail.lastIndexOf("}"), tail.lastIndexOf("]"));
          try { json = JSON.parse(tail.slice(0, e + 1)); } catch {}
        }
      }
      resolve({ code: err ? ((err as any).code ?? 1) : 0, json, text: scrub(text).slice(-4000) });
    });
  });
}

/** Re-read .env after Stripe Projects writes new credentials; registers every value as a secret to scrub. */
export function reloadEnv() {
  const parsed = parseDotenv(readFileSync(".env"));
  for (const [k, v] of Object.entries(parsed)) {
    process.env[k] = v;
    if (/KEY|SECRET|TOKEN|CONNECTION_STRING|PASSWORD|CREDENTIALS/.test(k)) registerSecret(v.replace(/^['"]|['"]$/g, ""));
  }
}
