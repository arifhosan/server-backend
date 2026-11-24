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
}
