import { ParraError, type IParraInvoiceDetails } from '../parra/client';
import { fiscalStateOf } from '../parra/enums';
import { buildB2CInvoiceBody, inferNumberFormat, internalNote } from '../parra/payload';
import type { IInvoiceJob, IRunSummary, IWorkerDeps } from './types';

// Minutes to wait after the n-th failed attempt; after the last one the job needs a person.
export const BACKOFF_MINUTES = [1, 2, 5, 15, 30, 60, 120, 240] as const;

// Parra usually fiscalizes within seconds: re-check a few times inside the same run, then every
// 2 minutes for the first half hour and every 15 minutes after that, for at most 48 hours.
const QUICK_CHECKS = 4;
const QUICK_CHECK_MS = 2500;
const PDF_TRIES = 4;
const PDF_TRY_MS = 3000;
const FAST_POLL_MINUTES = 2;
const SLOW_POLL_MINUTES = 15;
const FAST_POLL_WINDOW_MINUTES = 30;
const FISCAL_GIVE_UP_HOURS = 48;
const LEASE_MINUTES = 2;
const LIST_PAGES_TO_SCAN = 3;

class NeedsManual extends Error {}

const plusMinutes = (from: Date, minutes: number) => new Date(from.getTime() + minutes * 60_000);

// Delay before the next attempt: Parra's Retry-After when it sent one, else the backoff ladder.
export function nextDelayMinutes(attempts: number, retryAfterMs: number | null): number | null {
  if (retryAfterMs) return Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return BACKOFF_MINUTES[attempts - 1] ?? null;
}

// Runs every due job, one at a time (Parra numbering is sequential, so parallelism would only race).
export async function processDueJobs(deps: IWorkerDeps, limit = 20): Promise<IRunSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const summary: IRunSummary = { processed: 0, delivered: 0, retried: 0, needsManual: 0 };

  for (const job of await deps.store.listDue(now, limit)) {
    if (!(await deps.store.claim(job.id, now, plusMinutes(now, LEASE_MINUTES)))) continue;
    summary.processed += 1;
    const result = await runJob(deps, job, now);
    if (result === 'delivered') summary.delivered += 1;
    else if (result === 'retry') summary.retried += 1;
    else if (result === 'manual') summary.needsManual += 1;
  }
  return summary;
}

type JobResult = 'delivered' | 'retry' | 'manual' | 'waiting';

async function runJob(deps: IWorkerDeps, job: IInvoiceJob, now: Date): Promise<JobResult> {
  try {
    return await advance(deps, job, now);
  } catch (err) {
    return fail(deps, job, err, now);
  }
}

// Moves a job as far as it can go in one run: reserve a number, create the Parra invoice, confirm
// fiscalization, keep the PDF, send it.
async function advance(deps: IWorkerDeps, job: IInvoiceJob, now: Date): Promise<JobResult> {
  const { store, parra, issuer } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const context = await store.loadContext(job);

  let parraInvoice: IParraInvoiceDetails | null = null;
  let parraId = job.parraInvoiceId;
  let invoiceNumber = job.reservedInvoiceNumber;

  if (!parraId) {
    // 1. Reserve a number once and persist it before anything is sent.
    let ordinal = job.reservedOrdinal;
    if (!ordinal || !invoiceNumber) {
      const next = await parra.nextInvoiceNumber(issuer.workspaceMark, issuer.paymentDeviceMark);
      const format = inferNumberFormat(next, issuer.workspaceMark, issuer.paymentDeviceMark);
      if (!format) {
        throw new NeedsManual(`Parra number "${next.invoiceNumber}" does not look like ordinal + premises + device`);
      }
      ordinal = await store.reserveOrdinal(job.id, next.ordinalNumber);
      invoiceNumber = format(ordinal);
      await store.update(job.id, { status: 'reserved', reservedOrdinal: ordinal, reservedInvoiceNumber: invoiceNumber });
    }

    // 2. After any earlier attempt the invoice may already exist in Parra (the answer was lost):
    //    look it up by number and our marker before ever posting again.
    if (job.attempts > 0 || job.status === 'sending') parraInvoice = await findExisting(deps, job, invoiceNumber);

    // 3. Create it.
    if (!parraInvoice) {
      await store.update(job.id, { status: 'sending' });
      parraInvoice = await parra.createB2CInvoice(
        buildB2CInvoiceBody({
          stripeInvoiceId: job.stripeInvoiceId,
          jobId: job.id,
          amountCents: context.amountCents,
          buyer: context.buyer,
          description: context.description,
          periodStart: context.periodStart,
          periodEnd: context.periodEnd,
          ordinal,
          invoiceNumber,
          issuer,
          issuedOn: now,
        }),
      );
    }
    parraId = parraInvoice.id;
    await store.update(job.id, { status: 'created', parraInvoiceId: parraId });
    await store.recordIssued(job, { invoiceNumber, ordinal, parraInvoiceId: parraId });
  }

  // 4. Fiscalization: JIR present and status fiscalized. Parra is usually done within seconds, so
  //    look a few times now before scheduling a later check.
  if (!parraInvoice || !parraInvoice.jir) parraInvoice = await parra.getInvoice(parraId);
  const isDone = (d: IParraInvoiceDetails) => !!d.jir && fiscalStateOf(d.fiscalizationStatus?.value) === 'fiscalized';
  for (let check = 1; check < QUICK_CHECKS && !isDone(parraInvoice); check += 1) {
    await sleep(QUICK_CHECK_MS);
    parraInvoice = await parra.getInvoice(parraId);
  }
  const fiscalized = isDone(parraInvoice);
  await store.recordFiscalization(job, {
    jir: parraInvoice.jir ?? null,
    zki: parraInvoice.zki ?? null,
    statusName: parraInvoice.fiscalizationStatus?.name ?? null,
    fiscalized,
  });

  if (!fiscalized) {
    const ageMinutes = (now.getTime() - job.createdAt.getTime()) / 60_000;
    if (ageMinutes / 60 > FISCAL_GIVE_UP_HOURS) {
      throw new NeedsManual(`not fiscalized after ${FISCAL_GIVE_UP_HOURS} h (status ${parraInvoice.fiscalizationStatus?.name ?? 'unknown'})`);
    }
    await store.update(job.id, {
      status: 'created',
      nextAttemptAt: plusMinutes(now, ageMinutes < FAST_POLL_WINDOW_MINUTES ? FAST_POLL_MINUTES : SLOW_POLL_MINUTES),
      lastError: null,
    });
    return 'waiting';
  }
  await store.update(job.id, { status: 'fiscalized' });

  // 5. PDF (Parra answers "not ready" for a few seconds after creation), then storage and delivery.
  let pdf: Buffer | null = null;
  for (let tryNo = 1; tryNo <= PDF_TRIES && !pdf; tryNo += 1) {
    try {
      pdf = await parra.downloadPdf(parraId);
    } catch (err) {
      if (!(err instanceof ParraError) || !err.retryable || tryNo === PDF_TRIES) throw err;
      await sleep(PDF_TRY_MS);
    }
  }
  if (!pdf) throw new Error('PDF was not produced');

  const finalNumber = parraInvoice.basicInfo?.invoiceNumber ?? invoiceNumber ?? '';
  await deps.storePdf?.(job, pdf, finalNumber);
  await deps.deliver?.(job, context, pdf, finalNumber);
  await store.update(job.id, { status: 'delivered', lastError: null });
  return 'delivered';
}

// Looks for an invoice a lost answer may have created: same number, our marker in noteInternal.
async function findExisting(deps: IWorkerDeps, job: IInvoiceJob, invoiceNumber: string): Promise<IParraInvoiceDetails | null> {
  for (let page = 1; page <= LIST_PAGES_TO_SCAN; page += 1) {
    const items = await deps.parra.listInvoices(page);
    const hit = items.find((i) => i.invoiceNumber === invoiceNumber);
    if (hit) {
      const details = await deps.parra.getInvoice(hit.id);
      if (details.additionalInfo?.noteInternal?.includes(internalNote(job.stripeInvoiceId, job.id))) return details;
      throw new NeedsManual(`number ${invoiceNumber} is already used in Parra by a different invoice`);
    }
    if (items.length === 0) break;
  }
  return null;
}

// Records a failed attempt: retryable errors back off, permanent ones need a person.
async function fail(deps: IWorkerDeps, job: IInvoiceJob, err: unknown, now: Date): Promise<JobResult> {
  const attempts = job.attempts + 1;
  const message = (err instanceof Error ? err.message : 'unknown error').slice(0, 500);
  const retryable = err instanceof ParraError ? err.retryable : !(err instanceof NeedsManual);
  const delay = retryable ? nextDelayMinutes(attempts, err instanceof ParraError ? err.retryAfterMs : null) : null;

  if (delay === null) {
    await deps.store.update(job.id, { status: 'needs_manual', attempts, lastError: message });
    await deps.alert?.(`Invoice for ${job.stripeInvoiceId} cannot be issued automatically: ${message}`, job);
    return 'manual';
  }
  await deps.store.update(job.id, { status: 'retry_wait', attempts, lastError: message, nextAttemptAt: plusMinutes(now, delay) });
  return 'retry';
}
