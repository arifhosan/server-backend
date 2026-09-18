import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export const MAX_PRESET_SLOT = 16;

export class CreateFavouriteDto {
  @IsUUID()
  stationUuid: string;

  @IsOptional()
  @IsString()
  name?: string;

  /** Omitted means the first free slot. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PRESET_SLOT)
  slot?: number;
}
