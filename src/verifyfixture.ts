// Push a fixture build (good or buggy) through the real verifier + settlement: pnpm tsx src/verifyfixture.ts good|buggy
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { RunCard, bus } from "./runcard.js";
import { ensureOperatorBase, verify, graderPackSha } from "./verifier.js";
import { authorize, settle } from "./settle.js";
import { TASK } from "./task.js";

const which = process.argv[2] === "buggy" ? "buggy" : "good";
const card = new RunCard(`job-fixture-${which}-${Date.now().toString(36)}`);
bus.on("event", (e) => console.log(`#${e.seq} ${e.kind} ${JSON.stringify(e.data).slice(0, 300)}`));
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
try {
  const pins = { grader_pack_sha256: graderPackSha(), task_sha256: sha(TASK), policy_sha256: sha(readFileSync("policy.yaml")) };
  card.add("job.start", { job: card.job, fixture: which, pins });
  const pi = process.env.STRIPE_TEST_SECRET_KEY ? await authorize(card, pins) : null;
  const base = await ensureOperatorBase(card);
  const tgz = execFileSync("tar", ["-czf", "-", "-C", `fixtures/${which}`, "app"]);
  const { verdict, verdictSha256 } = await verify(card, base, new Uint8Array(tgz));
  if (pi) await settle(card, pi.id, verdict, { verdictSha256, runCardHead: card.head, hygieneOk: true });
  card.add("job.done", { fixture: which, verdict: { criticalPass: verdict.criticalPass, normal: `${verdict.normalPassed}/${verdict.normalTotal}` } });
} catch (e: any) {
  card.add("job.error", { message: String(e?.message ?? e) });
}
process.exit(0);
