import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const TRACKER_STORES = ['steam', 'xbox', 'epic', 'other'] as const;
export type TrackerStore = (typeof TRACKER_STORES)[number];

export class HeartbeatGameDto {
  @IsIn(TRACKER_STORES)
  store: TrackerStore;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;

  @IsString()
  @Length(1, 255)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  exe?: string;
}

export class HeartbeatDto {
  @IsISO8601()
  at: string;

  @ValidateNested()
  @Type(() => HeartbeatGameDto)
  game: HeartbeatGameDto;
}

export class HeartbeatsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => HeartbeatDto)
  heartbeats: HeartbeatDto[];
}
