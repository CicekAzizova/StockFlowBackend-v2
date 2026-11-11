import type { Locale } from '../../config/env.js';
import type { MailMessage } from './mailer.js';

type Purpose = 'verify_email' | 'reset_password';

const TEXTS: Record<Purpose, Record<Locale, { subject: string; intro: string; outro: string }>> = {
  verify_email: {
    az: {
      subject: 'StockFlow: email təsdiq kodu',
      intro: 'Email ünvanınızı təsdiqləmək üçün bu kodu tətbiqə daxil edin:',
      outro: 'Kod 15 dəqiqə etibarlıdır. Bu sorğunu siz etməmisinizsə, məktubu nəzərə almayın.',
    },
    en: {
      subject: 'StockFlow: your verification code',
      intro: 'Enter this code in the app to verify your email address:',
      outro: 'The code is valid for 15 minutes. If you did not request it, ignore this email.',
    },
    ru: {
      subject: 'StockFlow: код подтверждения email',
      intro: 'Введите этот код в приложении, чтобы подтвердить адрес электронной почты:',
      outro: 'Код действителен 15 минут. Если вы не запрашивали его, проигнорируйте письмо.',
    },
    tr: {
      subject: 'StockFlow: e-posta doğrulama kodu',
      intro: 'E-posta adresinizi doğrulamak için bu kodu uygulamaya girin:',
      outro: 'Kod 15 dakika geçerlidir. Bu isteği siz yapmadıysanız bu e-postayı dikkate almayın.',
    },
  },
  reset_password: {
    az: {
      subject: 'StockFlow: parolun sıfırlanması',
      intro: 'Parolunuzu sıfırlamaq üçün bu kodu tətbiqə daxil edin:',
      outro: 'Kod 15 dəqiqə etibarlıdır. Bu sorğunu siz etməmisinizsə, məktubu nəzərə almayın.',
    },
    en: {
      subject: 'StockFlow: reset your password',
      intro: 'Enter this code in the app to reset your password:',
      outro: 'The code is valid for 15 minutes. If you did not request it, ignore this email.',
    },
    ru: {
      subject: 'StockFlow: сброс пароля',
      intro: 'Введите этот код в приложении, чтобы сбросить пароль:',
      outro: 'Код действителен 15 минут. Если вы не запрашивали его, проигнорируйте письмо.',
    },
    tr: {
      subject: 'StockFlow: şifre sıfırlama',
      intro: 'Şifrenizi sıfırlamak için bu kodu uygulamaya girin:',
      outro: 'Kod 15 dakika geçerlidir. Bu isteği siz yapmadıysanız bu e-postayı dikkate almayın.',
    },
  },
};

export function codeEmail(purpose: Purpose, locale: Locale, to: string, code: string): MailMessage {
  const t = TEXTS[purpose][locale];
  return {
    to,
    subject: t.subject,
    text: `${t.intro}\n\n${code}\n\n${t.outro}`,
    html: `<p>${t.intro}</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>${t.outro}</p>`,
  };
}
