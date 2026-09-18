import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity()
export class FavouriteStation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 36, unique: true })
  stationUuid: string;

  @Column()
  name: string;

  @Column({ default: '' })
  countryCode: string;

  /** Preset position the ESP32 cycles through. */
  @Column({ type: 'int', unique: true })
  slot: number;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;
}
