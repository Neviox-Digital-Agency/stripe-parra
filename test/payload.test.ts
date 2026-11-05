import { describe, expect, test } from 'bun:test';

import { fiscalStateOf } from '../src/parra/enums';
import { buildB2CInvoiceBody, inferNumberFormat, internalNote, type IBuyer } from '../src/parra/payload';

const buyer: IBuyer = {
  type: 'person',
  name: 'Ana Horvat',
  contactName: 'Ana Horvat',
  oib: '69435151530',
  address: 'Ulica 1',
  postalCode: '21000',
  city: 'Split',
  countryCode: 'HR',
  email: 'ana@example.com',
};

const input = {
  stripeInvoiceId: 'in_1',
  jobId: 'job-1',
  amountCents: 9520,
  buyer,
  description: 'Pro plan, 6 months',
  periodStart: new Date('2026-11-05T10:00:00Z'),
  periodEnd: new Date('2027-05-05T10:00:00Z'),
  ordinal: 7,
  invoiceNumber: '7/1/2',
  issuer: { workspaceMark: '1', paymentDeviceMark: '2', operatorOib: '12345678903', bankAccountId: 5 },
  issuedOn: new Date('2026-11-05T10:00:00Z'),
};

describe('buildB2CInvoiceBody', () => {
  test('one line with the exact amount paid, 0 % VAT with an exemption basis, paid by card', () => {
    const body = buildB2CInvoiceBody(input);
    expect(body.invoiceLines).toHaveLength(1);
    expect(body.invoiceLines[0]).toMatchObject({ priceAmount: 95.2, quantity: 1, taxPercentage: 0, taxExcludeBasisMark: '10' });
    expect(body.basicInfo).toMatchObject({ invoicePaymentType: 3, currencyMark: 'EUR', documentTypeInternalMark: '380', ordinalNumber: 7, invoiceNumber: '7/1/2', dueDate: '2026-11-05' });
    expect(body.additionalInfo).toMatchObject({ invoiceLanguage: 1, bankAccountId: 5, operatorOib: '12345678903' });
  });

  test('delivery info is always sent: service period, else day of issue', () => {
    expect(buildB2CInvoiceBody(input).deliveryInfo).toEqual({ deliveryDateFrom: '2026-11-05', deliveryDateTo: '2027-05-05' });
    expect(buildB2CInvoiceBody({ ...input, periodStart: null, periodEnd: null }).deliveryInfo).toEqual({ deliveryDate: '2026-11-05' });
  });

  test('the Stripe invoice and job id are written to noteInternal', () => {
    expect(buildB2CInvoiceBody(input).additionalInfo.noteInternal).toBe(internalNote('in_1', 'job-1'));
    expect(internalNote('in_1', 'job-1')).toBe('stripe:in_1 job:job-1');
  });

  test('a business buyer keeps the contact person; long fields are cut; country defaults to HR', () => {
    const company = buildB2CInvoiceBody({ ...input, buyer: { ...buyer, type: 'business', name: 'Example d.o.o.', contactName: 'Ana Horvat' } });
    expect(company.customer).toMatchObject({ name: 'Example d.o.o.', contactPersonName: 'Ana Horvat', cityName: '21000 Split' });
    const cut = buildB2CInvoiceBody({ ...input, buyer: { ...buyer, name: 'x'.repeat(300), countryCode: null } });
    expect(cut.customer.name).toHaveLength(200);
    expect(cut.customer.countryCode).toBe('HR');
  });

  test('the VAT exemption can be overridden', () => {
    const body = buildB2CInvoiceBody({ ...input, vatExemption: { reason: 'Custom reason', basisMark: '11' } });
    expect(body.invoiceLines[0]).toMatchObject({ taxExcludeReason: 'Custom reason', taxExcludeBasisMark: '11' });
  });
});

describe('number layout and fiscal state', () => {
  test('the layout is learned from Parra: slashes or joined', () => {
    expect(inferNumberFormat({ ordinalNumber: 5, invoiceNumber: '5/1/2' }, '1', '2')!(17)).toBe('17/1/2');
    expect(inferNumberFormat({ ordinalNumber: 1, invoiceNumber: '112' }, '1', '2')!(12)).toBe('1212');
    expect(inferNumberFormat({ ordinalNumber: 5, invoiceNumber: '2026-0005' }, '1', '2')).toBeNull();
  });

  test('Parra fiscalization values map to three states', () => {
    expect(fiscalStateOf(1)).toBe('fiscalized');
    expect(fiscalStateOf(3)).toBe('in_progress');
    expect(fiscalStateOf(2)).toBe('failed');
    expect(fiscalStateOf(null)).toBe('failed');
  });
});
