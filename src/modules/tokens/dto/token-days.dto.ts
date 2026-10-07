import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

/** Field names match ccusage's daily rows so the poster can forward them as is. */
export class TokenDayDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date: string;

  @IsInt() @Min(0) inputTokens: number;
  @IsInt() @Min(0) outputTokens: number;
  @IsInt() @Min(0) cacheReadTokens: number;
  @IsInt() @Min(0) cacheCreationTokens: number;
  @IsInt() @Min(0) totalTokens: number;
  @IsNumber() @Min(0) totalCost: number;
}

export class TokenDaysDto {
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => TokenDayDto)
  days: TokenDayDto[];
}
