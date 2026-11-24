import { NestFactory } from '@nestjs/core';
import { LegacyImportCliModule } from './legacy-import.module';
import { LegacyImportService } from './legacy-import.service';

/** node dist/modules/games/legacy/run-legacy-import.js --user-id <id> [--commit]  (dry run unless --commit) */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--user-id');
  const userId = i >= 0 ? Number(args[i + 1]) : NaN;
  if (!Number.isInteger(userId) || userId < 1) {
    throw new Error('usage: run-legacy-import --user-id <id> [--commit]');
  }
  const app = await NestFactory.createApplicationContext(LegacyImportCliModule);
  try {
    const report = await app
      .get(LegacyImportService)
      .run(userId, { commit: args.includes('--commit') });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
