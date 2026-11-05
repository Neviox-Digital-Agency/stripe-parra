import { describe, expect, test } from 'bun:test';

import { ParraClient, ParraError } from '../src/parra/client';

const config = { baseUrl: 'https://sandbox.example/', apiKey: 'test-key', businessSubjectId: '70' };
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('ParraClient', () => {
  test('sends bearer auth to the versioned path and builds the query', async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const client = new ParraClient(config, async (url, init) => {
      seen = { url, auth: new Headers(init?.headers).get('authorization') };
      return json({ ordinalNumber: 5, invoiceNumber: '5/1/2', documentDate: '', dueDate: '' });
    });
    await client.nextInvoiceNumber('1', '2');
    expect(seen!.url).toBe('https://sandbox.example/v1.1/70/invoices/next-invoice-number?workSpaceMark=1&paymentDeviceMark=2');
    expect(seen!.auth).toBe('Bearer test-key');
  });

  test('errors carry status, Parra error code and Retry-After', async () => {
    const client = new ParraClient(config, async () =>
      json({ title: 'Too many', errorCode: 'X.Limit' }, { status: 429, headers: { 'retry-after': '30', 'content-type': 'application/json' } }),
    );
    const error = await client.ping().catch((e) => e);
    expect(error).toBeInstanceOf(ParraError);
    expect(error).toMatchObject({ status: 429, errorCode: 'X.Limit', retryAfterMs: 30_000, retryable: true });
  });

  test('5xx, network failures and "resource not ready" are retryable; other 4xx are not', async () => {
    expect(new ParraError('x', 503).retryable).toBe(true);
    expect(new ParraError('x', 0).retryable).toBe(true);
    expect(new ParraError('x', 400, 'Parra.ResourceNotReady').retryable).toBe(true);
    expect(new ParraError('x', 400, 'Parra.InvoiceNumberAlreadyTaken').retryable).toBe(false);
  });

  test('list answers come wrapped in data, a PDF may come as a download link', async () => {
    const client = new ParraClient(config, async (url) => {
      if (url.includes('/invoices?')) return json({ success: true, data: [{ id: 1, invoiceNumber: '1/1/2' }], pagination: {} });
      if (url.includes('download/pdf')) return json({ sasUri: 'https://files.example/a.pdf' });
      return new Response('%PDF-test', { headers: { 'content-type': 'application/pdf' } });
    });
    expect(await client.listInvoices(1)).toEqual([{ id: 1, invoiceNumber: '1/1/2' }]);
    expect((await client.downloadPdf(1)).toString()).toBe('%PDF-test');
  });
});
