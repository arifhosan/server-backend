import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '@/database/transformers/bigint.transformer';

@Entity()
export class TotalGameTime {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  slug: string;

  @Column()
  title: string;

  @Column()
  platform: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  totalMs: number;

  @UpdateDateColumn()
  updatedAt: Date;
}
