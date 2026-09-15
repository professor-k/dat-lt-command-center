import type { FastifyBaseLogger } from 'fastify';
import { env, isProd } from './env.js';

export interface Mail {
  to: string;
  subject: string;
  body: string;
}

export interface MailTransport {
  /** Named so the boot log can say how mail is leaving, or that it is not. */
  readonly name: string;
  send(mail: Mail, log: FastifyBaseLogger): Promise<void>;
}

/**
 * Writes the message to the server log instead of sending it.
 *
 * This is how self-service password resets work on a machine with no mail server: an
 * operator reads the link out of the log. It is deliberately not available in production —
 * a reset link in a log file is a reset link anyone with log access can use, and silently
 * degrading to that would be worse than refusing to start.
 */
const logTransport: MailTransport = {
  name: 'log',
  async send(mail, log) {
    log.info({ to: mail.to, subject: mail.subject }, `mail not sent (no transport configured):\n${mail.body}`);
  },
};

/**
 * Deliberately not a mail server.
 *
 * Wiring SMTP in means a dependency and credentials this project does not have yet, so the
 * seam is here and the implementation is not. `MAIL_TRANSPORT=smtp` is what a future
 * implementation registers against; until then production refuses to pretend it can send
 * mail, and `POST /api/auth/forgot` tells the caller to ask an administrator instead.
 */
export function resolveMailTransport(): MailTransport | null {
  if (env.MAIL_TRANSPORT === 'log' && !isProd) return logTransport;
  return null;
}

export const mailTransport = resolveMailTransport();

/** Whether self-service reset can actually deliver anything. */
export const canSendMail = mailTransport !== null;
