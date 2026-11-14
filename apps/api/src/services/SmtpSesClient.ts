/**
 * Outbound SMTP provider (EMAIL_PROVIDER=smtp).
 *
 * Plunk talks to AWS SES through a single `ses` client in SESService. Instead of
 * rewriting every call site, this module provides a drop-in object with the same
 * shape as that client for the operations Plunk uses, and sends the already-built
 * raw MIME message through any SMTP server with nodemailer.
 *
 * Keeping the swap at the client boundary means upstream changes to MIME building,
 * headers, attachments, queueing and rate limiting keep working unchanged, and the
 * patch to upstream files stays a few lines long.
 *
 * Domain identity calls (DKIM, MAIL FROM, verification) have no SMTP equivalent:
 * DKIM/SPF are configured at your SMTP provider, so every domain is reported as
 * verified. Bounce, complaint, delivery, open and click events come from SES via
 * SNS and are not produced in SMTP mode.
 */
import {randomUUID} from 'node:crypto';

import type {SES} from '@aws-sdk/client-ses';
import nodemailer from 'nodemailer';
import signale from 'signale';

export type EmailProvider = 'ses' | 'smtp';

export function getEmailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  const value = (env.EMAIL_PROVIDER ?? 'ses').trim().toLowerCase();
  if (value === '' || value === 'ses') {
    return 'ses';
  }
  if (value === 'smtp') {
    return 'smtp';
  }
  throw new Error(`EMAIL_PROVIDER must be "ses" or "smtp", got "${env.EMAIL_PROVIDER}"`);
}

export const EMAIL_PROVIDER = getEmailProvider();

export interface OutboundSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  envelopeFrom: string;
  maxSendRate: number;
  rejectUnauthorized: boolean;
}

export function readOutboundSmtpConfig(env: NodeJS.ProcessEnv = process.env): OutboundSmtpConfig {
  const host = env.OUTBOUND_SMTP_HOST?.trim();
  if (!host) {
    throw new Error('OUTBOUND_SMTP_HOST is not defined in environment variables (required when EMAIL_PROVIDER=smtp)');
  }

  // Docker Compose passes unset variables as empty strings, so empty means "use the default"
  const read = (key: string) => env[key]?.trim() || undefined;

  const port = Number(read('OUTBOUND_SMTP_PORT') ?? '587');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`OUTBOUND_SMTP_PORT must be a valid port, got "${env.OUTBOUND_SMTP_PORT}"`);
  }

  // Port 465 is implicit TLS; 587/25 upgrade with STARTTLS. Allow an explicit override.
  const secureSetting = read('OUTBOUND_SMTP_SECURE');
  const secure = secureSetting !== undefined ? secureSetting === 'true' : port === 465;

  const maxSendRate = Number(read('OUTBOUND_SMTP_MAX_SEND_RATE') ?? '5');
  if (!Number.isFinite(maxSendRate) || maxSendRate <= 0) {
    throw new Error(`OUTBOUND_SMTP_MAX_SEND_RATE must be a positive number, got "${env.OUTBOUND_SMTP_MAX_SEND_RATE}"`);
  }

  return {
    host,
    port,
    secure,
    user: env.OUTBOUND_SMTP_USER ?? '',
    pass: env.OUTBOUND_SMTP_PASS ?? '',
    envelopeFrom: read('OUTBOUND_SMTP_ENVELOPE_FROM') ?? '',
    maxSendRate,
    rejectUnauthorized: read('OUTBOUND_SMTP_TLS_REJECT_UNAUTHORIZED') !== 'false',
  };
}

/** Minimal transport surface, so tests can pass a fake. */
export interface RawMailTransport {
  sendMail(mail: {envelope: {from: string; to: string[]}; raw: Buffer}): Promise<unknown>;
  verify?(): Promise<unknown>;
}

export function createTransport(config: OutboundSmtpConfig): RawMailTransport {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Credentials never travel in plaintext: with a username, STARTTLS is mandatory.
    // Without one (a local relay or test server), STARTTLS is still used when offered.
    requireTLS: !config.secure && config.user !== '',
    auth: config.user ? {user: config.user, pass: config.pass} : undefined,
    pool: true,
    tls: {rejectUnauthorized: config.rejectUnauthorized},
  });
}

const CRLF = '\r\n';

/**
 * SES adds Date and Message-ID to raw messages; a plain SMTP relay may not, and a
 * message without them scores worse with spam filters. Add them only if missing.
 */
export function addMissingHeaders(raw: string, messageId: string, fromAddress: string, now = new Date()): string {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headerSection = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const has = (name: string) => new RegExp(`^${name}:`, 'im').test(headerSection);

  const domain = fromAddress.includes('@') ? fromAddress.split('@').pop() : 'localhost';
  let prefix = '';
  if (!has('Date')) {
    prefix += `Date: ${now.toUTCString()}${CRLF}`;
  }
  if (!has('Message-ID')) {
    prefix += `Message-ID: <${messageId}@${domain}>${CRLF}`;
  }
  return prefix + raw;
}

type Identities = {Identities?: string[]};

/**
 * Build an object that answers the SES client calls Plunk makes, backed by SMTP.
 * Any SES operation not listed here rejects with a clear error instead of silently
 * doing nothing, so a new upstream SES call is noticed immediately.
 */
export function createSmtpSesClient(config: OutboundSmtpConfig, transport: RawMailTransport = createTransport(config)): SES {
  const operations = {
    async sendRawEmail(input: {Destinations?: string[]; RawMessage?: {Data?: Uint8Array}; Source?: string}) {
      const destinations = input.Destinations ?? [];
      const data = input.RawMessage?.Data;
      if (destinations.length === 0 || !data) {
        throw new Error('sendRawEmail requires Destinations and RawMessage.Data');
      }

      const source = input.Source ?? '';
      const messageId = randomUUID();
      const raw = addMissingHeaders(new TextDecoder().decode(data), messageId, source);

      await transport.sendMail({
        envelope: {from: config.envelopeFrom || source, to: destinations},
        raw: Buffer.from(raw, 'utf-8'),
      });

      return {MessageId: messageId};
    },

    async getSendQuota() {
      return {MaxSendRate: config.maxSendRate, Max24HourSend: -1, SentLast24Hours: 0};
    },

    async getIdentityVerificationAttributes({Identities = []}: Identities) {
      return {
        VerificationAttributes: Object.fromEntries(Identities.map(id => [id, {VerificationStatus: 'Success'}])),
      };
    },

    async getIdentityDkimAttributes({Identities = []}: Identities) {
      return {
        DkimAttributes: Object.fromEntries(
          Identities.map(id => [id, {DkimEnabled: true, DkimVerificationStatus: 'Success', DkimTokens: []}]),
        ),
      };
    },

    async verifyDomainDkim() {
      return {DkimTokens: []};
    },

    async setIdentityMailFromDomain() {
      return {};
    },

    async setIdentityFeedbackForwardingEnabled() {
      return {};
    },

    async deleteIdentity() {
      return {};
    },

    async describeConfigurationSet() {
      return {};
    },
  };

  if (transport.verify) {
    transport
      .verify()
      .then(() => signale.success(`[SMTP] Connected to ${config.host}:${config.port}`))
      .catch((error: unknown) =>
        signale.error(`[SMTP] Could not connect to ${config.host}:${config.port}. Emails will fail until this is fixed:`, error),
      );
  }

  return new Proxy(operations, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') {
        return undefined;
      }
      if (prop in target) {
        return target[prop as keyof typeof target];
      }
      return async () => {
        throw new Error(`SES operation "${prop}" is not available when EMAIL_PROVIDER=smtp`);
      };
    },
  }) as unknown as SES;
}
