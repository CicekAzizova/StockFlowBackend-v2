import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AccessTokenPayload, AppDeps } from '../../app-types.js';
import type { Locale } from '../../config/env.js';
import { isUniqueViolation, withTransaction, type Queryable } from '../../db/pool.js';
import { codeEmail } from '../../infra/mail/templates.js';
import { badRequest, conflict, tooManyRequests, unauthorized } from '../../shared/errors.js';
import * as stores from '../stores/stores.repository.js';
import * as subscriptions from '../subscriptions/subscriptions.repository.js';
import * as users from '../users/users.repository.js';
import type { UserWithStore } from '../users/users.repository.js';
import * as repo from './auth.repository.js';
import type { CodePurpose } from './auth.repository.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';

const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
/** Cavab itəndə eyni refresh token təkrar gələrsə (şəbəkə xətası) bu müddət ərzində etibar olunur. */
const REFRESH_REUSE_GRACE_MS = 30 * 1000;

export interface Session {
  token: string;
  refresh_token: string;
  expires_in: number;
}

export interface RegisterInput {
  name: string;
  surname: string;
  email: string;
  password: string;
  phone: string;
  store_name: string;
  store_address: string;
  store_phone: string;
  locale: Locale;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function ttlSeconds(ttl: string): number {
  const amount = Number.parseInt(ttl, 10);
  const unit = ttl.slice(-1);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86_400 }[unit] ?? 1;
  return amount * multiplier;
}

export type AuthService = ReturnType<typeof createAuthService>;

export function createAuthService(
  deps: AppDeps,
  signAccessToken: (payload: AccessTokenPayload) => string,
  log: FastifyBaseLogger,
) {
  const { config, pool, mailer } = deps;

  // ------------------------------------------------------------------ sessions

  async function issueSession(
    db: Queryable,
    user: UserWithStore,
    familyId: string,
    userAgent: string | null,
  ): Promise<Session> {
    const refreshToken = randomBytes(32).toString('base64url');
    await repo.insertRefreshToken(db, {
      userId: user.id,
      familyId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + config.auth.refreshTokenTtlDays * 86_400_000),
      userAgent: userAgent?.slice(0, 200) ?? null,
    });
    const token = signAccessToken({
      sub: String(user.id),
      role: user.role,
      storeId: user.effective_store_id,
      ev: user.email_verified_at !== null,
    });
    return {
      token,
      refresh_token: refreshToken,
      expires_in: ttlSeconds(config.auth.accessTokenTtl),
    };
  }

  // ------------------------------------------------------------------ one-time codes

  const hashCode = (userId: number, purpose: CodePurpose, code: string) =>
    createHmac('sha256', config.auth.jwtSecret)
      .update(`${userId}:${purpose}:${code}`)
      .digest('hex');

  /** Yeni kod yaradıb göndərir. Çox tez təkrarlananda göndərmir və 'cooldown' qaytarır. */
  async function issueCode(
    user: UserWithStore,
    purpose: CodePurpose,
  ): Promise<'sent' | 'cooldown'> {
    const latest = await repo.latestCodeCreatedAt(pool, user.id, purpose);
    if (latest && Date.now() - latest.getTime() < CODE_RESEND_COOLDOWN_MS) return 'cooldown';

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await withTransaction(pool, async (tx) => {
      await repo.invalidateCodes(tx, user.id, purpose);
      await repo.insertCode(tx, {
        userId: user.id,
        purpose,
        codeHash: hashCode(user.id, purpose, code),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
    });
    // Email göndərmə cavabı gecikdirməsin. Xəta olsa yalnız loga yazılır.
    mailer
      .send(codeEmail(purpose, user.locale, user.email, code))
      .catch((error: unknown) => log.error({ err: error, purpose }, 'Failed to send email'));
    return 'sent';
  }

  async function consumeCode(userId: number, purpose: CodePurpose, code: string): Promise<void> {
    const outcome = await withTransaction(pool, async (tx) => {
      const row = await repo.findActiveCodeForUpdate(tx, userId, purpose);
      if (!row) return 'invalid' as const;
      if (row.attempts >= MAX_CODE_ATTEMPTS) return 'locked' as const;

      const expected = Buffer.from(row.code_hash);
      const actual = Buffer.from(hashCode(userId, purpose, code));
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        await repo.incrementCodeAttempts(tx, row.id);
        return 'invalid' as const;
      }
      await repo.consumeCode(tx, row.id);
      return 'ok' as const;
    });

    if (outcome === 'locked') {
      throw tooManyRequests('TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Request a new code');
    }
    if (outcome === 'invalid') throw badRequest('INVALID_CODE', 'Invalid or expired code');
  }

  // ------------------------------------------------------------------ public API

  return {
    async register(input: RegisterInput, userAgent: string | null) {
      if (await users.isEmailOrFinTaken(pool, { email: input.email })) {
        throw conflict('EMAIL_ALREADY_REGISTERED', 'Email is already registered');
      }
      const passwordHash = await hashPassword(input.password);

      let ownerId: number;
      let store: stores.StoreRecord;
      try {
        ({ ownerId, store } = await withTransaction(pool, async (tx) => {
          const ownerId = await users.insertOwner(tx, {
            name: input.name,
            surname: input.surname,
            email: input.email,
            phone: input.phone,
            passwordHash,
            locale: input.locale,
          });
          const store = await stores.insertStore(tx, {
            ownerId,
            name: input.store_name,
            address: input.store_address,
            phone: input.store_phone,
            timezone: config.defaultTimezone,
          });
          if (!store) throw new Error('Failed to insert store');
          await subscriptions.createFreeSubscription(tx, ownerId, config.freeProductLimit);
          return { ownerId, store };
        }));
      } catch (error) {
        if (isUniqueViolation(error, 'users_email_active_uq')) {
          throw conflict('EMAIL_ALREADY_REGISTERED', 'Email is already registered');
        }
        throw error;
      }

      const user = await users.findActiveById(pool, ownerId);
      if (!user) throw new Error('Owner disappeared after registration');
      await issueCode(user, 'verify_email');
      const session = await issueSession(pool, user, randomUUID(), userAgent);
      return { user, store, session };
    },

    async login(email: string, password: string, userAgent: string | null) {
      const user = await users.findActiveByEmail(pool, email);
      if (!user) {
        await verifyAgainstDummy(password);
        throw unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
      }
      if (!(await verifyPassword(user.password_hash, password))) {
        throw unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
      }
      const session = await issueSession(pool, user, randomUUID(), userAgent);
      return { user, session };
    },

    /** Refresh token rotasiyası: hər istifadədə yenisi verilir, köhnəsi ləğv olunur. */
    async refresh(refreshToken: string, userAgent: string | null): Promise<Session> {
      const outcome = await withTransaction(pool, async (tx) => {
        const record = await repo.findRefreshTokenForUpdate(tx, sha256(refreshToken));
        if (!record || record.expires_at.getTime() <= Date.now())
          return { kind: 'invalid' as const };

        if (record.revoked_at) {
          const recentlyRotated =
            record.rotated_at !== null &&
            Date.now() - record.rotated_at.getTime() < REFRESH_REUSE_GRACE_MS;
          if (!recentlyRotated) {
            // Köhnə token təkrar işlədilib: oğurlanma ehtimalı var, bütün sessiya ləğv edilir.
            await repo.revokeFamily(tx, record.family_id);
            return { kind: 'reused' as const };
          }
        } else {
          await repo.revokeRefreshToken(tx, record.id);
        }

        const user = await users.findActiveById(tx, record.user_id);
        if (!user) return { kind: 'invalid' as const };
        return {
          kind: 'ok' as const,
          session: await issueSession(tx, user, record.family_id, userAgent),
        };
      });

      if (outcome.kind !== 'ok') {
        throw unauthorized('INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
      }
      return outcome.session;
    },

    /** Verilmiş refresh token-in bütün sessiyasını ləğv edir. Naməlum token xəta vermir. */
    async logout(refreshToken: string): Promise<void> {
      const record = await repo.findRefreshToken(pool, sha256(refreshToken));
      if (record) await repo.revokeFamily(pool, record.family_id);
    },

    async logoutAll(userId: number): Promise<void> {
      await repo.revokeAllForUser(pool, userId);
    },

    async verifyEmail(userId: number, code: string): Promise<void> {
      const user = await users.findActiveById(pool, userId);
      if (!user) throw unauthorized('INVALID_TOKEN', 'Invalid or expired token');
      if (user.email_verified_at) return;
      await consumeCode(userId, 'verify_email', code);
      await users.markEmailVerified(pool, userId);
    },

    async resendVerification(userId: number): Promise<void> {
      const user = await users.findActiveById(pool, userId);
      if (!user) throw unauthorized('INVALID_TOKEN', 'Invalid or expired token');
      if (user.email_verified_at) return;
      if ((await issueCode(user, 'verify_email')) === 'cooldown') {
        throw tooManyRequests(
          'CODE_RECENTLY_SENT',
          'Please wait a minute before requesting another code',
        );
      }
    },

    /** Həmişə uğurlu görünür ki, kimin qeydiyyatda olduğu bilinməsin. */
    async forgotPassword(email: string): Promise<void> {
      const user = await users.findActiveByEmail(pool, email);
      if (user) await issueCode(user, 'reset_password');
    },

    async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
      const user = await users.findActiveByEmail(pool, email);
      if (!user) {
        await verifyAgainstDummy(code);
        throw badRequest('INVALID_CODE', 'Invalid or expired code');
      }
      await consumeCode(user.id, 'reset_password', code);
      const passwordHash = await hashPassword(newPassword);
      await withTransaction(pool, async (tx) => {
        await users.setPassword(tx, user.id, passwordHash);
        await users.markEmailVerified(tx, user.id);
        await repo.revokeAllForUser(tx, user.id);
      });
    },

    /** Parol dəyişəndə bütün cihazlar çıxarılır, cari cihaza yeni sessiya verilir. */
    async changePassword(
      userId: number,
      currentPassword: string,
      newPassword: string,
      userAgent: string | null,
    ): Promise<Session> {
      const user = await users.findActiveById(pool, userId);
      if (!user) throw unauthorized('INVALID_TOKEN', 'Invalid or expired token');
      if (!(await verifyPassword(user.password_hash, currentPassword))) {
        // 401 verilmir: iOS 401-i "sessiya bitdi" kimi qəbul edib istifadəçini çıxarır.
        throw badRequest('INVALID_PASSWORD', 'Current password is incorrect');
      }
      const passwordHash = await hashPassword(newPassword);
      return withTransaction(pool, async (tx) => {
        await users.setPassword(tx, userId, passwordHash);
        await repo.revokeAllForUser(tx, userId);
        return issueSession(tx, user, randomUUID(), userAgent);
      });
    },
  };
}
