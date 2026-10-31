import { SendEmail } from './email.js';
export interface SmtpSenderOptions {
    host: string;
    port: number;
    /** true for implicit TLS (port 465); false for STARTTLS (587) or plain (25). */
    secure?: boolean;
    auth?: {
        user: string;
        pass: string;
    };
    /** Default sender address, used when a message omits `from`. */
    from: string;
}
/**
 * SMTP transport via nodemailer. All connection details come from config
 * (ASSISTANT_EMAIL_SMTP_* / config.json), never from the model. `nodemailer` is a dependency of
 * this package but imported dynamically so it is only loaded when SMTP is actually configured.
 */
export declare function createSmtpSender(options: SmtpSenderOptions): SendEmail;
