import type { AppConfig } from '../../config/env.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Terminalda göstərir. Lokal inkişaf üçün: kodu serverin logundan götürürsünüz. */
export class ConsoleMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    console.log(`\n--- EMAIL to ${message.to} ---\n${message.subject}\n${message.text}\n---\n`);
  }
}

/** Testlər göndərilən məktubları oxuya bilsin deyə yaddaşda saxlayır. */
export class MemoryMailer implements Mailer {
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.outbox.push(message);
  }

  /** Verilmiş ünvana gedən son məktubdakı 6 rəqəmli kod. */
  lastCodeFor(email: string): string | undefined {
    const mail = [...this.outbox].reverse().find((m) => m.to === email);
    return mail?.text.match(/\b(\d{6})\b/)?.[1];
  }
}

/** https://resend.com üzərindən göndərir (domen təsdiqi lazımdır). */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Resend responded with ${response.status}: ${await response.text()}`);
    }
  }
}

export function createMailer(config: AppConfig): Mailer {
  switch (config.mail.driver) {
    case 'resend':
      return new ResendMailer(config.mail.resendApiKey ?? '', config.mail.from);
    case 'memory':
      return new MemoryMailer();
    default:
      return new ConsoleMailer();
  }
}
