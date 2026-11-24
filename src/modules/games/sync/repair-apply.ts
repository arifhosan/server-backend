import { EntityManager } from 'typeorm';
import { GameIcon } from '../entities/game-icon.entity';
import { LibraryGame } from '../entities/library-game.entity';
import { PlaySession } from '../entities/play-session.entity';
import { foldGame } from '../library/library.service';
import { RepairAction, SessionRepair } from './repair-plan';

export interface RepairPlan {
  /** Rows whose stored titleKey is stale. */
  rekey: { id: number; to: string }[];
  sessionRepairs: SessionRepair[];
  actions: RepairAction[];
}

/**
 * Writes a repair plan inside the caller's transaction: the hourly sync and `run-audit --apply`
 * share it. `keep` actions change nothing and go to `onKeep`.
 */
export async function applyRepairs(
  m: EntityManager,
  plan: RepairPlan,
  onKeep: (a: Extract<RepairAction, { kind: 'keep' }>) => void = () => {},
): Promise<void> {
  const games = m.getRepository(LibraryGame);
  for (const r of plan.rekey) await games.update(r.id, { titleKey: r.to });
  for (const f of plan.sessionRepairs)
    await m
      .getRepository(PlaySession)
      .update(f.id, { startedAt: f.startedAt, source: f.source });
  for (const a of plan.actions) {
    switch (a.kind) {
      case 'relabel':
        await games.update(a.id, { platform: a.platform });
        break;
      case 'delete':
        await m.getRepository(GameIcon).delete({ libraryGameId: a.id });
        await games.delete(a.id);
        break;
      case 'keep':
        onKeep(a);
        break;
      case 'fold':
      case 'foldLegacy': {
        const dup = await games.findOneBy({
          id: a.kind === 'fold' ? a.dupId : a.legacyId,
        });
        const into = await games.findOneBy({ id: a.intoId });
        if (!dup || !into) break;
        // The synced total stays authoritative; a fold only moves sessions, icon and art.
        await foldGame(dup, into, m);
        await games.save(into);
      }
    }
  }
}
