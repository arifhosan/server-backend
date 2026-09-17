import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Repository } from 'typeorm';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload, LoginResult, PublicUser } from './types/auth.types';
import * as bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 10;

const toPublicUser = (user: User): PublicUser => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
});

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  async register(dto: RegisterDto): Promise<PublicUser> {
    const existing = await this.userRepo.findOneBy({ email: dto.email });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const hashed = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = this.userRepo.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      password: hashed,
    });

    // Returning the saved entity directly would put the bcrypt hash in the
    // HTTP response.
    return toPublicUser(await this.userRepo.save(user));
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.userRepo.findOneBy({ email: dto.email });
    if (!user || !(await bcrypt.compare(dto.password, user.password))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const token = await this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
    });

    return { access_token: token, user: { id: user.id, email: user.email } };
  }

  async verify(token: string): Promise<{ user: LoginResult['user'] }> {
    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      const user = await this.userRepo.findOneBy({ id: payload.sub });
      if (!user) {
        throw new UnauthorizedException('User not found');
      }
      return { user: { id: user.id, email: user.email } };
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }
}
