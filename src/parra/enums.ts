// Parra Integration API v1.1 enum values and codebook marks, taken from the sandbox
// (GET /v1.1/enums/* and /v1.1/codebooks/*, checked 2026-11-05). They are plain numbers on the
// wire, so they live in one place.

export const PARRA_API_VERSION = '1.1';

// invoicePaymentType: a Stripe card payment is always "Card".
export const PARRA_PAYMENT_TYPE = { cash: 1, bankTransfer: 2, card: 3, other: 4 } as const;

// invoiceLanguage: V5 decided on Croatian only.
export const PARRA_LANGUAGE = {
  croatian: 1,
  engBilingual: 2,
  english: 3,
  german: 4,
  deBilingual: 5,
} as const;

// fiscalizationStatus.value
export const PARRA_FISCALIZATION = {
  fiscalized: 1,
  notFiscalized: 2,
  inProgress: 3,
  eInvoiceNotSent: 4,
} as const;

// status.value (invoice lifecycle)
export const PARRA_INVOICE_STATUS = { draft: 0, issued: 1, cancelled: 7, deleted: 8 } as const;

// Codebook marks used on every invoice we issue.
export const PARRA_DOCUMENT_TYPE_MARK = '380'; // "Komercijalni racun - Redovan racun"
export const PARRA_CURRENCY_MARK = 'EUR';
export const PARRA_UNIT_MARK = 'H87'; // "komad" (piece): one subscription = quantity 1
export const PARRA_TAX_ZERO = 0;
// VAT exemption basis for a 0 % line (GET codebooks/tax-exclude-basis). Parra refuses a 0 % line
// without one. "10" is "Ostala oslobodjenja" (other exemptions), which fits a small taxpayer outside
// the VAT system (art. 90 of the Croatian VAT Act). Confirm the right basis with your accountant.
export const PARRA_TAX_EXCLUDE_BASIS_MARK = '10';

// The fiscal status of an invoice as our outbox understands it.
export type FiscalState = 'fiscalized' | 'in_progress' | 'failed';

// Maps Parra's fiscalizationStatus.value to our three states. Anything that is not clearly
// fiscalized or still being retried by Parra is treated as failed and surfaces to the admin.
export function fiscalStateOf(value: number | null | undefined): FiscalState {
  if (value === PARRA_FISCALIZATION.fiscalized) return 'fiscalized';
  if (value === PARRA_FISCALIZATION.inProgress) return 'in_progress';
  return 'failed';
}
