import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { environment } from '../config/environment.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Transactional email. `log` is for development only and is rejected by
 * environment validation in production.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private transporter?: Transporter;
  /** Most recent messages, kept only outside production for tests. */
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    const env = environment();
    if (env.NODE_ENV !== 'production') {
      this.outbox.push(message);
      if (this.outbox.length > 50) this.outbox.shift();
    }
    switch (env.MAIL_PROVIDER) {
      case 'log':
        if (env.NODE_ENV === 'development')
          this.logger.log(`Email to ${message.to}: ${message.subject}\n${message.text}`);
        return;
      case 'resend': {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.RESEND_API_KEY}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: env.MAIL_FROM,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Email provider responded ${response.status}`);
        return;
      }
      case 'smtp':
        this.transporter ??= nodemailer.createTransport(env.SMTP_URL);
        await this.transporter.sendMail({ from: env.MAIL_FROM, ...message });
        return;
    }
  }

  /** Sends without delaying the HTTP response; failures are logged, not thrown. */
  sendInBackground(message: MailMessage, event: string): void {
    this.send(message).catch((error: unknown) =>
      this.logger.error({ event: 'MAIL_DELIVERY_FAILED', kind: event, type: (error as Error)?.name }),
    );
  }

  /**
   * Secrets travel in the URL fragment, which browsers never send to servers,
   * so tokens stay out of proxy logs and Referer headers.
   */
  link(path: string, secrets: Record<string, string>): string {
    const url = new URL(path, environment().APP_URL);
    url.hash = new URLSearchParams(secrets).toString();
    return url.toString();
  }
}
