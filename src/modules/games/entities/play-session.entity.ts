import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SessionSource } from '../games.types';

@Entity()
@Index(['userId', 'startedAt'])
@Index(['libraryGameId', 'startedAt'])
@Index(['deviceId', 'libraryGameId', 'startedAt'])
export class PlaySession {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: number;

  @Column()
  libraryGameId: number;

  @Column({ type: 'varchar', length: 16 })
  source: SessionSource;

  @Column({ type: 'int', nullable: true })
  deviceId: number | null;

  @Column({ type: 'datetime', precision: 6 })
  startedAt: Date;

  @Column({ type: 'datetime', precision: 6 })
  endedAt: Date;

  @Column({ type: 'int' })
  seconds: number;

  /** `game:<id>` / `game_old:<id>`: makes the legacy import idempotent. */
  @Column({ type: 'varchar', length: 32, nullable: true, unique: true })
  legacyRef: string | null;
}
