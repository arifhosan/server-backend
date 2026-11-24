import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const TRACKER_STORES = ['steam', 'xbox', 'epic', 'other'] as const;
export type TrackerStore = (typeof TRACKER_STORES)[number];

export class HeartbeatGameDto {
  @IsIn(TRACKER_STORES)
  store: TrackerStore;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  storeId?: string;

  @IsString()
  @Length(1, 255)
  @Matches(/\S/)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  exe?: string;
}

export class HeartbeatDto {
  @IsISO8601()
  @Matches(/(Z|[+-]\d{2}:\d{2})$/)
  at: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => HeartbeatGameDto)
  game: HeartbeatGameDto;
}

export class IconUploadDto {
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => HeartbeatGameDto)
  game: HeartbeatGameDto;

  /** Base64 of a PNG up to 64 KB; the length cap keeps junk from being decoded. */
  @IsString()
  @MaxLength(90_000)
  png: string;
}

export class HeartbeatsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => HeartbeatDto)
  heartbeats: HeartbeatDto[];
}
