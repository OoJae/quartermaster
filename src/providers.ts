import { env } from "./env.js";
import type { Capability } from "./site.js";

/** Neon's serverless driver talks HTTP to api.<region>.aws.neon.tech/sql (first label of the endpoint host replaced by "api."). */
export function neonApiHost(conn: string) {
  const host = new URL(conn.replace(/^postgres(ql)?:/, "http:")).hostname;
  return host.replace(/^[^.]+\./, "api.");
}

/** Capability → which Stripe Projects service provides it, and how its secret is loaded into the proxy. */
export const CAPABILITY_MAP: Record<Capability, {
  query: string; provider: string; service: string; plan?: string; resourceName: string;
  secrets: () => Record<string, string> | null; via: "stripe-projects" | "operator-test-account";
}> = {
  database: {
    query: "serverless postgres database", provider: "neon", service: "postgres", plan: "neon/free", resourceName: "neon-postgres",
    via: "stripe-projects",
    secrets: () => { const c = env.neonConn(); return c ? { NEON_CONN: c, NEON_API_HOST: neonApiHost(c) } : null; },
  },
  email: {
    query: "transactional email api", provider: "resend", service: "email", plan: "resend/free", resourceName: "resend-email",
    via: "stripe-projects",
    secrets: () => { const k = env.resendKey(); return k ? { RESEND_KEY: k } : null; },
  },
  payments: {
    query: "payments", provider: "stripe", service: "test-mode", resourceName: "stripe-test-key",
    via: "operator-test-account",
    secrets: () => ({ STRIPE_KEY: env.stripeTestKey() }),
  },
};
