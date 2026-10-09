import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { MailDelivery } from '@prisma/client';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { PrismaService, type Tx } from '../common/prisma.service.js';
import { environment } from '../config/environment.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  idempotencyKey?: string;
}

/**
 * Transactional email. `log` is for development only and is rejected by
 * environment validation in production.
 */
@Injectable()
export class MailerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MailerService.name);
  private transporter?: Transporter;
  /** Most recent messages, kept only outside production for tests. */
  readonly outbox: MailMessage[] = [];
  private running?: Promise<void>;
  private requested = false;
  private stopping = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    if (!environment().ENABLE_JOBS) return;
    this.timer = setInterval(() => this.kick(), 30_000);
    this.timer.unref();
    this.kick();
  }

  /** Must be called in the transaction that issues the token or changes business state. */
  async enqueue(tx: Tx, message: MailMessage, kind: string, options: {
    organizationId?: string; userId?: string; tokenId?: string; invitationId?: string; expiresAt?: Date;
  } = {}): Promise<string> {
    const id = randomUUID();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', environment().MAIL_ENCRYPTION_KEY, iv);
    cipher.setAAD(Buffer.from(`${id}:${kind}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
    const encryptedBody = ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':');
    await tx.mailDelivery.create({ data: {
      ...options, id, kind, encryptedBody, expiresAt: options.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
    } });
    return id;
  }

  kick(): void {
    if (this.stopping) return;
    this.requested = true;
    void this.processPending().catch(error => this.logger.error({ event: 'MAIL_QUEUE_FAILED', type: (error as Error)?.name }));
  }

  async processPending(): Promise<void> {
    if (this.stopping) return;
    if (this.running) return this.running;
    this.running = (async () => {
      do {
        this.requested = false;
        await this.drain();
      } while (this.requested && !this.stopping);
    })();
    try { await this.running; }
    finally { this.running = undefined; }
  }

  private async drain(): Promise<void> {
    await this.prisma.mailDelivery.updateMany({
      where: { expiresAt: { lte: new Date() }, encryptedBody: { not: null }, status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } },
      data: { status: 'FAILED', encryptedBody: null, lastError: 'EXPIRED' },
    });
    // Claim one at a time so waiting behind other messages cannot exhaust the claim lease.
    for (let i = 0; i < 25 && !this.stopping; i++) {
      const [row] = await this.prisma.$queryRaw<MailDelivery[]>`
        UPDATE "MailDelivery" SET status = 'PROCESSING', attempts = attempts + 1, "availableAt" = now() + interval '5 minutes'
        WHERE id IN (SELECT id FROM "MailDelivery" WHERE status IN ('PENDING', 'PROCESSING')
          AND "availableAt" <= now() AND "expiresAt" > now()
          ORDER BY "availableAt", id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`;
      if (!row) return;
      const owned = { id: row.id, status: 'PROCESSING' as const, attempts: row.attempts };
      try {
        const validToken = !row.tokenId || await this.prisma.userToken.findFirst({ where: { id: row.tokenId, usedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
        const validInvite = !row.invitationId || await this.prisma.staffInvitation.findFirst({ where: { id: row.invitationId, status: 'PENDING', expiresAt: { gt: new Date() } }, select: { id: true } });
        if (!validToken || !validInvite) {
          await this.prisma.mailDelivery.updateMany({ where: owned, data: { status: 'FAILED', encryptedBody: null, lastError: 'CANCELLED' } });
          continue;
        }
        const [version, iv, tag, body] = (row.encryptedBody ?? '').split(':');
        if (version !== 'v1' || !iv || !tag || !body) throw new Error('Invalid mail payload');
        const decipher = createDecipheriv('aes-256-gcm', environment().MAIL_ENCRYPTION_KEY, Buffer.from(iv, 'base64url'));
        decipher.setAAD(Buffer.from(`${row.id}:${row.kind}`));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        const message = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')) as MailMessage;
        await this.send({ ...message, idempotencyKey: `mail-${row.id}` });
        await this.prisma.mailDelivery.updateMany({ where: owned, data: { status: 'PROCESSED', processedAt: new Date(), encryptedBody: null, lastError: null } });
      } catch (error) {
        const gaveUp = row.attempts >= 8;
        await this.prisma.mailDelivery.updateMany({ where: owned, data: {
          status: gaveUp ? 'FAILED' : 'PENDING', lastError: (error as Error)?.name ?? 'Error',
          availableAt: new Date(Date.now() + Math.min(60, 2 ** row.attempts) * 60_000),
        } });
        this.logger.error({ event: 'MAIL_DELIVERY_FAILED', id: row.id, kind: row.kind, attempts: row.attempts, gaveUp });
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
    this.transporter?.close();
  }

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
            ...(message.idempotencyKey ? { 'idempotency-key': message.idempotencyKey } : {}),
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
        this.transporter ??= nodemailer.createTransport({ url: env.SMTP_URL, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 });
        await this.transporter.sendMail({ from: env.MAIL_FROM, to: message.to, subject: message.subject, text: message.text,
          ...(message.idempotencyKey ? { messageId: `<${message.idempotencyKey}@${new URL(env.APP_URL).hostname}>` } : {}),
        });
        return;
    }
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
