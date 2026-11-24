import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { bigintTransformer } from '@/database/transformers/bigint.transformer';
import { Platform } from '../games.types';

@Entity()
@Unique(['userId', 'platform', 'externalId'])
@Index(['userId', 'titleKey'])
export class LibraryGame {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: number;

  @Column({ type: 'varchar', length: 16 })
  platform: Platform;

  @Column()
  externalId: string;

  @Column()
  title: string;

  @Column()
  titleKey: string;

  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  totalSeconds: number | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  totalChangedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lastPlayedAt: Date | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  imageUrl: string | null;

  /** Last Steam store art lookup that found nothing (retried after 30 days); a failed request is back-dated to retry after 1 day. */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  artCheckedAt: Date | null;

  /** Steam only: tracker seconds already seen that Steam's total has not caught up with yet (rows extended in place span syncs). */
  @Column({ type: 'int', default: 0 })
  trackerCreditSeconds: number;
}
