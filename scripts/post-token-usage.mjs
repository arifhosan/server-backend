#!/usr/bin/env node
// Posts the last 8 days of Claude Code usage from ccusage to POST /tokens.
// Rows are upserted by date on the server, so running this twice is harmless.
//
//   node scripts/post-token-usage.mjs
//   TOKENS_URL and TOKENS_AUTH_TOKEN override the defaults.
//
// The secret is in the clear here on purpose: it only lets someone write
// token counts into a table the owner reads. Rotate it in Portainer and here.

import { execSync } from 'node:child_process';

const url = process.env.TOKENS_URL ?? 'https://api.server.arifhosan.me/tokens';
const token =
  process.env.TOKENS_AUTH_TOKEN ??
  'T2nqcCez5WU1fNcv2yR0syqNvOkH64bE0cJghf7Op3A';

const since = new Date();
since.setDate(since.getDate() - 7);
const sinceArg = since.toISOString().slice(0, 10).replaceAll('-', '');

const { daily } = JSON.parse(
  // a shell string, not execFile: Node 24 refuses to spawn npx.cmd directly, and every argument here is a constant
  execSync(`npx ccusage --json --since ${sinceArg}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);

// ccusage calls the date "period"; the server wants "date" and only the counts.
const days = daily.map((d) => ({
  date: d.period,
  inputTokens: d.inputTokens,
  outputTokens: d.outputTokens,
  cacheReadTokens: d.cacheReadTokens,
  cacheCreationTokens: d.cacheCreationTokens,
  totalTokens: d.totalTokens,
  totalCost: d.totalCost,
}));

const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ days }),
});
if (!res.ok) {
  console.error(`${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(
  `stored ${days.length} days: ${days.map((d) => d.date).join(', ')}`,
);
