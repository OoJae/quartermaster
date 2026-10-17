// List live sandboxes/networks; with --kill, destroy everything except the operator base: pnpm reap [--kill]
import { cos, destroyQuietly } from "./createos.js";

const all = await cos.listSandboxes({ limit: 100 });
const live = all.filter((b) => !["destroyed", "destroying", "failed"].includes(b.toJSON().status));
for (const b of live) console.log(`${b.toJSON().name ?? b.id}\t${b.toJSON().status}`);
if (!live.length) console.log("no live sandboxes");
const nets = await cos.networks.list();
console.log(`networks: ${nets.length}${nets.length ? " (" + nets.map((n) => n.name).join(", ") + ")" : ""}`);
if (process.argv.includes("--kill")) {
  for (const b of live) if (b.toJSON().name !== "qm-opbase") await destroyQuietly(b);
  for (const n of nets) await cos.networks.delete(n.id).catch(() => {});
  console.log("reaped (kept qm-opbase)");
}
process.exit(0);
