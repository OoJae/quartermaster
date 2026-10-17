import { config } from "dotenv";
import { resolve } from "node:path";

// Stripe Projects writes provider credentials to .env (default environment).
config({ path: resolve(process.cwd(), ".env"), quiet: true });

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}. Run: stripe projects env --pull`);
  return v.replace(/^['"]|['"]$/g, "");
}
const opt = (name: string) => process.env[name]?.replace(/^['"]|['"]$/g, "");

export const env = {
  createosKey: () => opt("CREATEOS_SANDBOX_API_KEY") ?? need("CREATEOS_PROJECT_API_KEY"),
  createosBaseUrl: "https://api.sb.createos.sh",
  neonConn: () => opt("NEON_POSTGRES_CONNECTION_STRING"),
  resendKey: () => opt("RESEND_API_KEY"),
  anthropicKey: () => need("ANTHROPIC_API_KEY"),
  /** The agent's model endpoint: Claude by default; any Anthropic-protocol endpoint via AGENT_BASE_URL/AGENT_API_KEY/AGENT_MODEL. */
  agentLlm: () => {
    const base = opt("AGENT_BASE_URL");
    if (base) return { baseURL: base, apiKey: need("AGENT_API_KEY"), model: opt("AGENT_MODEL") ?? "mimo-v2.6-pro", custom: true };
    return { baseURL: undefined, apiKey: need("ANTHROPIC_API_KEY"), model: opt("AGENT_MODEL") ?? "claude-opus-5-5", custom: false };
  },
  stripeTestKey: () => need("STRIPE_TEST_SECRET_KEY"),
  port: Number(process.env.PORT ?? 4747),
};
