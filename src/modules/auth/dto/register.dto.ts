import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName: string;

  @IsEmail()
  @MaxLength(255)
  email: string;

  // bcrypt only uses the first 72 bytes of a password; reject longer input
  // rather than silently truncating it.
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;
}
