// Run one job from the terminal: pnpm job [--keep]
import { runJob } from "./job.js";
import { bus } from "./runcard.js";
import { reloadEnv } from "./stripecli.js";
reloadEnv(); // register every secret in .env for fail-closed scrubbing

bus.on("event", (e) => console.log(`#${e.seq} ${e.kind} ${JSON.stringify(e.data).slice(0, 220)}`));
const job = `job-${Date.now().toString(36)}`;
try {
  const { result, verdict } = await runJob(job, { keepSite: process.argv.includes("--keep") });
  console.log(`\nDONE ${job}: ${result.status} captured=${result.captured} critical=${verdict.criticalPass} normal=${verdict.normalPassed}/${verdict.normalTotal}`);
} catch (e: any) {
  console.error(`\nJOB FAILED ${job}: ${e?.message}`);
}
process.exit(0);
