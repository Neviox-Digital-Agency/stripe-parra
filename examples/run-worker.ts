// Runs the outbox worker once. Call it from a cron (every few minutes) and, for low latency, right
// after the webhook enqueues a job. Swap MemoryJobStore for a store backed by your database.
import { ParraClient, MemoryJobStore, processDueJobs } from '../src/index';

const parra = new ParraClient({
  baseUrl: process.env.PARRA_API_BASE_URL ?? 'https://sandbox-api.parra.hr',
  apiKey: process.env.PARRA_API_KEY!,
  businessSubjectId: process.env.PARRA_BUSINESS_SUBJECT_ID!,
});

const store = new MemoryJobStore(); // implement IJobStore on your database for real use

const summary = await processDueJobs({
  store,
  parra,
  issuer: {
    workspaceMark: process.env.PARRA_WORKSPACE_MARK!,
    paymentDeviceMark: process.env.PARRA_PAYMENT_DEVICE_MARK!,
    operatorOib: process.env.PARRA_OPERATOR_OIB!,
    bankAccountId: Number(process.env.PARRA_BANK_ACCOUNT_ID),
  },
  storePdf: async (job, pdf, invoiceNumber) => {
    // upload `pdf` to object storage and remember the path next to your invoice record
    console.log(`PDF for ${invoiceNumber}: ${pdf.length} bytes (job ${job.id})`);
  },
  deliver: async (_job, context, _pdf, invoiceNumber) => {
    // e-mail the PDF to context.buyer.email with your mail provider
    console.log(`would send invoice ${invoiceNumber} to ${context.buyer.email}`);
  },
  alert: async (message) => {
    // post to Slack, e-mail, pager...
    console.error(message);
  },
});

console.log(summary);
