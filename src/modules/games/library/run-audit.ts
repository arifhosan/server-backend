import { NestFactory } from '@nestjs/core';
import { LibraryAuditCliModule, LibraryAuditService } from './library-audit';

/** node dist/modules/games/library/run-audit.js --user-id <id>  (read-only dry run of the sync repairs) */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--user-id');
  const userId = i >= 0 ? Number(args[i + 1]) : NaN;
  if (!Number.isInteger(userId) || userId < 1)
    throw new Error('usage: run-audit --user-id <id>');
  const app = await NestFactory.createApplicationContext(LibraryAuditCliModule);
  try {
    const report = await app.get(LibraryAuditService).run(userId);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
