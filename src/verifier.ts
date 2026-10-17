import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Sandbox } from "@nodeops-createos/sandbox";
import { cos, sh, destroyQuietly, DENY_ALL } from "./createos.js";
import type { RunCard } from "./runcard.js";

const BASE_NAME = "qm-opbase";
const GRADER_FILES = ["shim.mjs", "fakes.mjs", "run.mjs"];

export function graderPackSha() {
  const h = createHash("sha256");
  for (const f of GRADER_FILES) h.update(readFileSync(`graders/${f}`));
  return h.digest("hex");
}

/** The operator base: graders + local Postgres + offline fakes, built once, then sealed (deny-all, no network) and paused. */
export async function ensureOperatorBase(card: RunCard, rebuild = false): Promise<Sandbox> {
  const existing = (await cos.listSandboxes({ limit: 100 })).find((b) => b.toJSON().name === BASE_NAME && b.toJSON().status === "paused");
  if (existing && !rebuild) {
    card.add("verifier.base", { reused: true, id: existing.id, sealed: "no network, deny-all egress, paused" });
    return existing;
  }
  if (existing) await destroyQuietly(existing);
  const t0 = Date.now();
  const base = await cos.createSandbox({ shape: "s-2vcpu-2gb", rootfs: "devbox:1", name: BASE_NAME });
  await base.waitUntilRunning();
  const setup = await sh(base, [
    "set -e",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq >/dev/null 2>&1 || true",
    "apt-get install -y -qq postgresql >/dev/null 2>&1",
    "(service postgresql start || pg_ctlcluster $(ls /etc/postgresql) main start) >/dev/null 2>&1",
    "sleep 2",
    "su postgres -c \"psql -qc \\\"create user qm with password 'qm' superuser;\\\"\" || true",
    "su postgres -c 'createdb -O qm qm' || true",
    "id app >/dev/null 2>&1 || useradd -m -s /bin/bash app",
    "mkdir -p /opt/graders && cd /opt/graders && npm init -y >/dev/null && npm i --silent pg@8 >/dev/null 2>&1",
    "NODE_REAL=$(readlink -f $(command -v node)); NODE_HOME=$(dirname $(dirname $NODE_REAL)); if [ \"$NODE_HOME\" = /usr ] || [ \"$NODE_HOME\" = /usr/local ]; then echo $NODE_HOME/bin > /opt/graders/node_bin; else rm -rf /opt/node && cp -a $NODE_HOME /opt/node && chmod -R a+rX /opt/node && echo /opt/node/bin > /opt/graders/node_bin; fi",
    "runuser -u app -- env PATH=$(cat /opt/graders/node_bin):/usr/bin:/bin npm --version >/dev/null",
    "echo base-ok",
  ].join(" && "), 900_000);
  if (!setup.stdout.includes("base-ok")) throw new Error("operator base setup failed: " + (setup.stderr || setup.stdout).slice(-500));
  for (const f of GRADER_FILES) await base.files.upload(`/opt/graders/${f}`, readFileSync(`graders/${f}`));
  await sh(base, "chmod 700 /opt/graders && chown -R root:root /opt/graders");
  await base.processes.create({ cmd: "node", args: ["/opt/graders/shim.mjs"] });
  await base.processes.create({ cmd: "node", args: ["/opt/graders/fakes.mjs"] });
  await new Promise((r) => setTimeout(r, 1500));
  await base.setEgress(DENY_ALL);
  await base.pause();
  await base.waitUntilPaused();
  card.add("verifier.base", { reused: false, id: base.id, buildSeconds: Math.round((Date.now() - t0) / 1000), graderPackSha256: graderPackSha(), sealed: "no network, deny-all egress, paused" });
  return base;
}

export type Verdict = {
  critical: Record<string, boolean>; normal: Record<string, boolean>; notes: string[];
  criticalPass: boolean; normalPassed: number; normalTotal: number; appLogTail?: string;
};

/** Fork the base (NOT the agent VM), drop in only the agent's app, run graders by absolute path, read the verdict from stdout. */
export async function verify(card: RunCard, base: Sandbox, appTgz: Uint8Array): Promise<{ verdict: Verdict; verdictSha256: string; forkMs: number }> {
  const t0 = Date.now();
  const fork = await base.fork({ start_paused: false, egress: DENY_ALL });
  try {
    await fork.waitUntilRunning();
    const forkMs = Date.now() - t0;
    card.add("verifier.fork", { from: base.id, id: fork.id, forkMs, network: "none", egress: DENY_ALL });
    await fork.files.upload("/tmp/app.tgz", appTgz as any);
    await sh(fork, "rm -rf /home/app/app && mkdir -p /home/app && tar xzf /tmp/app.tgz -C /home/app && chown -R app:app /home/app/app && ls /home/app/app | head -20");
    const r = await sh(fork, "node /opt/graders/run.mjs", 300_000);
    const last = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
    const verdict = JSON.parse(last) as Verdict;
    const verdictSha256 = createHash("sha256").update(last).digest("hex");
    card.add("verifier.verdict", { ...verdict, verdictSha256 });
    return { verdict, verdictSha256, forkMs };
  } finally {
    await destroyQuietly(fork);
    card.add("verifier.destroyed", { id: fork.id });
  }
}
