import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { LegacyImportCliModule } from './legacy-import.module';
import { LegacyImportService } from './legacy-import.service';

describe('LegacyImportCliModule', () => {
  it('compiles without the DB and resolves LegacyImportService', async () => {
    const mod = await Test.createTestingModule({
      imports: [LegacyImportCliModule],
    })
      .overrideProvider(DataSource)
      .useValue({})
      .compile();
    expect(mod.get(LegacyImportService)).toBeInstanceOf(LegacyImportService);
  });
});
