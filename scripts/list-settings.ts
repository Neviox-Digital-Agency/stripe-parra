// Read-only: prints the Parra settings the worker needs (workspace and payment device marks,
// operator OIB, bank account id). Run it yourself so the API key never leaves your shell:
//   PARRA_API_KEY=... PARRA_BUSINESS_SUBJECT_ID=... PARRA_BASE_URL=https://api.parra.hr \
//     bun run scripts/list-settings.ts
import { ParraClient } from '../src/index';

const baseUrl = process.env.PARRA_BASE_URL ?? 'https://sandbox-api.parra.hr';
const apiKey = process.env.PARRA_API_KEY;
const businessSubjectId = process.env.PARRA_BUSINESS_SUBJECT_ID;
if (!apiKey || !businessSubjectId) {
  console.error('Set PARRA_API_KEY and PARRA_BUSINESS_SUBJECT_ID (and PARRA_BASE_URL for production).');
  process.exit(1);
}

const parra = new ParraClient({ baseUrl, apiKey, businessSubjectId });
console.log(`Parra: ${baseUrl}, subject ${businessSubjectId}\n`);
for (const kind of ['workspaces', 'payment-devices', 'operators', 'bank-accounts'] as const) {
  console.log(`== ${kind} ==`);
  try {
    console.log(JSON.stringify(await parra.settings(kind), null, 2));
  } catch (error) {
    console.log(`failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log();
}
