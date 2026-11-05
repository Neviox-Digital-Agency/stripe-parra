// Stripe webhook that turns a paid subscription invoice into an outbox job. Framework-agnostic
// (Fetch API Request/Response), so it drops into Next.js route handlers, Hono, Bun.serve, etc.
//
// The pattern, in order:
//   1. verify the signature over the RAW body before doing anything else
//   2. record the event id (idempotency ledger) and skip events already handled
//   3. on `invoice.paid`: store the payment and enqueue ONE job per Stripe invoice id
//   4. answer 200; the worker (examples/run-worker.ts) issues the Parra invoice later
import Stripe from 'stripe';

import { invoicePaymentIntentId, invoiceSubscriptionId, paidThroughFromInvoice } from '../src/index';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// Replace with your database. Both operations must be atomic and unique on their key.
interface IPaymentStore {
  // Returns false when this event id was already recorded.
  recordEvent(eventId: string): Promise<boolean>;
  // Unique on stripeInvoiceId: a replay of the same invoice changes nothing.
  enqueueInvoiceJob(job: { stripeInvoiceId: string; subscriptionId: string; paymentIntentId: string | null; amountCents: number; paidThrough: { start: string; end: string } | null }): Promise<void>;
}

export async function handleStripeWebhook(request: Request, store: IPaymentStore): Promise<Response> {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return new Response('missing signature', { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(await request.text(), signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return new Response('invalid signature', { status: 400 });
  }

  if (!(await store.recordEvent(event.id))) return new Response('duplicate', { status: 200 });

  if (event.type === 'invoice.paid') {
    // Never trust the event payload for state: fetch the invoice again (and expand its payments).
    const invoice = await stripe.invoices.retrieve(event.data.object.id!, { expand: ['payments'] });
    const subscriptionId = invoiceSubscriptionId(invoice);
    if (subscriptionId && invoice.status === 'paid' && invoice.amount_paid > 0) {
      await store.enqueueInvoiceJob({
        stripeInvoiceId: invoice.id!,
        subscriptionId,
        paymentIntentId: invoicePaymentIntentId(invoice),
        amountCents: invoice.amount_paid,
        // Access is granted only up to the end of a PAID period, never from the subscription object.
        paidThrough: paidThroughFromInvoice(invoice),
      });
    }
  }
  return new Response('ok', { status: 200 });
}
