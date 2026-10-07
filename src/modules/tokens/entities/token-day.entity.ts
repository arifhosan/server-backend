import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { bigintTransformer } from '@/database/transformers/bigint.transformer';

/** One day of Claude Code usage, as reported by `ccusage --json` on the dev machine. */
@Entity()
export class TokenDay {
  @PrimaryColumn({ length: 10 })
  date: string; // 'YYYY-MM-DD'

  @Column({ type: 'bigint', transformer: bigintTransformer })
  inputTokens: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  outputTokens: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  cacheReadTokens: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  cacheCreationTokens: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  totalTokens: number;

  /** ccusage's API list-price estimate in USD, not the subscription bill. DECIMAL also arrives as a string. */
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: bigintTransformer,
  })
  totalCost: number;

  @UpdateDateColumn()
  updatedAt: Date;
}
