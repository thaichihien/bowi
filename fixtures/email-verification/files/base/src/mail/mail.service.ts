import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app.config';
import { MailTransport } from './mail.transport';

/**
 * Sends transactional email.
 *
 * All messages go through the configured SMTP transport; templates are kept inline
 * because there are only a few of them.
 */
@Injectable()
export class MailService {
  constructor(
    private readonly cfg: AppConfig,
    private readonly transport: MailTransport,
  ) {}

  async sendWelcomeEmail(to: string) {
    await this.transport.sendMail({
      to,
      subject: 'Welcome to Acme',
      html: '<p>Thanks for signing up.</p>',
    });
  }

  async sendPasswordResetEmail(to: string, token: string) {
    const link = `${this.cfg.appUrl}/auth/reset-password?token=${token}`;
    await this.transport.sendMail({
      to, subject: 'Reset your password',
      html: `<a href="${link}">Reset your password</a>`,
    });
  }
}
