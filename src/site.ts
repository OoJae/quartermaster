import type { Sandbox } from "@nodeops-createos/sandbox";
import { cos, sh, memberIp, waitHttp, destroyQuietly, DENY_ALL } from "./createos.js";
import { PROXY_JS, VERDACCIO_YAML } from "./proxyCode.js";
import { RunCard, registerSecret } from "./runcard.js";

export type Capability = "database" | "email" | "payments";

/** Sentinel values the agent sees. Look-alikes, so code written against them is correct; only the proxy grants real access. */
export const SENTINELS = {
  DATABASE_URL: "postgresql://sentinel:SENTINEL@sentinel.invalid/neondb",
  RESEND_API_KEY: "re_SENTINEL_not_a_real_key_0000",
  STRIPE_SECRET_KEY: "sk_test_SENTINEL_not_a_real_key_0000",
};

const PROXY_SECRET_KEYS = { NEON_CONN: "placeholder", NEON_API_HOST: "placeholder", RESEND_KEY: "placeholder", STRIPE_KEY: "placeholder" };

export class Site {
  net!: { id: string; name: string };
  proxy!: Sandbox;
  agent!: Sandbox;
  proxyIp = "";
  private proxyEnv: Record<string, string> = { ...PROXY_SECRET_KEYS };
  private proxyProcId?: string;
  readonly caps = new Set<Capability>();
  readonly sid: string;

  constructor(readonly job: string, readonly card: RunCard) {
    this.sid = job.replace(/[^a-z0-9]/gi, "").slice(-10).toLowerCase();
  }

  async up() {
    const t0 = Date.now();
    this.net = await cos.networks.create({ name: `qn-${this.sid}` });
    this.card.add("site.network", { id: this.net.id, name: this.net.name });

    this.proxy = await cos.createSandbox({
      shape: "s-2vcpu-2gb", rootfs: "devbox:1", name: `qp-${this.sid}`,
      networks: [{ id: this.net.id }], envs: PROXY_SECRET_KEYS, auto_pause_after_seconds: 3600,
    });
    await this.proxy.waitUntilRunning();
    this.proxyIp = await memberIp(this.net.id, `qp-${this.sid}`);
    this.card.add("vm.create", { role: "credential-proxy", id: this.proxy.id, privateIp: this.proxyIp, holds: "real provider secrets (process env only)" });

    await this.proxy.files.upload("/opt/qm/proxy.js", PROXY_JS);
    await this.proxy.files.upload("/opt/qm/verdaccio/config.yaml", VERDACCIO_YAML);
    await this.startProxyProcess();
    await this.proxy.processes.create({ cmd: "bash", args: ["-lc", "npx -y verdaccio@6 --config /opt/qm/verdaccio/config.yaml > /tmp/verdaccio.log 2>&1"] });

    this.agent = await cos.createSandbox({
      shape: "s-2vcpu-4gb", rootfs: "devbox:1", name: `qa-${this.sid}`,
      networks: [{ id: this.net.id }],
      egress: [`${this.proxyIp}/32`],
      ingress_enabled: true,
      envs: {
        ...SENTINELS,
        QM_PROXY: `http://${this.proxyIp}:8080`,
        NEON_FETCH_ENDPOINT: `http://${this.proxyIp}:8080/neon/sql`,
        RESEND_BASE_URL: `http://${this.proxyIp}:8080/resend`,
        STRIPE_API_BASE: `http://${this.proxyIp}:8080`,
        NPM_CONFIG_REGISTRY: `http://${this.proxyIp}:4873`,
        STRIPE_WEBHOOK_SECRET: "whsec_SENTINEL_local_dev_secret_0000",
        PORT: "3000",
      },
      auto_pause_after_seconds: 3600,
    });
    await this.agent.waitUntilRunning();
    this.card.add("vm.create", { role: "agent", id: this.agent.id, egress: [`${this.proxyIp}/32`], keysHeld: 0, envs: "sentinels only" });
    await sh(this.agent, "mkdir -p /workspace/app && cd /workspace/app && git init -q 2>/dev/null; git config --global user.email agent@qm.local; git config --global user.name qm-agent; true");

    const regReady = await waitHttp(this.proxy, "http://127.0.0.1:4873/-/ping", 60, 2000);
    this.card.add("site.ready", { seconds: Math.round((Date.now() - t0) / 1000), registry: regReady });
  }

  private async startProxyProcess() {
    if (this.proxyProcId) {
      try { await this.proxy.processes.signal(this.proxyProcId, "SIGTERM" as any); } catch {}
      await sh(this.proxy, "pkill -f /opt/qm/proxy.js || true");
    }
    const p = await this.proxy.processes.create({ cmd: "node", args: ["/opt/qm/proxy.js"], env: this.proxyEnv });
    this.proxyProcId = p.process_id;
    await waitHttp(this.proxy, "http://127.0.0.1:8080/_qm/health", 20, 500);
  }

  /** Load a real secret into the proxy (never the agent VM) and restart it with the new capability. */
  async grant(cap: Capability, secrets: Record<string, string>) {
    for (const v of Object.values(secrets)) registerSecret(v);
    Object.assign(this.proxyEnv, secrets);
    this.caps.add(cap);
    await this.startProxyProcess();
    this.card.add("proxy.capability", { capability: cap, routes: routesFor(cap), secretLocation: "proxy process env" });
  }

  /** Prove the perimeter from the agent VM: proxy reachable, internet not, and no real secret in its env. */
  async probe() {
    const res = await sh(this.agent, [
      `echo proxy=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${this.proxyIp}:8080/_qm/health)`,
      `echo internet=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://example.com || true)`,
      `echo stripe_direct=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://api.stripe.com || true)`,
      `echo real_keys_in_env=$(env | grep -cE 'npg_|sk_test_[A-Za-z0-9]{20}|re_[A-Za-z0-9]{20}' | tr -d ' ')`,
    ].join("; "), 60_000);
    const kv = Object.fromEntries(res.stdout.trim().split("\n").map((l) => l.split("=")));
    const ok = kv.proxy === "200" && kv.internet !== "200" && kv.stripe_direct !== "200" && kv.real_keys_in_env === "0";
    this.card.add("perimeter.probe", { ...kv, verdict: ok ? "boundary holds" : "BOUNDARY BREACH" });
    return { ok, ...kv };
  }

  async proxyLog(lines = 40) {
    const r = await sh(this.proxy, `ps aux | grep -c '[p]roxy.js' >/dev/null; true`);
    void r;
    return [];
  }

  async down(keepApp = false) {
    if (!keepApp) {
      await destroyQuietly(this.agent);
      await destroyQuietly(this.proxy);
      try { await cos.networks.delete(this.net.id); } catch {}
    }
    this.card.add("site.teardown", { keptLive: keepApp });
  }
}

export function routesFor(cap: Capability) {
  return { database: ["/neon/sql"], email: ["/resend/*"], payments: ["/v1/*"] }[cap];
}

export { DENY_ALL };
