import { Test } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { JwtService } from '../src/jwt/jwt.service';
import { MailService } from '../src/mail/mail.service';
import { UsersService } from '../src/users/users.service';

describe('AuthService', () => {
  let service: AuthService;
  let users: jest.Mocked<UsersService>;
  let mail: jest.Mocked<MailService>;
  const dto = { email: 'ada@example.com', password: 'correct horse' };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: {
            create: jest.fn(),
            findByEmail: jest.fn(),
            findOneBy: jest.fn(),
            update: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: MailService,
          useValue: { sendWelcomeEmail: jest.fn(), sendVerificationEmail: jest.fn() },
        },
        { provide: JwtService, useValue: { sign: jest.fn().mockReturnValue('jwt') } },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
    users = moduleRef.get(UsersService);
    mail = moduleRef.get(MailService);
    users.create.mockResolvedValue({ id: 'u1', email: dto.email } as never);
  });

  it('stores a hashed password on register', async () => {
    await service.register(dto);
    const input = users.create.mock.calls[0]![0];
    expect(input.passwordHash).not.toEqual(dto.password);
  });

  it('rejects an unknown email on login', async () => {
    users.findByEmail.mockResolvedValue(null);
    await expect(service.login(dto)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('sends a verification email on register', async () => {
    await service.register(dto);
    expect(mail.sendVerificationEmail)
      .toHaveBeenCalledWith(dto.email, expect.any(String));
  });

  it('marks the user verified with a valid token', async () => {
    const user = { id: 'u1', emailVerified: false, verifyToken: 't1' };
    users.findOneBy.mockResolvedValue(user as never);
    await service.verifyEmail('t1');
    expect(users.findOneBy).toHaveBeenCalledWith({ verifyToken: 't1' });
    expect(users.save).toHaveBeenCalledWith(
      expect.objectContaining({ emailVerified: true, verifyToken: null }),
    );
  });

  it('rejects an unknown verification token', async () => {
    users.findOneBy.mockResolvedValue(null);
    await expect(service.verifyEmail('nope')).rejects.toBeInstanceOf(BadRequestException);
  });
});
