import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '@/database/transformers/bigint.transformer';

@Entity()
export class Playtime {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  date: string; // 'YYYY-MM-DD'

  @Column({ type: 'bigint', transformer: bigintTransformer })
  totalMs: number;

  @UpdateDateColumn()
  updatedAt: Date;
}
