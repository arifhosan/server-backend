import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '@/database/transformers/bigint.transformer';

@Entity()
export class Game {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  title: string;

  @Column({ default: '' })
  link: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  // NOTE: holds SECONDS, not milliseconds. The scraper has always written
  // seconds and the column was never renamed; treat the name as historical.
  playtimeMs: number;

  @Column({ default: '' })
  slug: string;

  @Column({ default: '' })
  platform: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;
}
