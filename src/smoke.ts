// Smoke test for the site layer: perimeter + capability grant. Run: pnpm tsx src/smoke.ts
import { RunCard, verifyChain, readRun } from "./runcard.js";
import { Site } from "./site.js";
import { sh } from "./createos.js";
import { env } from "./env.js";
import { neonApiHost } from "./providers.js";

const job = `smoke-${Date.now().toString(36)}`;
const card = new RunCard(job);
const site = new Site(job, card);
try {
  await site.up();
  console.log("probe before grant:", await site.probe());
  const before = await sh(site.agent, `curl -s --max-time 10 -X POST $NEON_FETCH_ENDPOINT -H "Neon-Connection-String: $DATABASE_URL" -d '{"query":"select 1 as ok","params":[]}'`);
  console.log("db before grant:", before.stdout.slice(0, 200));
  const conn = env.neonConn()!;
  await site.grant("database", { NEON_CONN: conn, NEON_API_HOST: neonApiHost(conn) });
  const after = await sh(site.agent, `curl -s --max-time 15 -X POST $NEON_FETCH_ENDPOINT -H "Neon-Connection-String: $DATABASE_URL" -d '{"query":"select 1 as ok","params":[]}'`);
  console.log("db after grant:", after.stdout.slice(0, 200));
} catch (e: any) {
  console.error("SMOKE FAILED:", e?.name, e?.message);
} finally {
  await site.down();
  const evs = readRun(job);
  console.log(`run card: ${evs.length} events, chain ${verifyChain(evs) === -1 ? "intact" : "BROKEN"}`);
  process.exit(0);
}
