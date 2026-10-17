import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { EventEmitter } from "node:events";
import type { RunCard } from "./runcard.js";
import type { Site, Capability } from "./site.js";
import { CAPABILITY_MAP } from "./providers.js";
import { stripeCli, reloadEnv } from "./stripecli.js";
import { sh } from "./createos.js";

export const policy = parseYaml(readFileSync("policy.yaml", "utf8"));
export const approvals = new EventEmitter();
approvals.setMaxListeners(50);

export type RequisitionInput = { capability: string; reason: string; env_names?: string[]; expected_usage?: string; tier?: string };

/** Purchase-grade guardrails BEFORE the agent runs: per-provider monthly caps applied through Stripe Projects billing. */
export async function applyGuardrails(card: RunCard) {
  const caps: Record<string, number> = policy.spend?.provider_caps_usd ?? {};
  const applied: Record<string, string> = {};
  for (const [provider, usd] of Object.entries(caps)) {
    const r = await stripeCli(["projects", "billing", "update", "--limit", String(usd), "--provider", provider, "--json"], 60_000);
    applied[provider] = r.json?.ok ? `$${Number(r.json.data?.usage_limits?.max_amount ?? usd * 100) / 100}/${r.json.data?.usage_limits?.recurring_interval ?? "month"}` : `failed: ${r.json?.error?.message ?? "unknown"}`;
  }
  card.add("projects.guardrails", { command: "stripe projects billing update --limit <usd> --provider <p>", providerCaps: applied, tiers: policy.requisitions.tiers, environment: policy.environment });
}

/** What the stack actually cost, straight from Stripe Projects. */
export async function recordSpend(card: RunCard) {
  const r = await stripeCli(["projects", "spend", "--json"], 60_000);
  const months = r.json?.data?.months ?? [];
  card.add("projects.spend", { command: "stripe projects spend --json", months, totalUsd: months.reduce((a: number, m: any) => a + Number(m.total ?? 0), 0) / 100 || 0, note: months.length ? undefined : "no charges: every requisition was free tier" });
}

async function directoryQuote(query: string) {
  const cacheFile = "runs/directory-cache.json";
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  if (cache[query]) return cache[query];
  const r = await stripeCli(["directory", "search", query, "--format", "json"], 30_000);
  const list = Array.isArray(r.json) ? r.json.slice(0, 5).map((p: any) => ({ name: p.display_name, username: p.username, next: p.next_actions?.[0]?.command })) : [];
  cache[query] = list;
  writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
  return list;
}

export class Broker {
  private count = 0;
  constructor(private card: RunCard, private site: Site) {}

  async requisition(input: RequisitionInput): Promise<string> {
    const cap = input.capability as Capability;
    const map = CAPABILITY_MAP[cap];
    const reqId = `req_${this.card.job}_${++this.count}`;
    this.card.add("requisition.filed", { reqId, ...input });

    // 1. policy (deterministic)
    const allowedCaps: string[] = policy.requisitions.allowed_capabilities;
    if (!map || !allowedCaps.includes(cap)) return this.deny(reqId, `capability "${input.capability}" is not on this site's allowlist (${allowedCaps.join(", ")})`);
    if (this.count > policy.requisitions.max_per_job) return this.deny(reqId, `requisition limit (${policy.requisitions.max_per_job}) reached for this job`);
    if (input.tier && !["free", "hobby"].includes(String(input.tier).toLowerCase()) && policy.requisitions.tiers === "free_only")
      return this.deny(reqId, `paid tier "${input.tier}" is denied by policy (tiers: free_only). Ask a human operator to change policy.yaml.`);
    if (this.site.caps.has(cap)) return `Capability "${cap}" is already granted. Use the existing env vars; requests go through the site proxy.`;

    // 2. quote: Stripe Directory (discovery) + Stripe Projects catalog (the command is rebuilt from validated IDs, never from search text)
    const candidates = map.via === "stripe-projects" ? await directoryQuote(map.query) : [];
    const command = map.via === "stripe-projects" ? `stripe projects add ${map.provider}/${map.service} --json --non-interactive --accept-tos` : "operator Stripe test account (no provisioning)";
    const quote = { reqId, capability: cap, provider: map.provider, service: map.service, tier: "free", priceUsd: 0, envNames: input.env_names ?? [], command, directoryCandidates: candidates };
    this.card.add("requisition.quote", quote);

    // 3. approval: in-policy free-tier requests auto-approve under execute_within_perimeter; otherwise wait for a human
    if (policy.autonomy !== "execute_within_perimeter") {
      this.card.add("requisition.awaiting_approval", { reqId });
      const ok = await new Promise<boolean>((res) => {
        const t = setTimeout(() => res(false), 180_000);
        approvals.once(reqId, (v: boolean) => { clearTimeout(t); res(v); });
      });
      if (!ok) return this.deny(reqId, "a human declined the requisition");
    }
    this.card.add("requisition.approved", { reqId, by: policy.autonomy === "execute_within_perimeter" ? "policy (in-perimeter, free tier)" : "human" });

    // 4. provision through Stripe Projects (or bind if this project already holds the resource)
    if (map.via === "stripe-projects") {
      const status = await stripeCli(["projects", "status", "--json"], 60_000);
      const resources = JSON.stringify(status.json ?? {});
      const exists = resources.includes(map.resourceName);
      if (!exists) {
        let add = await stripeCli(["projects", "add", `${map.provider}/${map.service}`, "--json", "--non-interactive", "--accept-tos"], 180_000);
        if (add.json?.error?.code === "PLAN_REQUIRED" && map.plan) {
          await stripeCli(["projects", "add", map.plan, "--testmode=false", "--accept-tos", "--yes"], 180_000);
          add = await stripeCli(["projects", "add", `${map.provider}/${map.service}`, "--json", "--non-interactive", "--accept-tos"], 180_000);
        }
        this.card.add("requisition.provisioned", { reqId, command, ok: add.json?.ok ?? add.code === 0, resource: add.json?.data?.service?.name, error: add.json?.error?.message });
        if (!(add.json?.ok ?? add.code === 0)) return this.deny(reqId, `provisioning failed: ${add.json?.error?.message ?? "unknown error"}`);
      } else {
        this.card.add("requisition.provisioned", { reqId, command, ok: true, resource: map.resourceName, note: "already provisioned in this Stripe project; bound to this job" });
      }
      reloadEnv();
    }

    // 5. load the REAL secret into the proxy (never the agent VM) and widen the proxy's capability set
    const secrets = map.secrets();
    if (!secrets) return this.deny(reqId, "credentials not found after provisioning");
    await this.site.grant(cap, secrets);

    // 6. receiving inspection: prove the capability works end to end THROUGH the perimeter, from the agent VM
    const probe = { database: `curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST $NEON_FETCH_ENDPOINT -H "Neon-Connection-String: $DATABASE_URL" -H 'content-type: application/json' -d '{"query":"select 1","params":[]}'`,
      email: `curl -s -o /dev/null -w '%{http_code}' --max-time 20 $RESEND_BASE_URL/domains -H "Authorization: Bearer $RESEND_API_KEY"`,
      payments: `curl -s -o /dev/null -w '%{http_code}' --max-time 20 $STRIPE_API_BASE/v1/balance -H "Authorization: Bearer $STRIPE_SECRET_KEY"` }[cap];
    const r = await sh(this.site.agent, probe, 60_000).catch(() => null);
    const code = r?.stdout.trim() ?? "error";
    this.card.add("requisition.receipt", { reqId, capability: cap, inspection: "agent VM -> proxy -> provider, using placeholder credentials", httpStatus: code, ok: /^2\d\d$/.test(code) });
    return [
      `GRANTED ${reqId}: capability "${cap}" via ${map.provider}/${map.service} (${map.via}).`,
      `Your env vars are unchanged placeholders; the site proxy now injects real credentials for: ${cap === "database" ? "$NEON_FETCH_ENDPOINT" : cap === "email" ? "$RESEND_BASE_URL/emails" : "$STRIPE_API_BASE/v1/*"}.`,
      `Write a quick smoke test against it and run it now.`,
    ].join("\n");
  }

  private deny(reqId: string, reason: string) {
    this.card.add("requisition.denied", { reqId, reason });
    return `DENIED ${reqId}: ${reason}`;
  }
}
