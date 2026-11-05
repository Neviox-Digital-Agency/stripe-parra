# stripe-parra

**Fiscalized Croatian invoices for Stripe subscription payments, issued through [Parra](https://parra.hr).**

[![CI](https://github.com/Neviox-Digital-Agency/stripe-parra/actions/workflows/ci.yml/badge.svg)](https://github.com/Neviox-Digital-Agency/stripe-parra/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Stripe charges the card but does not fiscalize. In Croatia a card payment for a service needs an
invoice that carries a **JIR**, a **ZKI** and a QR code. This library is the missing step between the
two: when a Stripe invoice is paid, it issues the matching invoice in Parra, waits until Parra has
fiscalized it, fetches the PDF and hands it to you for storage and delivery, and it does so without
ever creating a duplicate invoice, even when the network, Parra or your own process fails halfway.

It is a small, dependency-free TypeScript library (Stripe is an optional peer dependency used for
types and helpers). It has no database or framework opinions: persistence is an interface you
implement, and an in-memory reference store is included.

Built by [Neviox Digital](https://nevioxdigital.com) for [Rentijer](https://rentijer.com), the
property management app for Croatian holiday-rental hosts, and open sourced for anyone selling
subscriptions in Croatia.

> Status: tested against the Stripe and Parra **sandboxes** (including test clocks for renewals).
> Read the [limitations](#limitations-and-disclaimer) before you use it with real money.

## What it does

```
Stripe invoice.paid ──► your webhook ──► outbox job (one per Stripe invoice id)
                                              │
                          worker ◄────────────┘
                            │ 1. reserve the next invoice number (Parra's number is the floor)
                            │ 2. POST /invoices/b2c   (found again by number + marker if the answer is lost)
                            │ 3. wait for JIR / ZKI    (fiscalization is asynchronous)
                            │ 4. download the PDF      (Parra needs a few seconds to produce it)
                            ▼ 5. your storePdf() and deliver() hooks
```

* **Typed Parra client** for the Integration API v1.1: auth, versioned paths, error model, `429`
  `Retry-After`, timeouts, PDF download links.
* **B2C invoice payload builder**: one line with the amount actually paid (discounts included), 0 % VAT
  with an exemption statement and basis, paid by card, Croatian, buyer snapshot (person or company).
* **Outbox worker** with number reservation, crash recovery, a backoff ladder, a fiscalization
  polling schedule and an alert hook for jobs that need a person.
* **Stripe helpers** for API versions from `basil` on (`parent.subscription_details`, `payments`,
  item-level periods) and the rule that access is granted only up to the end of a *paid* period.
* **A written record of how the Parra sandbox really behaves**: see [docs/LESSONS.md](docs/LESSONS.md).

## Install

The package is not on npm yet. Use it from Git or copy `src/`:

```bash
bun add github:Neviox-Digital-Agency/stripe-parra
# or: npm install github:Neviox-Digital-Agency/stripe-parra
```

## Quick start

```ts
import { ParraClient, processDueJobs } from 'stripe-parra';

const parra = new ParraClient({
  baseUrl: 'https://sandbox-api.parra.hr', // production: https://api.parra.hr
  apiKey: process.env.PARRA_API_KEY!,
  businessSubjectId: process.env.PARRA_BUSINESS_SUBJECT_ID!,
});

await processDueJobs({
  store, // your IJobStore implementation (see below)
  parra,
  issuer: { workspaceMark: '1', paymentDeviceMark: '2', operatorOib: '…', bankAccountId: 1 },
  storePdf: async (job, pdf, invoiceNumber) => { /* keep the PDF */ },
  deliver: async (job, context, pdf, invoiceNumber) => { /* e-mail it to context.buyer.email */ },
  alert: async (message) => { /* Slack, e-mail... */ },
});
```

Run it from a cron every few minutes, and once right after your webhook enqueues a job.
Complete, commented examples: [`examples/webhook-route.ts`](examples/webhook-route.ts) and
[`examples/run-worker.ts`](examples/run-worker.ts).

### The store you implement

`IJobStore` (see [`src/worker/types.ts`](src/worker/types.ts)) is the only thing the worker needs
from your database: list due jobs, take a lease, load the payment data, **reserve an ordinal**, and
record state. The one hard requirement is that `reserveOrdinal` is serialized across workers (a
Postgres advisory lock works well) and idempotent per job, so two invoices can never get the same
number. [`MemoryJobStore`](src/worker/memory-store.ts) shows the semantics.

## Setting up Parra and the test environment

1. Register at the Parra sandbox with your company OIB and complete the company, bank account and
   invoice settings (**including the invoice number format**).
2. Add a business premises, a payment device and an operator.
3. Upload a **demo fiscal certificate** (Parra's
   [guide](https://help.parra.hr/hr/articles/14816977-sto-je-sve-potrebno-za-pocetak-testiranja-api-ja-u-sandbox-okolini)
   lists the Certilia demo at [reg.test.certilia.com](https://reg.test.certilia.com) and the FINA demo
   certificate from [FINA](https://www.fina.hr)).
4. Create an API key for the business subject. API access needs a Parra plan that includes it.
5. Use Stripe test mode, [test cards](https://docs.stripe.com/testing) and
   [test clocks](https://docs.stripe.com/billing/testing/test-clocks) for renewals.

Never use production keys in tests, and keep test Stripe keys away from the production Parra URL
(and the other way round): one would fiscalize an invoice for fake money, the other would take real
money without a fiscal invoice.

## Why an outbox, and why these retries

Calling Parra straight from the webhook handler loses invoices: Parra can be slow, rate limited
(`429`), or answer after your process died. The worker therefore writes down the invoice number
*before* it posts, and after any failed attempt it looks the invoice up (by number and a marker in
`noteInternal`) instead of posting again. Parra refuses a duplicate number, which is the safety net
under that logic. Permanent errors (a rejected payload) go to a person immediately; transient ones
back off 1, 2, 5, 15, 30, 60, 120 and 240 minutes.

## Croatian fiscalization context

* From 1 January 2026 B2C invoices are fiscalized regardless of how they are paid, and the full
  e-invoicing and e-reporting regime follows from 1 January 2027. Check the current rules with your
  accountant and the [Tax Administration](https://porezna-uprava.gov.hr).
* This library uses Parra's fiscalizing `b2c` endpoint for every buyer, companies included. For
  invoices to VAT-registered companies you may need the eRačun (`b2b`) path instead; that is
  deliberately a separate step and not covered here yet.
* The issuer's name, address, OIB and legal form printed on the invoice come from the business
  subject settings in Parra, not from this code.

## Limitations and disclaimer

* Not legal or tax advice. The VAT exemption text and basis used by default
  (`NOT_IN_VAT_EXEMPTION`) suit a small taxpayer outside the VAT system and **must be confirmed by
  your accountant**; you can pass your own `vatExemption`.
* One invoice line, quantity 1, no VAT calculation: it is built for subscriptions priced as a single
  amount.
* No storno automation: Parra does not allow cancelling fiscalized B2C invoices through the API, so
  refunds are a manual step in the Parra app.
* Verified on sandboxes. Run your own end-to-end test with real (small) payments before launch.

## Development

```bash
bun install
bun run typecheck
bun test
```

Tests cover the payload builder, the client (auth, errors, retryability, wrapped lists), the Stripe
helpers and the worker (issuing, lost-answer recovery, duplicate numbers, rate limits, rejected
invoices, fiscalization lag, PDF lag, numbering).

## Resources

* Parra: [website](https://parra.hr) · [Integration API docs](https://api.parra.hr/docs/) ·
  [OpenAPI v1.1](https://api.parra.hr/openapi/v1.1.json)
* Stripe: [Billing subscriptions](https://docs.stripe.com/billing/subscriptions/overview) ·
  [Webhooks](https://docs.stripe.com/webhooks) · [Payment Element](https://docs.stripe.com/payments/payment-element) ·
  [API versioning](https://docs.stripe.com/api/versioning) · [Test clocks](https://docs.stripe.com/billing/testing/test-clocks)
* Croatia: [Porezna uprava](https://porezna-uprava.gov.hr) · [FINA](https://www.fina.hr) ·
  [Certilia demo certificates](https://reg.test.certilia.com)
* More Croatian developer tooling by the same team: [hub3-barcode](https://github.com/tinmartinic/hub3-barcode)
  (HUB3 "slikaj i plati" payment barcodes) and [evisitor-client](https://github.com/tinmartinic/evisitor-client)
  (eVisitor tourist registration API)
* [Rentijer](https://rentijer.com): property management for Croatian holiday rentals
  ([pricing](https://rentijer.com/cijene), [blog](https://rentijer.com/blog))
* [Neviox Digital](https://nevioxdigital.com) ([English](https://nevioxdigital.com/en)): web and SaaS
  development studio in Croatia

## Sažetak na hrvatskom

`stripe-parra` povezuje Stripe i Parru: kad Stripe naplati pretplatu karticom, biblioteka u Parri
izdaje **fiskalizirani račun** (JIR, ZKI, QR), čeka fiskalizaciju, preuzima PDF i predaje ga Vašem
kodu za pohranu i slanje kupcu. Račun se nikad ne izdaje dvaput, čak ni kad Parra, mreža ili Vaš
proces zakažu usred posla. Izgradio ju je [Neviox Digital](https://nevioxdigital.com) za
[Rentijer](https://rentijer.com), aplikaciju za upravljanje najmom za hrvatske iznajmljivače.
Testirano na Stripe i Parra sandboxu; napomena o PDV-u i osnova oslobođenja moraju se potvrditi s
knjigovođom prije produkcije.

## License

[MIT](LICENSE) © 2026 [Neviox Digital](https://nevioxdigital.com)
