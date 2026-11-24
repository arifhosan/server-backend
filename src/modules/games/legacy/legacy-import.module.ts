import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../../database/database.module';
import { LegacyImportService } from './legacy-import.service';

/**
 * Minimal module for the run-legacy-import CLI: no HTTP server, cron or
 * gateways. LegacyImportService only needs the DataSource (raw SQL), so no
 * forFeature entities are registered.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
  providers: [LegacyImportService],
})
export class LegacyImportCliModule {}
