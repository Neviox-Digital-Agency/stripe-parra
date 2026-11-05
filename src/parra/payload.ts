import {
  PARRA_CURRENCY_MARK,
  PARRA_DOCUMENT_TYPE_MARK,
  PARRA_LANGUAGE,
  PARRA_PAYMENT_TYPE,
  PARRA_TAX_EXCLUDE_BASIS_MARK,
  PARRA_TAX_ZERO,
  PARRA_UNIT_MARK,
} from './enums';

// Your own business subject settings in Parra: what every invoice you issue carries.
export interface IParraIssuer {
  workspaceMark: string;
  paymentDeviceMark: string;
  operatorOib: string;
  bankAccountId: number;
}

// The buyer exactly as it must appear on the invoice, frozen at the time of payment.
export interface IBuyer {
  type: 'person' | 'business';
  // Printed on the invoice: the company for a business, the person otherwise.
  name: string;
  contactName: string;
  oib: string | null;
  address: string;
  postalCode: string | null;
  city: string;
  countryCode: string | null;
  email: string | null;
}

// Statement and basis for the zero VAT rate. The default is a small taxpayer outside the VAT system.
export interface IVatExemption {
  reason: string;
  basisMark: string;
}

export const NOT_IN_VAT_EXEMPTION: IVatExemption = {
  reason: 'Porezni obveznik nije u sustavu PDV-a, čl. 90. st. 1. Zakona o PDV-u.',
  basisMark: PARRA_TAX_EXCLUDE_BASIS_MARK,
};

export interface IB2CInvoiceInput {
  stripeInvoiceId: string;
  // Your own id for the outbox job, written to noteInternal for recovery.
  jobId: string;
  // What was actually charged, in cents (discounts are already inside it).
  amountCents: number;
  buyer: IBuyer;
  // The invoice line text, e.g. "Pro plan, 6 months (05.11.2026 - 05.05.2027)".
  description: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  ordinal: number;
  invoiceNumber: string;
  issuer: IParraIssuer;
  issuedOn: Date;
  vatExemption?: IVatExemption;
}

// Marker written to noteInternal. It is how an invoice whose creation answer was lost is found
// again: by this text, never by guessing.
export function internalNote(stripeInvoiceId: string, jobId: string): string {
  return `stripe:${stripeInvoiceId} job:${jobId}`;
}

// Learns the invoice number layout from Parra's own sample (the layout is a Parra setting: with
// slashes "5/1/2", or joined "512"). Returns a function that builds the number for any ordinal, or
// null when the sample does not look like ordinal + premises mark + device mark.
export function inferNumberFormat(
  sample: { ordinalNumber: number; invoiceNumber: string },
  workspaceMark: string,
  paymentDeviceMark: string,
): ((ordinal: number) => string) | null {
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `^${sample.ordinalNumber}(.*)${escape(workspaceMark)}(.*)${escape(paymentDeviceMark)}$`,
  ).exec(sample.invoiceNumber);
  if (!match) return null;
  const [, first, second] = match;
  return (ordinal) => `${ordinal}${first}${workspaceMark}${second}${paymentDeviceMark}`;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

// Body of POST /invoices/b2c for one paid Stripe invoice: one line, quantity 1, the amount actually
// paid (so the invoice always equals the Stripe charge), 0 % VAT with an exemption statement, paid
// by card, Croatian.
export function buildB2CInvoiceBody(input: IB2CInvoiceInput) {
  const { buyer, issuer } = input;
  const exemption = input.vatExemption ?? NOT_IN_VAT_EXEMPTION;

  return {
    customer: {
      name: buyer.name.slice(0, 200),
      oibOrVatId: buyer.oib || null,
      addressWithNo: buyer.address.slice(0, 200),
      cityName: [buyer.postalCode, buyer.city].filter(Boolean).join(' ').slice(0, 100),
      countryCode: buyer.countryCode ?? 'HR',
      contactEmail: buyer.email?.slice(0, 100) ?? null,
      contactPersonName: buyer.type === 'business' ? buyer.contactName.slice(0, 100) : null,
    },
    basicInfo: {
      businessSubjectWorkSpaceMark: issuer.workspaceMark,
      businessSubjectPaymentDeviceMark: issuer.paymentDeviceMark,
      ordinalNumber: input.ordinal,
      invoiceNumber: input.invoiceNumber,
      dueDate: isoDate(input.issuedOn),
      documentTypeInternalMark: PARRA_DOCUMENT_TYPE_MARK,
      currencyMark: PARRA_CURRENCY_MARK,
      currencyExchangeRate: 1,
      invoicePaymentType: PARRA_PAYMENT_TYPE.card,
      paymentDescription: 'Online subscription',
    },
    additionalInfo: {
      operatorOib: issuer.operatorOib,
      bankAccountId: issuer.bankAccountId,
      invoiceLanguage: PARRA_LANGUAGE.croatian,
      noteInternal: internalNote(input.stripeInvoiceId, input.jobId),
    },
    invoiceLines: [
      {
        name: input.description.slice(0, 500),
        priceAmount: input.amountCents / 100,
        quantity: 1,
        taxPercentage: PARRA_TAX_ZERO,
        taxExcludeBasisMark: exemption.basisMark,
        taxExcludeReason: exemption.reason,
        unitOfMeasureMark: PARRA_UNIT_MARK,
      },
    ],
    // Parra rejects an invoice without delivery info even though the OpenAPI spec marks it
    // optional. The service period when known, else the day of issue.
    deliveryInfo:
      input.periodStart && input.periodEnd
        ? { deliveryDateFrom: isoDate(input.periodStart), deliveryDateTo: isoDate(input.periodEnd) }
        : { deliveryDate: isoDate(input.issuedOn) },
  };
}
