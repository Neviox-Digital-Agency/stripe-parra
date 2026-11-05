# What the Parra sandbox taught us

Findings from issuing real test invoices against the Parra sandbox (Integration API v1.1, November
2026). The OpenAPI document is a good map, but these are the places where behaviour differs from it
or is not written down. Each one is handled in the code and covered by a test.

| Finding | What to do |
| --- | --- |
| `deliveryInfo` is required on a B2C invoice although the spec marks it optional | Always send it: the service period, else the day of issue |
| A line with `taxPercentage: 0` is refused without `taxExcludeBasisMark` (`Parra.TaxExcludeIsRequiredWhenNoTaxRate`) | Send a basis from `GET codebooks/tax-exclude-basis`; `10` ("other exemptions") fits a small taxpayer outside the VAT system, confirm with your accountant |
| Without invoice number format settings, `next-invoice-number` answers a bare `Parra.GenericError` | Set the number format in the Parra app first (invoice settings) |
| The invoice number layout is a Parra setting (`5/1/2` or joined `512`) | Learn it from Parra's own sample (`inferNumberFormat`) instead of assuming slashes |
| A duplicate invoice number is refused (`Parra.InvoiceNumberAlreadyTaken`) | This is what makes recovery safe: look the invoice up by number and `noteInternal` before posting again |
| Right after creation the PDF answers `400 Parra.ResourceNotReady` | Treat as retryable; the worker re-tries a few times in the same run, then backs off |
| `GET .../download/pdf` returns JSON with a short-lived `sasUri`, not the file | Download the link immediately |
| Lists are wrapped: `{ success, data, pagination }` | The client unwraps them |
| Fiscalization usually completes within seconds but starts as `InProgress` | Re-check a few times, then every 2 minutes (first 30 minutes) and every 15 minutes, give up to a person after 48 hours |
| Cancelling (storno) through the API is not available for fiscalized B2C invoices | Issue storno by hand in the Parra app and only record the reference in your system |
| Each API key belongs to one business subject; sandbox and production are separate apps and data | Keep keys and base URLs in environment configuration and refuse to mix test Stripe with production Parra |

## Stripe side

* From API version `2025-03-31.basil` an invoice has no `subscription` or `payment_intent`; read them
  from `parent.subscription_details` and `payments`. `current_period_end` moved to the subscription
  item. `src/stripe/invoice.ts` wraps this.
* **Grant access only up to the end of a paid period.** Stripe advances a subscription's own period
  at renewal before the charge succeeds. If you derive access from the subscription, a failed
  renewal hands out a whole unpaid period. Derive it from the period of a *paid* invoice and never
  move it backwards.
* A Stripe customer used with an idempotency key keeps replaying the same (possibly deleted)
  customer for 24 hours; do not key customer creation by your user id.
* Test clocks let you test renewals and failed renewals without waiting: advance the clock, listen
  to the webhooks, assert that a failed renewal does not extend access.
