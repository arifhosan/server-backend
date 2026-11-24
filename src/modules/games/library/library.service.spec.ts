import { Repository } from 'typeorm';
import { LibraryGame } from '../entities/library-game.entity';
import { LibraryService } from './library.service';

describe('LibraryService.upsertByExternalId (M7)', () => {
  let rows: LibraryGame[];
  let service: LibraryService;

  beforeEach(() => {
    rows = [];
    const repo = {
      create: (d: Partial<LibraryGame>) => d as LibraryGame,
      save: (g: LibraryGame) => {
        if (!g.id) {
          g.id = rows.length + 1;
          rows.push(g);
        }
        return Promise.resolve(g);
      },
      findOneBy: (w: Partial<LibraryGame>) =>
        Promise.resolve(
          rows.find((r) =>
            Object.entries(w).every(
              ([k, v]) => r[k as keyof LibraryGame] === v,
            ),
          ) ?? null,
        ),
    };
    service = new LibraryService(repo as unknown as Repository<LibraryGame>);
  });

  const row = (totalSeconds: number | null) =>
    rows.push({
      id: rows.length + 1,
      userId: 1,
      platform: 'steam',
      externalId: '1091500',
      title: 'Cyberpunk 2077',
      titleKey: 'cyberpunk 2077',
      totalSeconds,
    } as LibraryGame);

  it('a tracker title never renames a row a platform sync owns', async () => {
    row(3600);
    const g = await service.upsertByExternalId(
      1,
      'steam',
      '1091500',
      'cp2077.exe',
    );
    expect(g).toMatchObject({
      title: 'Cyberpunk 2077',
      titleKey: 'cyberpunk 2077',
    });
  });

  it('a tracker title still renames a tracker-created row', async () => {
    row(null);
    const g = await service.upsertByExternalId(
      1,
      'steam',
      '1091500',
      'Cyberpunk 2077: Phantom Liberty',
    );
    expect(g.title).toBe('Cyberpunk 2077: Phantom Liberty');
    expect(g.titleKey).not.toBe('cyberpunk 2077');
  });

  it('the platform sync may rename its own row', async () => {
    row(3600);
    const g = await service.upsertByExternalId(
      1,
      'steam',
      '1091500',
      'Cyberpunk 2077 Ultimate',
      undefined,
      true,
    );
    expect(g.title).toBe('Cyberpunk 2077 Ultimate');
  });
});
