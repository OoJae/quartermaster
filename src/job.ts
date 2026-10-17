import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { RunCard } from "./runcard.js";
import { Site } from "./site.js";
import { Broker, applyGuardrails, recordSpend } from "./requisition.js";
import { runAgent } from "./agent.js";
import { ensureOperatorBase, prepareVerifier, runVerifier, graderPackSha } from "./verifier.js";
import { authorize, settle } from "./settle.js";
import { cos, sh, destroyQuietly, reapSites } from "./createos.js";
import { TASK } from "./task.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export type JobOptions = { keepSite?: boolean; seedBug?: boolean };

export async function runJob(jobId: string, opts: JobOptions = {}) {
  const card = new RunCard(jobId);
  const t0 = Date.now();
  let site: Site | null = null;
  let verifierP: ReturnType<typeof prepareVerifier> | null = null;
  try {
    // 0. pin the rules of the job BEFORE any work happens
    const pins = {
      grader_pack_sha256: graderPackSha(),
      task_sha256: sha(TASK),
      policy_sha256: sha(readFileSync("policy.yaml")),
    };
    card.add("job.start", { job: jobId, pins });
    const reaped = await reapSites();
    if (reaped.length) card.add("site.reap_previous", { destroyed: reaped });

    // 1. client authorizes (not pays) $49; Stripe's timestamp witnesses the pins
    const pi = await authorize(card, pins);

    // 2. sealed operator base (graders + offline fakes), reused across jobs
    const base = await ensureOperatorBase(card);
    // fork the verifier now, in parallel with the build; it stays sealed and untouched until "done"
    verifierP = prepareVerifier(card, base);
    verifierP.catch(() => {});

    // 3. the site: credential proxy + keyless agent VM locked to the proxy
    site = new Site(jobId, card);
    await site.up();
    const probe = await site.probe();
    if (!probe.ok) throw new Error("perimeter probe failed; refusing to run the agent");

    // 3b. purchase-grade guardrails on the stack before any agent action
    await applyGuardrails(card);

    // 4. the agent builds; infra arrives only through requisitions
    const broker = new Broker(card, site);
    await runAgent(card, site, broker);

    // 5. package exactly what the agent produced (code + node_modules, no git metadata)
    const pack = await sh(site.agent, "cd /workspace && tar --exclude=.git -czf /tmp/app.tgz app && ls -la /tmp/app.tgz", 120_000);
    card.add("job.package", { ok: pack.code === 0, detail: pack.stdout.trim().slice(-200) });
    const tgz = new Uint8Array(await site.agent.files.download("/tmp/app.tgz"));

    // 6. hidden acceptance tests in a fork of the sealed base (not of the agent VM)
    const { fork } = await verifierP;
    const { verdict, verdictSha256 } = await runVerifier(card, fork, tgz);

    // 7. hygiene: every VM we created is accounted for (no orphans)
    const expected = new Set([base.id, site.proxy.id, site.agent.id, fork.id]);
    const live = (await cos.listSandboxes({ limit: 100 })).filter((b) => !["destroyed", "destroying", "failed"].includes(b.toJSON().status));
    const orphans = live.filter((b) => !expected.has(b.id) && (b.toJSON().name ?? "").startsWith("q"));
    card.add("hygiene.check", { live: live.length, orphans: orphans.map((b) => b.toJSON().name) });

    // 7b. what the stack cost, from Stripe Projects
    await recordSpend(card).catch(() => {});

    // 8. settle: capture for verified work, release the hold otherwise
    const result = await settle(card, pi.id, verdict, { verdictSha256, runCardHead: card.head, hygieneOk: orphans.length === 0 });

    // 9. the sandbox becomes deployed infrastructure: keep the verified build running behind CreateOS ingress
    let liveUrl: string | undefined;
    if (opts.keepSite && result.captured > 0) {
      await site.agent.processes.create({ cmd: "bash", args: ["-lc", "cd /workspace/app && npm start > /tmp/live.log 2>&1"] });
      await site.agent.setIngress(true);
      await site.agent.waitForPortReady(3000, { timeoutMs: 45_000 }).catch(() => {});
      liveUrl = site.agent.previewUrl(3000);
      card.add("app.live", { url: liveUrl, note: "verified build running in its microVM behind CreateOS ingress; still keyless, egress still proxy-only" });
    }

    card.add("job.done", { seconds: Math.round((Date.now() - t0) / 1000), captured: result.captured, status: result.status, verdict: { criticalPass: verdict.criticalPass, normal: `${verdict.normalPassed}/${verdict.normalTotal}` }, runCardHead: card.head, liveUrl });
    return { card, result, verdict, liveUrl };
  } catch (e: any) {
    card.add("job.error", { message: String(e?.message ?? e) });
    throw e;
  } finally {
    if (site) await site.down(!!opts.keepSite).catch(() => {});
    if (verifierP) await verifierP.then((v) => destroyQuietly(v.fork)).catch(() => {});
  }
}
