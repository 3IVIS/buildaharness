/**
 * SMTP transport for send_email (adoption plan F2, path (a)).
 *
 * Node-only: it lazy-loads `nodemailer` inside the factory so a static import never reaches the
 * browser bundle (assistant.ts/index.ts, which chat-ui bundles, must not pull node deps). Wired in
 * only by Node callers (cli.ts), the same split shell-executor.ts / node-fs-backend.ts use. The
 * pure-`fetch` Resend transport in email.ts is the browser-safe alternative.
 */
import { EmailDeliveryError, type EmailMessage, type SendEmail } from './email.js'

export interface SmtpSenderOptions {
  host: string
  port: number
  /** true for implicit TLS (port 465); false for STARTTLS (587) or plain (25). */
  secure?: boolean
  auth?: { user: string; pass: string }
  /** Default sender address, used when a message omits `from`. */
  from: string
}

/**
 * SMTP transport via nodemailer. All connection details come from config
 * (ASSISTANT_EMAIL_SMTP_* / config.json), never from the model. `nodemailer` is a dependency of
 * this package but imported dynamically so it is only loaded when SMTP is actually configured.
 */
export function createSmtpSender(options: SmtpSenderOptions): SendEmail {
  return async (message: EmailMessage) => {
    let nodemailer: typeof import('nodemailer')
    try {
      nodemailer = await import('nodemailer')
    } catch (err) {
      throw new EmailDeliveryError(
        'smtp',
        `could not load nodemailer (${err instanceof Error ? err.message : String(err)}) — reinstall @buildaharness/personal-assistant`,
      )
    }
    const transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure ?? options.port === 465,
      auth: options.auth,
    })
    try {
      const info = await transport.sendMail({
        from: message.from ?? options.from,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject,
        text: message.body,
      })
      return { provider: 'smtp', id: typeof info.messageId === 'string' ? info.messageId : undefined }
    } catch (err) {
      throw new EmailDeliveryError('smtp', err instanceof Error ? err.message : String(err))
    } finally {
      transport.close()
    }
  }
}
