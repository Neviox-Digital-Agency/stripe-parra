import { PARRA_API_VERSION } from './enums';

export interface IParraConfig {
  baseUrl: string;
  apiKey: string;
  businessSubjectId: string;
}

// Error from the Parra API: HTTP status plus the ProblemDetails fields when Parra sent them.
export class ParraError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  // Milliseconds Parra asked us to wait (429 Retry-After), else null.
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    status: number,
    errorCode: string | null = null,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ParraError';
    this.status = status;
    this.errorCode = errorCode;
    this.retryAfterMs = retryAfterMs;
  }

  // Worth trying again later: rate limit, server error, no answer at all, or a document Parra is
  // still generating ("Resource not ready", answered as 400 right after an invoice is created).
  get retryable(): boolean {
    return (
      this.status === 0 ||
      this.status === 429 ||
      this.status >= 500 ||
      this.errorCode === 'Parra.ResourceNotReady'
    );
  }
}

export interface IParraEnumValue {
  value: number;
  name: string;
}

export interface IParraInvoiceDetails {
  id: number;
  status: IParraEnumValue;
  basicInfo?: { invoiceNumber?: string; ordinalNumber?: number; documentDate?: string };
  additionalInfo?: { noteInternal?: string | null };
  fiscalizationStatus?: IParraEnumValue | null;
  jir?: string | null;
  zki?: string | null;
}

export interface IParraNextNumber {
  ordinalNumber: number;
  invoiceNumber: string;
  documentDate: string;
  dueDate: string;
}

export interface IParraInvoiceListItem {
  id: number;
  invoiceNumber: string;
  totalAmount?: number;
  fiscalizationStatus?: IParraEnumValue | null;
  createdOn?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 25_000;

// Thin typed client for the Parra Integration API. Knows the base URL, bearer auth, version path
// and error format; knows nothing about Rentijer. The fetch implementation is injectable so the
// worker can be tested without a network.
export class ParraClient {
  constructor(
    private readonly config: IParraConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const qs = Object.entries(query ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    return `${base}/v${PARRA_API_VERSION}/${path}${qs ? `?${qs}` : ''}`;
  }

  private subject(path: string): string {
    return `${this.config.businessSubjectId}/${path}`;
  }

  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure or timeout: the request may or may not have reached Parra.
      throw new ParraError(err instanceof Error ? err.message : 'network error', 0);
    }
    if (response.ok) return response;

    const retryAfter = Number(response.headers.get('retry-after'));
    let errorCode: string | null = null;
    let message = `Parra answered ${response.status}`;
    try {
      const problem = (await response.json()) as {
        errorCode?: string;
        title?: string;
        detail?: string;
        errors?: unknown;
      };
      errorCode = problem.errorCode ?? null;
      message =
        [problem.title, problem.detail, problem.errors ? JSON.stringify(problem.errors) : null]
          .filter(Boolean)
          .join(': ')
          .slice(0, 500) || message;
    } catch {
      // body was not JSON
    }
    throw new ParraError(
      message,
      response.status,
      errorCode,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
    );
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    return (await (await this.send(url, init)).json()) as T;
  }

  // Auth check; returns the business subject the key belongs to.
  ping(): Promise<{ authentication: { businessSubjectId: number } }> {
    return this.json(this.url('diagnostics/ping'));
  }

  // The next free ordinal/number on a payment device, as Parra counts it (includes invoices issued
  // outside Rentijer on the same device).
  nextInvoiceNumber(workSpaceMark: string, paymentDeviceMark: string): Promise<IParraNextNumber> {
    return this.json(
      this.url(this.subject('invoices/next-invoice-number'), { workSpaceMark, paymentDeviceMark }),
    );
  }

  // Creates and fiscalizes a B2C invoice. Parra returns the details right away; fiscalization may
  // still be InProgress and is then retried by Parra itself.
  createB2CInvoice(body: unknown): Promise<IParraInvoiceDetails> {
    return this.json(this.url(this.subject('invoices/b2c')), {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  getInvoice(id: number): Promise<IParraInvoiceDetails> {
    return this.json(this.url(this.subject(`invoices/${id}`)));
  }

  // One page of invoices (newest first is not guaranteed; callers match by number).
  async listInvoices(page: number, pageSize = 50): Promise<IParraInvoiceListItem[]> {
    const data = await this.json<unknown>(this.url(this.subject('invoices'), { page, pageSize }));
    // Parra wraps lists as { success, data: [...], pagination }.
    const wrapped = data as { data?: unknown; items?: unknown };
    const items = Array.isArray(data) ? data : (wrapped.data ?? wrapped.items ?? []);
    return items as IParraInvoiceListItem[];
  }

  // The invoice PDF. Parra answers either with the bytes or with a short-lived download link.
  async downloadPdf(id: number): Promise<Buffer> {
    const response = await this.send(this.url(this.subject(`invoices/${id}/download/pdf`)), {
      headers: { Accept: 'application/pdf, application/json' },
    });
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('pdf')) return Buffer.from(await response.arrayBuffer());

    const body = (await response.json()) as {
      sasUri?: string;
      url?: string;
      downloadUrl?: string;
      content?: string;
    };
    const link = body.sasUri ?? body.url ?? body.downloadUrl;
    if (link) {
      const file = await this.fetchImpl(link, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!file.ok) throw new ParraError(`PDF link answered ${file.status}`, file.status);
      return Buffer.from(await file.arrayBuffer());
    }
    if (body.content) return Buffer.from(body.content, 'base64');
    throw new ParraError('Parra PDF answer has no file', 502);
  }

  // Settings lookups used by the sandbox probe and by startup checks.
  settings(
    kind:
      'workspaces' | 'payment-devices' | 'operators' | 'bank-accounts' | 'invoice-default-notes',
  ): Promise<unknown> {
    return this.json(this.url(this.subject(`settings/${kind}`)));
  }
}
