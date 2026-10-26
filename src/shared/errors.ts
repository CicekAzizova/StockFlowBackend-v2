/**
 * Tətbiqin bütün gözlənilən xətaları AppError ilə atılır.
 * Cavab formatı: { message, code, details? }
 *  - message: köhnə iOS uyğunluğu və debug üçün oxunaqlı mətn
 *  - code: sabit maşın kodu, iOS dili buna görə tərcümə edir
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (code: string, message: string) => new AppError(401, code, message);
export const forbidden = (code: string, message: string, details?: unknown) =>
  new AppError(403, code, message, details);
export const notFound = (code: string, message: string) => new AppError(404, code, message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooManyRequests = (code: string, message: string) => new AppError(429, code, message);
