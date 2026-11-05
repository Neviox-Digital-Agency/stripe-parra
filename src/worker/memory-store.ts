import type { IInvoiceContext, IInvoiceJob, IJobStore, JobPatch } from './types';

// In-memory reference implementation of IJobStore: handy for tests, demos and as a template for a
// real database store. It is not durable and not safe across processes.
export class MemoryJobStore implements IJobStore {
  readonly jobs = new Map<string, IInvoiceJob>();
  readonly contexts = new Map<string, IInvoiceContext>();
  readonly issued = new Map<string, { invoiceNumber: string; ordinal: number; parraInvoiceId: number }>();
  readonly fiscalization = new Map<string, { jir: string | null; zki: string | null; statusName: string | null; fiscalized: boolean }>();
  private readonly leases = new Map<string, Date>();

  add(job: IInvoiceJob, context: IInvoiceContext): void {
    this.jobs.set(job.id, job);
    this.contexts.set(job.id, context);
  }

  async listDue(now: Date, limit: number): Promise<IInvoiceJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.status !== 'delivered' && j.status !== 'needs_manual' && j.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);
  }

  async claim(jobId: string, now: Date, leaseUntil: Date): Promise<boolean> {
    const held = this.leases.get(jobId);
    if (held && held > now) return false;
    this.leases.set(jobId, leaseUntil);
    return true;
  }

  async loadContext(job: IInvoiceJob): Promise<IInvoiceContext> {
    const context = this.contexts.get(job.id);
    if (!context) throw new Error('no payment data for this job');
    return context;
  }

  async reserveOrdinal(jobId: string, floor: number): Promise<number> {
    const job = this.jobs.get(jobId)!;
    if (job.reservedOrdinal) return job.reservedOrdinal;
    const used = [...this.jobs.values()].map((j) => j.reservedOrdinal ?? 0);
    const ordinal = Math.max(Math.max(0, ...used) + 1, floor);
    job.reservedOrdinal = ordinal;
    return ordinal;
  }

  async update(jobId: string, patch: JobPatch): Promise<void> {
    const job = this.jobs.get(jobId)!;
    Object.assign(job, patch);
  }

  async recordIssued(job: IInvoiceJob, issued: { invoiceNumber: string; ordinal: number; parraInvoiceId: number }): Promise<void> {
    this.issued.set(job.id, issued);
  }

  async recordFiscalization(job: IInvoiceJob, state: { jir: string | null; zki: string | null; statusName: string | null; fiscalized: boolean }): Promise<void> {
    this.fiscalization.set(job.id, state);
  }
}
