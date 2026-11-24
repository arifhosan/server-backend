import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Platform } from '../games.types';

const PLATFORMS: Platform[] = [
  'steam',
  'xbox_pc',
  'epic',
  'pc_other',
  'ps5',
  'ps4',
];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class PeriodQueryDto {
  @Matches(DAY, { message: 'from must be YYYY-MM-DD' })
  from: string;

  @Matches(DAY, { message: 'to must be YYYY-MM-DD' })
  to: string;

  @IsOptional()
  @IsIn(PLATFORMS)
  platform?: Platform;
}

export class SessionsQueryDto extends PeriodQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  libraryGameId?: number;
}

export class LibraryQueryDto {
  @IsOptional()
  @IsIn(PLATFORMS)
  platform?: Platform;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class CalendarQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;
}
