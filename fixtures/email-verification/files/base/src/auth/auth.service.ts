import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { JwtService } from '../jwt/jwt.service';
import { MailService } from '../mail/mail.service';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';

export interface RegisterDto {
  email: string;
  password: string;
}

export interface LoginDto {
  email: string;
  password: string;
}

export interface AuthResult {
  accessToken: string;
}

/**
 * Sign-up and sign-in.
 *
 * Passwords are hashed with bcrypt before they are stored. Access tokens are short-lived JWTs
 * signed by JwtService.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
  ) {}

  private hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }

  async register(dto: RegisterDto) {
    const passwordHash = await this.hashPassword(dto.password);
    const user = await this.users.create({ email: dto.email, passwordHash });
    return user;
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user: User | null = await this.users.findByEmail(dto.email);
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return { accessToken: this.jwt.sign({ sub: user.id }) };
  }
}
