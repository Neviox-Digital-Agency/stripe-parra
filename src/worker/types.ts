import type { IParraIssuer, IBuyer } from '../parra/payload';

export type JobStatus =
  | 'pending'
  | 'reserved'
  | 'sending'
  | 'created'
  | 'fiscalized'
  | 'delivered'
  | 'retry_wait'
  | 'needs_manual';

// One paid Stripe invoice waiting to become a fiscalized Parra invoice.
export interface IInvoiceJob {
  id: string;
  stripeInvoiceId: string;
  status: JobStatus;
  attempts: number;
  nextAttemptAt: Date;
  reservedOrdinal: number | null;
  reservedInvoiceNumber: string | null;
  parraInvoiceId: number | null;
  createdAt: Date;
  lastError: string | null;
}

// What the worker needs to know about the payment behind a job.
export interface IInvoiceContext {
  amountCents: number;
  buyer: IBuyer;
  description: string;
  periodStart: Date | null;
  periodEnd: Date | null;
}

export type JobPatch = Partial<
  Pick<IInvoiceJob, 'status' | 'attempts' | 'nextAttemptAt' | 'reservedOrdinal' | 'reservedInvoiceNumber' | 'parraInvoiceId' | 'lastError'>
>;

// Persistence the worker runs on. Implement it on any database; `MemoryJobStore` is a reference.
export interface IJobStore {
  // Jobs that are not finished and whose nextAttemptAt has passed, oldest first.
  listDue(now: Date, limit: number): Promise<IInvoiceJob[]>;
  // Takes a lease on a job; false when another worker holds it. An expired lease can be taken over.
  claim(jobId: string, now: Date, leaseUntil: Date): Promise<boolean>;
  // Loads the payment data; throws when the buyer or invoice is missing (the job then needs a person).
  loadContext(job: IInvoiceJob): Promise<IInvoiceContext>;
  // Reserves the next ordinal for a job, never below `floor` (Parra's own next number) and never
  // equal to another job's. MUST be serialized across workers (an advisory lock or equivalent) and
  // idempotent: a job that already holds a reservation gets the same ordinal back.
  reserveOrdinal(jobId: string, floor: number): Promise<number>;
  update(jobId: string, patch: JobPatch): Promise<void>;
  // Parra created the invoice: keep its identity with your own invoice record.
  recordIssued(job: IInvoiceJob, issued: { invoiceNumber: string; ordinal: number; parraInvoiceId: number }): Promise<void>;
  // Latest fiscalization state read from Parra.
  recordFiscalization(job: IInvoiceJob, state: { jir: string | null; zki: string | null; statusName: string | null; fiscalized: boolean }): Promise<void>;
}

export interface IWorkerDeps {
  store: IJobStore;
  parra: import('../parra/client').ParraClient;
  issuer: IParraIssuer;
  // Keep the finished PDF (object storage, database...). Optional.
  storePdf?: (job: IInvoiceJob, pdf: Buffer, invoiceNumber: string) => Promise<void>;
  // Send the invoice to the buyer. Optional; a failure here fails the job attempt.
  deliver?: (job: IInvoiceJob, context: IInvoiceContext, pdf: Buffer, invoiceNumber: string) => Promise<void>;
  // Called when a job needs a person (Slack, e-mail, pager). Optional.
  alert?: (message: string, job: IInvoiceJob) => Promise<void>;
  now?: () => Date;
  // Pause between the quick re-checks inside one run (tests pass a no-op).
  sleep?: (ms: number) => Promise<void>;
}

export interface IRunSummary {
  processed: number;
  delivered: number;
  retried: number;
  needsManual: number;
}
