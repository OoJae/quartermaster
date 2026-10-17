// Re-run the hidden checks on the exact build a job was paid for, in a FRESH fork of the sealed base,
// and compare the deterministic checks hash with the original verdict: pnpm tsx src/reverify.ts <job>
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { RunCard, readRun, bus } from "./runcard.js";
import { ensureOperatorBase, prepareVerifier, runVerifier, checksSha256 } from "./verifier.js";

export async function reverify(job: string) {
  const events = readRun(job);
  const original = events.find((e) => e.kind === "verifier.verdict")?.data as any;
  if (!original) throw new Error(`no verdict in run card ${job}`);
  if (!existsSync(`runs/${job}.tgz`)) throw new Error(`no stored build artifact for ${job}`);
  const tgz = new Uint8Array(readFileSync(`runs/${job}.tgz`));
  const card = new RunCard(`reverify-${job}-${Date.now().toString(36)}`);
  const want = checksSha256(original);
  card.add("reverify.start", { job, artifactSha256: createHash("sha256").update(tgz).digest("hex"), originalChecksSha256: want });
  const base = await ensureOperatorBase(card);
  const { fork } = await prepareVerifier(card, base);
  const { verdict } = await runVerifier(card, fork, tgz);
  const got = checksSha256(verdict);
  const reproduced = got === want;
  card.add("reverify.result", { job, reproduced, originalChecksSha256: want, newChecksSha256: got });
  return { reproduced, want, got, card: card.job };
}

if (process.argv[1]?.endsWith("reverify.ts")) {
  bus.on("event", (e) => console.log(`#${e.seq} ${e.kind} ${JSON.stringify(e.data).slice(0, 200)}`));
  const job = process.argv[2];
  try {
    const r = await reverify(job);
    console.log(`\n${r.reproduced ? "REPRODUCED" : "MISMATCH"}: original ${r.want.slice(0, 16)} · re-run ${r.got.slice(0, 16)} (run card ${r.card})`);
  } catch (e: any) { console.error("REVERIFY FAILED:", e?.message); }
  process.exit(0);
}
