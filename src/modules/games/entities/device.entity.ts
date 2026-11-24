import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity()
export class Device {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  userId: number;

  @Column({ length: 100 })
  name: string;

  @Column({ type: 'char', length: 64, unique: true })
  tokenHash: string;

  @Column({ length: 12 })
  tokenPrefix: string;

  @CreateDateColumn({ precision: 6 })
  createdAt: Date;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lastSeenAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  revokedAt: Date | null;
}
