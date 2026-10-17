# Demo runbook (2:20)

**Best path:** open `http://localhost:4747/?replay=<job>&speed=20` to play a real recorded run as a time-lapse (every event is real; gaps are compressed). Use the latest successful agent job.

**Setup, 10 minutes before:**
- `pnpm start`, then open http://localhost:4747.
- Open the Stripe dashboard (test mode) on the Payments tab.
- Open https://oojae.github.io/quartermaster/.

| Time | Say | Show |
|---|---|---|
| 0:00 | "I no longer hand my coding agent my whole .env, and it only gets paid for work it can't fake." | Dashboard KPIs: **Keys held by agent: 0 · Reachable: 1 host (proxy IP)** |
| 0:15 | "Stack set up from an empty dir with Stripe Projects: CreateOS, Neon, Resend." | `stripe projects status` in the terminal |
| 0:25 | "Client authorizes $49. Not charged. The hidden tests' hash is pinned in the PaymentIntent before the agent starts." | Settlement panel `requires_capture`; Stripe dashboard PI metadata `grader_pack_sha256` |
| 0:40 | "The agent runs in a CreateOS microVM whose egress allowlist is one IP: our proxy. Before it runs, we prove it." | Timeline `perimeter.probe`: proxy 200 · internet blocked · Stripe direct blocked · real keys 0 |
| 0:55 | "It writes code, hits the database, gets `no_capability`, and files a requisition. The broker quotes it from Stripe Directory and the Projects catalog, applies policy, provisions via `stripe projects add`, and loads the key into the proxy, never the agent." | Requisition cards + Site map pills lighting up (Neon, Resend, Stripe) |
| 1:20 | "On done, we fork a sealed operator base (not the agent's VM). No network. Hidden checks run there." | `verifier.fork` (measured ms) · `verifier.verdict` |
| 1:40 | "All critical checks pass → Stripe captures." | Settlement: **$49.00 captured**, PI `succeeded` |
| 1:50 | "Here's a build that passes every visible check, 7 of 7, but double-fulfils and accepts forged webhooks." | Run Card of the buggy run: **critical ✗ · 7/7 → $0, hold released** |
| 2:00 | "And the verified build is live right now, still keyless, still proxy-only." | Click **live app ↗** (CreateOS ingress URL) |
| 2:10 | "Every run is a hash-chained Run Card you can verify in your browser. A prompt is a wish; a boundary is a fact." | GitHub Pages gallery → open a Run Card → "chain intact" |

**Fallbacks:**
- A full agent job takes minutes, so demo from a completed run (dashboard job selector) and narrate as a time-lapse.
- Re-run `pnpm tsx src/verifyfixture.ts buggy` live if there's time. The fork is ~50 s, so start it at 0:00.
