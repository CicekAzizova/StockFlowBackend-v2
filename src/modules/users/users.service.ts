import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps, AuthContext } from '../../app-types.js';
import { isUniqueViolation, queryMany, withTransaction } from '../../db/pool.js';
import { keysForUrl, saveImage } from '../../infra/images.js';
import type { Locale } from '../../config/env.js';
import { badRequest, conflict, notFound, unauthorized } from '../../shared/errors.js';
import { requireStoreId } from '../../shared/auth-helpers.js';
import * as authRepo from '../auth/auth.repository.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import * as sales from '../sales/sales.repository.js';
import * as stores from '../stores/stores.repository.js';
import { toAssociateDto, toUserDto } from './users.dto.js';
import * as repo from './users.repository.js';

const TAKEN = 'Email or FIN is already registered';

export type UsersService = ReturnType<typeof createUsersService>;

export function createUsersService(deps: AppDeps, log: FastifyBaseLogger) {
  const { pool, storage, config } = deps;

  function cleanup(urls: string[]): void {
    const keys = urls.flatMap((url) => keysForUrl(storage, url));
    if (keys.length === 0) return;
    storage
      .delete(keys)
      .catch((error: unknown) => log.warn({ err: error }, 'Image cleanup failed'));
  }

  async function requireUser(userId: number) {
    const user = await repo.findActiveById(pool, userId);
    if (!user) throw unauthorized('INVALID_TOKEN', 'Invalid or expired token');
    return user;
  }

  async function storeTimezone(storeId: number): Promise<string> {
    return (await stores.findStoreById(pool, storeId))?.timezone ?? config.defaultTimezone;
  }

  return {
    // ------------------------------------------------------------------ profil

    async getMe(userId: number) {
      return toUserDto(await requireUser(userId), storage);
    },

    async updateMe(
      userId: number,
      body: {
        name?: string | undefined;
        surname?: string | undefined;
        phone?: string | undefined;
        locale?: Locale | undefined;
      },
    ) {
      await requireUser(userId);
      await repo.updateUser(pool, userId, body);
      return toUserDto(await requireUser(userId), storage);
    },

    async setAvatar(userId: number, image: Buffer) {
      const user = await requireUser(userId);
      const stored = await saveImage(storage, image, 'avatar', `avatars/${userId}`);
      await repo.updateUser(pool, userId, { avatar_url: stored.url });
      if (user.avatar_url) cleanup([user.avatar_url]);
      return toUserDto(await requireUser(userId), storage);
    },

    async removeAvatar(userId: number) {
      const user = await requireUser(userId);
      await repo.updateUser(pool, userId, { avatar_url: null });
      if (user.avatar_url) cleanup([user.avatar_url]);
      return toUserDto(await requireUser(userId), storage);
    },

    /**
     * Hesabı silmək (App Store tələbi).
     *  - sahib: mağazalar, məhsullar, satışlar və satıcılar bütövlükdə silinir
     *  - satıcı: şəxsi məlumatı silinir, satış tarixçəsi sahibin hesabatı üçün qalır
     */
    async deleteAccount(userId: number, password: string): Promise<void> {
      const user = await requireUser(userId);
      if (!(await verifyPassword(user.password_hash, password))) {
        // 401 verilmir: iOS 401-i sessiya bitməsi kimi qəbul edir.
        throw badRequest('INVALID_PASSWORD', 'Password is incorrect');
      }

      const imageUrls: string[] = user.avatar_url ? [user.avatar_url] : [];

      if (user.role === 'OWNER') {
        const productImages = await queryMany<{ url: string }>(
          pool,
          `SELECT unnest(p.image_urls) AS url FROM products p
           JOIN stores s ON s.id = p.store_id WHERE s.owner_id = $1`,
          [userId],
        );
        const associateAvatars = await queryMany<{ url: string }>(
          pool,
          `SELECT u.avatar_url AS url FROM users u
           JOIN stores s ON s.id = u.store_id
           WHERE s.owner_id = $1 AND u.avatar_url IS NOT NULL`,
          [userId],
        );
        imageUrls.push(...productImages.map((r) => r.url), ...associateAvatars.map((r) => r.url));
        await withTransaction(pool, async (tx) => {
          await repo.deleteOwner(tx, userId);
        });
      } else {
        await withTransaction(pool, async (tx) => {
          await authRepo.revokeAllForUser(tx, userId);
          await repo.anonymize(tx, userId);
        });
      }
      cleanup(imageUrls);
    },

    // ------------------------------------------------------------------ komanda (sahib)

    async listAssociates(auth: AuthContext) {
      const storeId = requireStoreId(auth);
      const timezone = await storeTimezone(storeId);
      const [rows, monthTotal] = await Promise.all([
        repo.listAssociates(pool, storeId, timezone),
        sales.storeMonthTotal(pool, storeId, timezone),
      ]);
      return rows.map((row) => toAssociateDto(row, monthTotal));
    },

    async createAssociate(
      auth: AuthContext,
      body: {
        name: string;
        surname: string;
        fin: string;
        phone: string;
        email: string;
        password: string;
        locale?: Locale | undefined;
      },
    ) {
      const storeId = requireStoreId(auth);
      if (await repo.isEmailOrFinTaken(pool, { email: body.email, fin: body.fin })) {
        throw conflict('EMAIL_OR_FIN_TAKEN', TAKEN);
      }
      const passwordHash = await hashPassword(body.password);

      let id: number;
      try {
        id = await repo.insertAssociate(pool, {
          name: body.name,
          surname: body.surname,
          email: body.email,
          phone: body.phone,
          fin: body.fin,
          passwordHash,
          storeId,
          locale: body.locale ?? 'az',
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('EMAIL_OR_FIN_TAKEN', TAKEN);
        throw error;
      }
      return this.getAssociate(auth, id);
    },

    async getAssociate(auth: AuthContext, id: number) {
      const storeId = requireStoreId(auth);
      const timezone = await storeTimezone(storeId);
      const [rows, monthTotal] = await Promise.all([
        repo.listAssociates(pool, storeId, timezone),
        sales.storeMonthTotal(pool, storeId, timezone),
      ]);
      const row = rows.find((r) => r.id === id);
      if (!row) throw notFound('ASSOCIATE_NOT_FOUND', 'Sales associate not found');
      return toAssociateDto(row, monthTotal);
    },

    async updateAssociate(
      auth: AuthContext,
      id: number,
      body: {
        name?: string | undefined;
        surname?: string | undefined;
        fin?: string | undefined;
        phone?: string | undefined;
        email?: string | undefined;
        password?: string | undefined;
      },
    ) {
      const storeId = requireStoreId(auth);
      const associate = await repo.findAssociate(pool, storeId, id);
      if (!associate) throw notFound('ASSOCIATE_NOT_FOUND', 'Sales associate not found');

      const { password, ...profile } = body;
      if (
        (profile.email || profile.fin) &&
        (await repo.isEmailOrFinTaken(pool, { email: profile.email, fin: profile.fin }, id))
      ) {
        throw conflict('EMAIL_OR_FIN_TAKEN', TAKEN);
      }
      const passwordHash = password ? await hashPassword(password) : undefined;

      try {
        await withTransaction(pool, async (tx) => {
          await repo.updateUser(tx, id, profile);
          if (passwordHash) {
            await repo.setPassword(tx, id, passwordHash);
            await authRepo.revokeAllForUser(tx, id);
          }
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('EMAIL_OR_FIN_TAKEN', TAKEN);
        throw error;
      }
      return this.getAssociate(auth, id);
    },

    /** Deaktiv: giriş bağlanır və bütün cihazlar çıxarılır, amma hesab və satış tarixçəsi qalır. */
    async deactivateAssociate(auth: AuthContext, id: number) {
      const storeId = requireStoreId(auth);
      const associate = await repo.findAssociate(pool, storeId, id);
      if (!associate) throw notFound('ASSOCIATE_NOT_FOUND', 'Sales associate not found');
      await withTransaction(pool, async (tx) => {
        await repo.setActive(tx, id, false);
        await authRepo.revokeAllForUser(tx, id);
      });
      return this.getAssociate(auth, id);
    },

    async activateAssociate(auth: AuthContext, id: number) {
      const storeId = requireStoreId(auth);
      const associate = await repo.findAssociate(pool, storeId, id);
      if (!associate) throw notFound('ASSOCIATE_NOT_FOUND', 'Sales associate not found');
      await repo.setActive(pool, id, true);
      return this.getAssociate(auth, id);
    },

    /** Satıcının girişi bağlanır, satış tarixçəsində adı qalır, email və FIN təkrar istifadə oluna bilər. */
    async deleteAssociate(auth: AuthContext, id: number): Promise<void> {
      const storeId = requireStoreId(auth);
      const associate = await repo.findAssociate(pool, storeId, id);
      if (!associate) throw notFound('ASSOCIATE_NOT_FOUND', 'Sales associate not found');
      await withTransaction(pool, async (tx) => {
        await authRepo.revokeAllForUser(tx, id);
        await repo.deactivate(tx, id);
      });
    },
  };
}
