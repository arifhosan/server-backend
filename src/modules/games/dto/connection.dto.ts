import { IsString, Length } from 'class-validator';

export class SteamConnectDto {
  @IsString()
  @Length(1, 255)
  profile: string;
}

export class PsnConnectDto {
  @IsString()
  @Length(20, 200)
  npsso: string;
}
