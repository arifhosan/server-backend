import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

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

  @Column({ type: 'bigint' })
  totalMs: number;

  @UpdateDateColumn()
  updatedAt: Date;
}
