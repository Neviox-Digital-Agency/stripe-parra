import type Stripe from 'stripe';

// Helpers for the Stripe API versions from "basil" (2025-03-31) on, where the invoice no longer
// carries `subscription` and `payment_intent` and the period dates moved to the subscription item.

// Id of an expandable Stripe field that may be a string or an object.
export function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

// Stripe subscription an invoice belongs to (under parent.subscription_details).
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return stripeId(invoice.parent?.subscription_details?.subscription);
}

// PaymentIntent that paid an invoice (retrieve the invoice with expand: ['payments']).
export function invoicePaymentIntentId(invoice: Stripe.Invoice): string | null {
  const payment = invoice.payments?.data.find((p) => p.status === 'paid') ?? invoice.payments?.data[0];
  return stripeId(payment?.payment?.payment_intent);
}

const unixToIso = (seconds: number): string => new Date(seconds * 1000).toISOString();

// The period a PAID invoice covers (its first line). This is the only safe source of "paid through":
// Stripe moves the subscription's own period forward at renewal before the charge succeeds, so
// trusting the subscription would hand out unpaid access after a failed renewal.
export function paidThroughFromInvoice(invoice: Stripe.Invoice): { start: string; end: string } | null {
  const line = invoice.lines.data[0];
  if (!line?.period) return null;
  return { start: unixToIso(line.period.start), end: unixToIso(line.period.end) };
}

// When a canceled subscription actually ended (access must stop there), or null.
export function subscriptionEndedAt(sub: Stripe.Subscription): string | null {
  return sub.ended_at ? unixToIso(sub.ended_at) : null;
}
