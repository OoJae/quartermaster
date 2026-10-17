import { RunCard } from "./runcard.js";
import { ensureOperatorBase } from "./verifier.js";
const card = new RunCard(`base-${Date.now().toString(36)}`);
const t0 = Date.now();
try {
  const b = await ensureOperatorBase(card, process.argv.includes("--rebuild"));
  console.log("operator base ready:", b.id, Math.round((Date.now() - t0) / 1000), "s");
} catch (e: any) { console.error("BASE FAILED:", e?.message); }
process.exit(0);
