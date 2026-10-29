import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
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
        { provide: UsersService, useValue: { create: jest.fn(), findByEmail: jest.fn() } },
        { provide: MailService, useValue: { sendWelcomeEmail: jest.fn() } },
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
});
