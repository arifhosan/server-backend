import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
@Index(['connectionId', 'startedAt'])
export class SyncRun {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  connectionId: number;

  @Column({ type: 'datetime', precision: 6 })
  startedAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  finishedAt: Date | null;

  @Column({ type: 'boolean', default: false })
  ok: boolean;

  @Column({ type: 'int', nullable: true })
  gameCount: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  error: string | null;
}
