import Stripe from "stripe";
import { env } from "./env.js";
import type { RunCard } from "./runcard.js";
import type { Verdict } from "./verifier.js";

let _stripe: Stripe | null = null;
const stripe = () => (_stripe ??= new Stripe(env.stripeTestKey()));

export const PRICE_CENTS = 4900;

/** Authorize (not charge) the job fee up front. Metadata pins the hidden-test and policy hashes BEFORE the agent starts. */
export async function authorize(card: RunCard, pins: Record<string, string>) {
  const pi = await stripe().paymentIntents.create({
    amount: PRICE_CENTS, currency: "usd", capture_method: "manual",
    payment_method: "pm_card_visa", confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    description: `Quartermaster job ${card.job}: pay only if hidden tests pass`,
    metadata: { job: card.job, ...pins },
  });
  card.add("stripe.authorized", { paymentIntent: pi.id, status: pi.status, amount: pi.amount, amount_received: pi.amount_received, pins });
  return pi;
}

/** Critical checks gate all-or-nothing; otherwise capture in proportion to normal checks passed. */
export async function settle(card: RunCard, piId: string, verdict: Verdict, extra: { verdictSha256: string; runCardHead: string; hygieneOk: boolean }) {
  const s = stripe();
  if (!verdict.criticalPass || !extra.hygieneOk) {
    const pi = await s.paymentIntents.cancel(piId, { cancellation_reason: "abandoned" });
    const reason = !extra.hygieneOk ? "site hygiene check failed" : "critical hidden check failed";
    card.add("stripe.released", { paymentIntent: pi.id, status: pi.status, amount_received: pi.amount_received, reason });
    return { status: pi.status, captured: 0, reason };
  }
  const amount = Math.round((PRICE_CENTS * verdict.normalPassed) / verdict.normalTotal);
  if (amount < 50) {
    const pi = await s.paymentIntents.cancel(piId, { cancellation_reason: "abandoned" });
    card.add("stripe.released", { paymentIntent: pi.id, status: pi.status, reason: "below minimum" });
    return { status: pi.status, captured: 0, reason: "below minimum" };
  }
  const pi = await s.paymentIntents.capture(piId, {
    amount_to_capture: amount,
    metadata: { verdict_sha256: extra.verdictSha256, run_card_head: extra.runCardHead, normal_passed: `${verdict.normalPassed}/${verdict.normalTotal}` },
  });
  card.add("stripe.captured", { paymentIntent: pi.id, status: pi.status, amount_received: pi.amount_received, of: PRICE_CENTS });
  return { status: pi.status, captured: pi.amount_received, reason: "verified" };
}
