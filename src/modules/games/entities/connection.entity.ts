import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ConnectionStatus, Provider } from '../games.types';

@Entity()
@Unique(['userId', 'provider'])
export class Connection {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: number;

  @Column({ type: 'varchar', length: 16 })
  provider: Provider;

  @Column({ length: 64 })
  externalId: string;

  @Column({ default: '' })
  displayName: string;

  /** Sealed with sealSecret; never returned by the API. */
  @Column({ type: 'text', nullable: true })
  secret: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  secretExpiresAt: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'ok' })
  status: ConnectionStatus;

  @CreateDateColumn({ precision: 6 })
  createdAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lastSyncAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lastSuccessAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @Column({ type: 'int', nullable: true })
  lastGameCount: number | null;
}
