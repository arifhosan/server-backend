import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const DEFAULT_TIMEZONE = 'Europe/Berlin';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  firstName: string;

  @Column()
  lastName: string;

  @Column({ unique: true })
  email: string;

  @Column()
  password: string;

  @Column({ length: 64, default: DEFAULT_TIMEZONE })
  timezone: string;
}
