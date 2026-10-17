import { createClient, type Sandbox } from "@nodeops-createos/sandbox";
import { env } from "./env.js";

export const cos = createClient({ apiKey: env.createosKey(), baseUrl: env.createosBaseUrl, timeoutMs: 300_000 });

/** A non-routable TEST-NET address: a non-empty allowlist that matches nothing = deny everything. */
export const DENY_ALL = ["192.0.2.1/32"];

export type ShResult = { code: number; stdout: string; stderr: string; ms: number };

export async function sh(box: Sandbox, script: string, timeoutMs = 120_000, extraEnv?: Record<string, string>): Promise<ShResult> {
  const r = await box.runCommand("bash", ["-lc", script], { timeoutMs, ...(extraEnv ? { env: extraEnv } : {}) });
  return { code: r.result.exit_code, stdout: r.result.stdout ?? "", stderr: r.result.stderr ?? "", ms: Math.round(r.exec_ms ?? 0) };
}

export async function memberIp(networkId: string, name: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const members = (await cos.networks.get(networkId)).members ?? [];
    const ip = members.find((m: any) => m.name === name)?.ip;
    if (ip) return ip;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no private IP for ${name}`);
}

export async function waitHttp(box: Sandbox, url: string, tries = 60, delayMs = 2000): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await sh(box, `curl -s -o /dev/null -w '%{http_code}' --max-time 3 ${url}`, 20_000).catch(() => null);
    if (r && /^[23]\d\d$/.test(r.stdout.trim())) return true;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return false;
}

export async function destroyQuietly(box?: Sandbox | null) {
  if (!box) return;
  try {
    await box.destroy();
    await box.waitUntilDestroyed();
  } catch {}
}

/** Reaper: every running/paused sandbox that is not in the keep set is destroyed. */
export async function reap(keepIds: string[] = []) {
  const all = await cos.listSandboxes({ limit: 100 });
  const live = all.filter((b) => !["destroyed", "destroying", "failed"].includes(b.toJSON().status) && !keepIds.includes(b.id));
  for (const b of live) await destroyQuietly(b);
  return live.map((b) => b.toJSON().name ?? b.id);
}

/** Remove sites kept live by earlier jobs (qp-/qa- sandboxes, qn- networks) so a new job fits the plan's slot cap. */
export async function reapSites(): Promise<string[]> {
  const all = await cos.listSandboxes({ limit: 100 });
  const old = all.filter((b) => /^(qp|qa)-/.test(b.toJSON().name ?? "") && !["destroyed", "destroying", "failed"].includes(b.toJSON().status));
  for (const b of old) await destroyQuietly(b);
  for (const n of await cos.networks.list()) if (n.name.startsWith("qn-")) await cos.networks.delete(n.id).catch(() => {});
  return old.map((b) => b.toJSON().name ?? b.id);
}
