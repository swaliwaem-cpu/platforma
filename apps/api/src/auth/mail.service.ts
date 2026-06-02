import { Injectable } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

export type EmailRegistrationActivationMessage = {
  to: string;
  activationUrl: string;
  expiresInMinutes: number;
};

@Injectable()
export class MailService {
  private transporter: Transporter | null = null;

  async sendEmailRegistrationActivation(message: EmailRegistrationActivationMessage) {
    const from = process.env.MAIL_FROM ?? process.env.SMTP_USER;

    if (!this.hasSmtpConfig() || !from) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('SMTP is not configured');
      }

      console.info(`Email registration activation link for ${message.to}: ${message.activationUrl}`);
      return;
    }

    await this.getTransporter().sendMail({
      from,
      to: message.to,
      subject: 'Подтверждение регистрации в Platforma',
      text: this.renderText(message),
      html: this.renderHtml(message),
    });
  }

  private getTransporter() {
    if (this.transporter) {
      return this.transporter;
    }

    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 465),
      secure: this.parseBoolean(process.env.SMTP_SECURE, true),
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });

    return this.transporter;
  }

  private hasSmtpConfig() {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
  }

  private parseBoolean(value: string | undefined, fallback: boolean) {
    if (value === undefined) {
      return fallback;
    }

    return value === 'true' || value === '1';
  }

  private renderText(message: EmailRegistrationActivationMessage) {
    return [
      'Подтвердите регистрацию в Platforma:',
      '',
      message.activationUrl,
      '',
      `Ссылка действует ${message.expiresInMinutes} минут.`,
      '',
      'Ваш пароль: тот, который вы указали при регистрации.',
      '',
      'Если вы не запрашивали регистрацию, просто проигнорируйте это письмо.',
    ].join('\n');
  }

  private renderHtml(message: EmailRegistrationActivationMessage) {
    return [
      '<div style="font-family: Arial, sans-serif; color: #18202a; line-height: 1.5;">',
      '<p>Подтвердите регистрацию в Platforma:</p>',
      `<p><a href="${this.escapeHtml(message.activationUrl)}">Активировать аккаунт</a></p>`,
      `<p>Ссылка действует ${message.expiresInMinutes} минут.</p>`,
      '<p>Ваш пароль: тот, который вы указали при регистрации.</p>',
      '<p style="color: #536172;">Если вы не запрашивали регистрацию, просто проигнорируйте это письмо.</p>',
      '</div>',
    ].join('');
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
