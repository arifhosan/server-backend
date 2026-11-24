import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity()
export class GameIcon {
  @PrimaryColumn()
  libraryGameId: number;

  @Column({ type: 'mediumblob' })
  png: Buffer;

  @UpdateDateColumn({ precision: 6 })
  updatedAt: Date;
}
