import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '@/database/entities/user.entity';
import { AuthService } from './auth.service';

interface MockUserRepo {
  findOneBy: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}

const createMockRepo = (): MockUserRepo => ({
  findOneBy: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
});

describe('AuthService', () => {
  let service: AuthService;
  let userRepo: MockUserRepo;
  let jwtService: { signAsync: jest.Mock; verify: jest.Mock };

  beforeEach(async () => {
    userRepo = createMockRepo();
    jwtService = { signAsync: jest.fn(), verify: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: JwtService, useValue: jwtService },
        { provide: getRepositoryToken(User), useValue: userRepo },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('register', () => {
    const dto = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'hunter2',
    };

    it('rejects an email that is already registered', async () => {
      userRepo.findOneBy.mockResolvedValue({ id: 1, email: dto.email });

      await expect(service.register(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('hashes the password before saving', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      userRepo.create.mockImplementation((v: Partial<User>) => v);
      userRepo.save.mockImplementation((v: Partial<User>) =>
        Promise.resolve({ id: 7, ...v }),
      );

      await service.register(dto);

      const created = userRepo.create.mock.calls[0][0] as User;
      expect(created.password).not.toBe(dto.password);
      await expect(
        bcrypt.compare(dto.password, created.password),
      ).resolves.toBe(true);
    });
  });

  describe('login', () => {
    const dto = { email: 'ada@example.com', password: 'hunter2' };

    it('rejects an unknown email', async () => {
      userRepo.findOneBy.mockResolvedValue(null);

      await expect(service.login(dto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a wrong password', async () => {
      userRepo.findOneBy.mockResolvedValue({
        id: 1,
        email: dto.email,
        password: await bcrypt.hash('a-different-password', 10),
      });

      await expect(service.login(dto)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('returns a token and the public user fields on success', async () => {
      userRepo.findOneBy.mockResolvedValue({
        id: 1,
        email: dto.email,
        password: await bcrypt.hash(dto.password, 10),
      });
      jwtService.signAsync.mockResolvedValue('signed.jwt.token');

      const result = await service.login(dto);

      expect(jwtService.signAsync).toHaveBeenCalledWith({
        sub: 1,
        email: dto.email,
      });
      expect(result).toEqual({
        access_token: 'signed.jwt.token',
        user: { id: 1, email: dto.email },
      });
    });
  });

  describe('verify', () => {
    it('rejects a token that fails verification', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('bad signature');
      });

      await expect(service.verify('nope')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a valid token whose user no longer exists', async () => {
      jwtService.verify.mockReturnValue({ sub: 99, email: 'gone@example.com' });
      userRepo.findOneBy.mockResolvedValue(null);

      await expect(service.verify('token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('returns the public user fields for a valid token', async () => {
      jwtService.verify.mockReturnValue({ sub: 1, email: 'ada@example.com' });
      userRepo.findOneBy.mockResolvedValue({
        id: 1,
        email: 'ada@example.com',
        password: 'hashed',
      });

      await expect(service.verify('token')).resolves.toEqual({
        user: { id: 1, email: 'ada@example.com' },
      });
    });
  });
});
