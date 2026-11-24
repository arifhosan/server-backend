import { IsString, Length } from 'class-validator';

export class DeviceNameDto {
  @IsString()
  @Length(1, 100)
  name: string;
}
