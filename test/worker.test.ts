import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { ParraError, type ParraClient } from '../src/parra/client';
import { MemoryJobStore } from '../src/worker/memory-store';
import { nextDelayMinutes, processDueJobs } from '../src/worker/worker';
import type { IInvoiceJob } from '../src/worker/types';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const ISSUER = { workspaceMark: '1', paymentDeviceMark: '2', operatorOib: '12345678903', bankAccountId: 5 };
const CONTEXT = {
  amountCents: 11900,
  buyer: { type: 'person' as const, name: 'Ana Horvat', contactName: 'Ana Horvat', oib: '69435151530', address: 'Ulica 1', postalCode: '21000', city: 'Split', countryCode: 'HR', email: 'ana@example.com' },
  description: 'Pro plan, 6 months',
  periodStart: new Date('2026-11-05T10:00:00Z'),
  periodEnd: new Date('2027-05-05T10:00:00Z'),
};

const fiscalized = {
  id: 900,
  status: { value: 6, name: 'Paid' },
  basicInfo: { invoiceNumber: '5/1/2' },
  additionalInfo: { noteInternal: 'stripe:in_1 job:job-1' },
  fiscalizationStatus: { value: 1, name: 'Fiscalized' },
  jir: 'jir-1',
  zki: 'zki-1',
};

const parra = {
  nextInvoiceNumber: mock(async (_w: string, _d: string) => ({ ordinalNumber: 5, invoiceNumber: '5/1/2', documentDate: '', dueDate: '' })),
  createB2CInvoice: mock(async (_body: unknown) => fiscalized as unknown),
  getInvoice: mock(async (_id: number) => fiscalized as unknown),
  listInvoices: mock(async (_page: number) => [] as unknown[]),
  downloadPdf: mock(async (_id: number) => Buffer.from('%PDF-test')),
};
const storePdf = mock(async (_job: IInvoiceJob, _pdf: Buffer, _number: string) => {});
const deliver = mock(async (..._args: unknown[]) => {});
const alert = mock(async (_message: string, _job: IInvoiceJob) => {});

let store = new MemoryJobStore();

function addJob(overrides: Partial<IInvoiceJob> = {}) {
  store.add(
    { id: 'job-1', stripeInvoiceId: 'in_1', status: 'pending', attempts: 0, nextAttemptAt: NOW, reservedOrdinal: null, reservedInvoiceNumber: null, parraInvoiceId: null, createdAt: NOW, lastError: null, ...overrides },
    CONTEXT,
  );
}

const run = () =>
  processDueJobs({ store, parra: parra as unknown as ParraClient, issuer: ISSUER, storePdf, deliver, alert, now: () => NOW, sleep: async () => {} });
const job = () => store.jobs.get('job-1')!;

beforeEach(() => {
  store = new MemoryJobStore();
  addJob();
  for (const m of [...Object.values(parra), storePdf, deliver, alert]) m.mockClear();
  parra.nextInvoiceNumber.mockImplementation(async () => ({ ordinalNumber: 5, invoiceNumber: '5/1/2', documentDate: '', dueDate: '' }));
  parra.createB2CInvoice.mockImplementation(async () => fiscalized);
  parra.getInvoice.mockImplementation(async () => fiscalized);
  parra.listInvoices.mockImplementation(async () => []);
  parra.downloadPdf.mockImplementation(async () => Buffer.from('%PDF-test'));
});

describe('invoice worker', () => {
  test('issues, fiscalizes, keeps and delivers an invoice with the reserved number', async () => {
    expect(await run()).toMatchObject({ processed: 1, delivered: 1 });
    const body = parra.createB2CInvoice.mock.calls[0]![0] as { basicInfo: { invoiceNumber: string; ordinalNumber: number }; additionalInfo: { noteInternal: string } };
    expect(body.basicInfo).toMatchObject({ invoiceNumber: '5/1/2', ordinalNumber: 5 });
    expect(body.additionalInfo.noteInternal).toBe('stripe:in_1 job:job-1');
    expect(store.issued.get('job-1')).toEqual({ invoiceNumber: '5/1/2', ordinal: 5, parraInvoiceId: 900 });
    expect(store.fiscalization.get('job-1')).toMatchObject({ jir: 'jir-1', fiscalized: true });
    expect(job().status).toBe('delivered');
    expect(storePdf).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  test('a lost answer is recovered by number and marker, never by posting a second invoice', async () => {
    parra.createB2CInvoice.mockImplementationOnce(async () => {
      throw new ParraError('timeout', 0);
    });
    expect((await run()).retried).toBe(1);
    expect(job()).toMatchObject({ status: 'retry_wait', attempts: 1 });

    // Next run (time moved on): Parra already holds the invoice.
    parra.createB2CInvoice.mockClear();
    parra.listInvoices.mockImplementation(async () => [{ id: 900, invoiceNumber: '5/1/2' }]);
    job().nextAttemptAt = NOW;
    store.jobs.get('job-1')!.status = 'retry_wait';
    await new Promise((r) => setTimeout(r, 0));
    const later = new Date(NOW.getTime() + 10 * 60_000);
    expect((await processDueJobs({ store, parra: parra as unknown as ParraClient, issuer: ISSUER, storePdf, deliver, alert, now: () => later, sleep: async () => {} })).delivered).toBe(1);
    expect(parra.createB2CInvoice).not.toHaveBeenCalled();
  });

  test('a number already used by a different invoice needs a person', async () => {
    store = new MemoryJobStore();
    addJob({ status: 'retry_wait', attempts: 1, reservedOrdinal: 5, reservedInvoiceNumber: '5/1/2' });
    parra.listInvoices.mockImplementation(async () => [{ id: 777, invoiceNumber: '5/1/2' }]);
    parra.getInvoice.mockImplementationOnce(async () => ({ ...fiscalized, id: 777, additionalInfo: { noteInternal: 'something else' } }));
    expect((await run()).needsManual).toBe(1);
    expect(parra.createB2CInvoice).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test('rate limiting waits for Retry-After', async () => {
    parra.createB2CInvoice.mockImplementationOnce(async () => {
      throw new ParraError('slow down', 429, null, 120_000);
    });
    await run();
    expect(job()).toMatchObject({ status: 'retry_wait', nextAttemptAt: new Date(NOW.getTime() + 2 * 60_000) });
  });

  test('a rejected invoice (4xx) is not retried and raises the alert', async () => {
    parra.createB2CInvoice.mockImplementationOnce(async () => {
      throw new ParraError('Validation Error', 400, 'IntegrationApi.ValidationError');
    });
    expect((await run()).needsManual).toBe(1);
    expect(job().status).toBe('needs_manual');
    expect(alert).toHaveBeenCalledTimes(1);
  });

  test('an invoice not fiscalized yet is rechecked in 2 minutes, then every 15 minutes; nothing is delivered', async () => {
    const pending = { ...fiscalized, jir: null, zki: null, fiscalizationStatus: { value: 3, name: 'InProgress' } };
    parra.createB2CInvoice.mockImplementationOnce(async () => pending);
    parra.getInvoice.mockImplementation(async () => pending);
    await run();
    expect(job()).toMatchObject({ status: 'created', nextAttemptAt: new Date(NOW.getTime() + 2 * 60_000) });
    expect(parra.getInvoice.mock.calls.length).toBeGreaterThan(1);
    expect(deliver).not.toHaveBeenCalled();

    store = new MemoryJobStore();
    addJob({ createdAt: new Date(NOW.getTime() - 2 * 3_600_000), parraInvoiceId: 900, reservedOrdinal: 5, reservedInvoiceNumber: '5/1/2', status: 'created' });
    await run();
    expect(job().nextAttemptAt).toEqual(new Date(NOW.getTime() + 15 * 60_000));
  });

  test('a PDF that is not ready is fetched on a quick retry; one that stays unavailable is retried later', async () => {
    parra.downloadPdf.mockImplementationOnce(async () => {
      throw new ParraError('Resource not ready, try again later.', 400, 'Parra.ResourceNotReady');
    });
    expect(await run()).toMatchObject({ delivered: 1, needsManual: 0 });
    expect(parra.downloadPdf).toHaveBeenCalledTimes(2);

    store = new MemoryJobStore();
    addJob();
    parra.downloadPdf.mockImplementation(async () => {
      throw new ParraError('Resource not ready, try again later.', 400, 'Parra.ResourceNotReady');
    });
    expect(await run()).toMatchObject({ retried: 1, needsManual: 0 });
  });

  test('a number layout that does not look like ordinal + premises + device stops before issuing anything', async () => {
    parra.nextInvoiceNumber.mockImplementationOnce(async () => ({ ordinalNumber: 5, invoiceNumber: '2026-0005', documentDate: '', dueDate: '' }));
    expect((await run()).needsManual).toBe(1);
    expect(parra.createB2CInvoice).not.toHaveBeenCalled();
  });

  test('two jobs get different ordinals', async () => {
    store.add({ id: 'job-2', stripeInvoiceId: 'in_2', status: 'pending', attempts: 0, nextAttemptAt: NOW, reservedOrdinal: null, reservedInvoiceNumber: null, parraInvoiceId: null, createdAt: NOW, lastError: null }, CONTEXT);
    await run();
    expect(new Set([job().reservedOrdinal, store.jobs.get('job-2')!.reservedOrdinal]).size).toBe(2);
  });
});

describe('backoff', () => {
  test('ladder 1, 2, 5, 15 ... minutes, then a person; Retry-After wins', () => {
    expect(nextDelayMinutes(1, null)).toBe(1);
    expect(nextDelayMinutes(4, null)).toBe(15);
    expect(nextDelayMinutes(8, null)).toBe(240);
    expect(nextDelayMinutes(9, null)).toBeNull();
    expect(nextDelayMinutes(2, 300_000)).toBe(5);
  });
});
