import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export const STATION_ORDERS = [
  'votes',
  'clickcount',
  'clicktrend',
  'name',
  'bitrate',
  'random',
] as const;

export class SearchStationsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  /** ISO 3166-1 alpha-2 code, or a full country name. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string;

  /** Best effort: matched against region and station name. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  tag?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  codec?: string;

  @IsOptional()
  @IsIn(STATION_ORDERS)
  order?: (typeof STATION_ORDERS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
