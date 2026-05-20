import { Injectable } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

export type EmailLoginMessage = {
  to: string;
  code: string;
  loginUrl: string;
  expiresInMinutes: number;
};

@Injectable()
export class MailService {
  private transporter: Transporter | null = null;

  async sendEmailLogin(message: EmailLoginMessage) {
    const from = process.env.MAIL_FROM ?? process.env.SMTP_USER;

    if (!this.hasSmtpConfig() || !from) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('SMTP is not configured');
      }

      console.info(
        `Email login code for ${message.to}: ${message.code}. Link: ${message.loginUrl}`,
      );
      return;
    }

    await this.getTransporter().sendMail({
      from,
      to: message.to,
      subject: 'Код входа в Platforma',
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

  private renderText(message: EmailLoginMessage) {
    return [
      'Ваш код входа в Platforma:',
      '',
      message.code,
      '',
      `Код действует ${message.expiresInMinutes} минут.`,
      '',
      'Можно также войти по ссылке:',
      message.loginUrl,
      '',
      'Если вы не запрашивали вход, просто проигнорируйте это письмо.',
    ].join('\n');
  }

  private renderHtml(message: EmailLoginMessage) {
    return [
      '<div style="font-family: Arial, sans-serif; color: #18202a; line-height: 1.5;">',
      '<p>Ваш код входа в Platforma:</p>',
      `<p style="font-size: 28px; font-weight: 700; letter-spacing: 4px;">${this.escapeHtml(message.code)}</p>`,
      `<p>Код действует ${message.expiresInMinutes} минут.</p>`,
      `<p><a href="${this.escapeHtml(message.loginUrl)}">Войти в платформу</a></p>`,
      '<p style="color: #536172;">Если вы не запрашивали вход, просто проигнорируйте это письмо.</p>',
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
