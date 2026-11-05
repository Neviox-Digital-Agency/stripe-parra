import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';

import { invoicePaymentIntentId, invoiceSubscriptionId, paidThroughFromInvoice, subscriptionEndedAt } from '../src/stripe/invoice';

describe('Stripe helpers', () => {
  test('subscription id comes from parent.subscription_details, string or object', () => {
    const inv = (s: unknown) => ({ parent: { subscription_details: { subscription: s } } }) as unknown as Stripe.Invoice;
    expect(invoiceSubscriptionId(inv('sub_1'))).toBe('sub_1');
    expect(invoiceSubscriptionId(inv({ id: 'sub_2' }))).toBe('sub_2');
    expect(invoiceSubscriptionId({} as Stripe.Invoice)).toBeNull();
  });

  test('payment intent comes from invoice.payments', () => {
    const inv = { payments: { data: [{ status: 'paid', payment: { payment_intent: 'pi_1' } }] } } as unknown as Stripe.Invoice;
    expect(invoicePaymentIntentId(inv)).toBe('pi_1');
  });

  test('the paid-through period is the period of a paid invoice line, nothing else', () => {
    const inv = { lines: { data: [{ period: { start: 1_700_000_000, end: 1_715_000_000 } }] } } as unknown as Stripe.Invoice;
    expect(paidThroughFromInvoice(inv)).toEqual({ start: new Date(1_700_000_000_000).toISOString(), end: new Date(1_715_000_000_000).toISOString() });
    expect(paidThroughFromInvoice({ lines: { data: [] } } as unknown as Stripe.Invoice)).toBeNull();
  });

  test('ended_at is exposed only when set', () => {
    expect(subscriptionEndedAt({ ended_at: 1_710_000_000 } as Stripe.Subscription)).toBe(new Date(1_710_000_000_000).toISOString());
    expect(subscriptionEndedAt({ ended_at: null } as Stripe.Subscription)).toBeNull();
  });
});
