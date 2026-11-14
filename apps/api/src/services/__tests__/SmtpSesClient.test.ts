import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  addMissingHeaders,
  createSmtpSesClient,
  getEmailProvider,
  readOutboundSmtpConfig,
  type OutboundSmtpConfig,
  type RawMailTransport,
} from '../SmtpSesClient';

const config: OutboundSmtpConfig = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  user: 'user',
  pass: 'pass',
  envelopeFrom: '',
  maxSendRate: 7,
  rejectUnauthorized: true,
};

function fakeTransport() {
  const sendMail = vi.fn<RawMailTransport['sendMail']>().mockResolvedValue({});
  return {sendMail};
}

describe('getEmailProvider', () => {
  it('defaults to ses', () => {
    expect(getEmailProvider({})).toBe('ses');
    expect(getEmailProvider({EMAIL_PROVIDER: ''})).toBe('ses');
  });

  it('accepts smtp case-insensitively', () => {
    expect(getEmailProvider({EMAIL_PROVIDER: ' SMTP '})).toBe('smtp');
  });

  it('rejects unknown providers instead of silently using SES', () => {
    expect(() => getEmailProvider({EMAIL_PROVIDER: 'sendgrid'})).toThrow(/EMAIL_PROVIDER/);
  });
});

describe('readOutboundSmtpConfig', () => {
  it('requires a host', () => {
    expect(() => readOutboundSmtpConfig({})).toThrow(/OUTBOUND_SMTP_HOST/);
  });

  it('treats empty strings from Docker Compose as unset', () => {
    const result = readOutboundSmtpConfig({
      OUTBOUND_SMTP_HOST: 'smtp.example.com',
      OUTBOUND_SMTP_PORT: '',
      OUTBOUND_SMTP_SECURE: '',
      OUTBOUND_SMTP_MAX_SEND_RATE: '',
      OUTBOUND_SMTP_ENVELOPE_FROM: '',
    });
    expect(result).toMatchObject({port: 587, secure: false, maxSendRate: 5, envelopeFrom: '', rejectUnauthorized: true});
  });

  it('uses implicit TLS on port 465 unless overridden', () => {
    expect(readOutboundSmtpConfig({OUTBOUND_SMTP_HOST: 'h', OUTBOUND_SMTP_PORT: '465'}).secure).toBe(true);
    expect(
      readOutboundSmtpConfig({OUTBOUND_SMTP_HOST: 'h', OUTBOUND_SMTP_PORT: '465', OUTBOUND_SMTP_SECURE: 'false'}).secure,
    ).toBe(false);
  });

  it('rejects an invalid port or rate', () => {
    expect(() => readOutboundSmtpConfig({OUTBOUND_SMTP_HOST: 'h', OUTBOUND_SMTP_PORT: 'abc'})).toThrow(/PORT/);
    expect(() => readOutboundSmtpConfig({OUTBOUND_SMTP_HOST: 'h', OUTBOUND_SMTP_MAX_SEND_RATE: '0'})).toThrow(/RATE/);
  });
});

describe('addMissingHeaders', () => {
  const now = new Date('2026-11-14T10:00:00Z');

  it('adds Date and Message-ID when absent', () => {
    const raw = 'From: a@example.com\nSubject: Hi\n\nBody';
    const result = addMissingHeaders(raw, 'abc', 'a@example.com', now);
    expect(result.startsWith('Date: Sat, 14 Nov 2026 10:00:00 GMT\r\nMessage-ID: <abc@example.com>\r\nFrom:')).toBe(true);
  });

  it('keeps existing headers and ignores look-alikes in the body', () => {
    const raw = 'Date: x\nMessage-ID: <y>\nFrom: a@example.com\n\nMessage-ID: in body';
    expect(addMissingHeaders(raw, 'abc', 'a@example.com', now)).toBe(raw);

    const bodyOnly = 'From: a@example.com\n\nDate: in body';
    expect(addMissingHeaders(bodyOnly, 'abc', 'a@example.com', now)).toContain('Date: Sat, 14 Nov 2026');
  });
});

describe('createSmtpSesClient', () => {
  it('relays the raw message with the SES envelope and returns a message id', async () => {
    const transport = fakeTransport();
    const client = createSmtpSesClient(config, transport);

    const result = await client.sendRawEmail({
      Destinations: ['to@example.org'],
      Source: 'from@example.com',
      RawMessage: {Data: new TextEncoder().encode('From: from@example.com\nSubject: Hi\n\nHello')},
    });

    expect(result.MessageId).toMatch(/^[0-9a-f-]{36}$/);
    const mail = transport.sendMail.mock.calls[0]![0];
    expect(mail.envelope).toEqual({from: 'from@example.com', to: ['to@example.org']});
    const raw = mail.raw.toString('utf-8');
    expect(raw).toContain(`Message-ID: <${result.MessageId}@example.com>`);
    expect(raw).toContain('Subject: Hi\n\nHello');
  });

  it('uses OUTBOUND_SMTP_ENVELOPE_FROM for the envelope when set', async () => {
    const transport = fakeTransport();
    const client = createSmtpSesClient({...config, envelopeFrom: 'bounces@example.com'}, transport);
    await client.sendRawEmail({
      Destinations: ['to@example.org'],
      Source: 'from@example.com',
      RawMessage: {Data: new TextEncoder().encode('From: x\n\nb')},
    });
    expect(transport.sendMail.mock.calls[0]![0].envelope.from).toBe('bounces@example.com');
  });

  it('propagates SMTP failures so the queue can retry', async () => {
    const transport = fakeTransport();
    transport.sendMail.mockRejectedValue(new Error('535 auth failed'));
    const client = createSmtpSesClient(config, transport);
    await expect(
      client.sendRawEmail({
        Destinations: ['to@example.org'],
        Source: 'from@example.com',
        RawMessage: {Data: new TextEncoder().encode('From: x\n\nb')},
      }),
    ).rejects.toThrow('535 auth failed');
  });

  it('reports the configured send rate as the quota', async () => {
    const client = createSmtpSesClient(config, fakeTransport());
    await expect(client.getSendQuota({})).resolves.toMatchObject({MaxSendRate: 7});
  });

  it('reports every domain as verified with no DKIM tokens', async () => {
    const client = createSmtpSesClient(config, fakeTransport());
    const identities = await client.getIdentityVerificationAttributes({Identities: ['a.com', 'b.com']});
    expect(identities.VerificationAttributes).toEqual({
      'a.com': {VerificationStatus: 'Success'},
      'b.com': {VerificationStatus: 'Success'},
    });
    await expect(client.verifyDomainDkim({Domain: 'a.com'})).resolves.toEqual({DkimTokens: []});
  });

  it('fails loudly on SES operations it does not implement', async () => {
    const client = createSmtpSesClient(config, fakeTransport());
    await expect(client.listIdentities({})).rejects.toThrow(/"listIdentities" is not available/);
  });

  it('is not mistaken for a promise', async () => {
    const client = createSmtpSesClient(config, fakeTransport());
    await expect(Promise.resolve(client)).resolves.toBe(client);
  });
});

describe('SESService in SMTP mode', () => {
  const sendMail = vi.fn().mockResolvedValue({});

  beforeEach(() => {
    vi.resetModules();
    sendMail.mockClear();
    vi.stubEnv('EMAIL_PROVIDER', 'smtp');
    vi.stubEnv('OUTBOUND_SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('AWS_SES_REGION', '');
    vi.stubEnv('AWS_SES_ACCESS_KEY_ID', '');
    vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', '');
    vi.doMock('nodemailer', () => ({default: {createTransport: () => ({sendMail})}}));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('nodemailer');
  });

  it('sends the full MIME message built by sendRawEmail through SMTP, without AWS credentials', async () => {
    const {sendRawEmail} = await import('../SESService');

    const result = await sendRawEmail({
      from: {name: 'Andry', email: 'news@example.com'},
      to: [{name: 'Reader', email: 'reader@example.org'}],
      content: {subject: 'Welcome', html: '<p>Hello there</p>'},
      headers: {'List-Unsubscribe': '<https://example.com/u>'},
    });

    expect(result.messageId).toBeTruthy();
    const mail = sendMail.mock.calls[0]![0];
    expect(mail.envelope).toEqual({from: 'news@example.com', to: ['reader@example.org']});
    const raw: string = mail.raw.toString('utf-8');
    expect(raw).toMatch(/^Date: /);
    expect(raw).toContain('Subject: Welcome');
    expect(raw).toContain('List-Unsubscribe: <https://example.com/u>');
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');
  });

  it('feeds the configured SMTP rate into the sending quota', async () => {
    vi.stubEnv('OUTBOUND_SMTP_MAX_SEND_RATE', '3');
    const {getSendingQuota} = await import('../SESService');
    await expect(getSendingQuota()).resolves.toMatchObject({maxSendRate: 3});
  });
});
