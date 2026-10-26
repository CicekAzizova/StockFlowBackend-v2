import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps, AuthContext, Role } from '../../app-types.js';
import { isUniqueViolation, withTransaction } from '../../db/pool.js';
import { keysForUrl, thumbnailUrlFor } from '../../infra/images.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { requireStoreId } from '../../shared/auth-helpers.js';
import { formatTimestamp } from '../../shared/formatting.js';
import { offsetOf, toPage, type PaginationQuery } from '../../shared/schemas.js';
import * as categories from '../categories/categories.repository.js';
import * as subscriptions from '../subscriptions/subscriptions.repository.js';
import * as repo from './products.repository.js';
import type { ProductFilters, ProductRow, ProductWrite } from './products.repository.js';
import type { ProductBody, ProductDto } from './products.schemas.js';

export type ProductsService = ReturnType<typeof createProductsService>;

export function createProductsService(deps: AppDeps, log: FastifyBaseLogger) {
  const { pool, storage } = deps;

  /** Satıcı maya dəyərini görməməlidir, ona görə 0 qaytarılır. */
  function toDto(row: ProductRow, role: Role): ProductDto {
    return {
      id: row.id,
      name: row.name,
      sku: row.sku,
      category: row.category,
      description: row.description,
      price: row.price,
      discount: row.discount,
      cost_price: role === 'OWNER' ? row.cost_price : 0,
      quantity: row.quantity,
      low_stock_limit: row.low_stock_limit,
      image_url: row.image_urls[0] ?? null,
      image_urls: row.image_urls,
      thumbnail_urls: row.image_urls.map((url) => thumbnailUrlFor(storage, url)),
      weight: row.weight,
      weight_unit: row.weight_unit,
      size: row.size,
      created_at: formatTimestamp(row.created_at),
      updated_at: formatTimestamp(row.updated_at),
    };
  }

  /** Yalnız bizim saxlamaya yüklənmiş şəkillərə icazə verilir. */
  function assertOwnImages(urls: string[] | undefined): void {
    if (urls?.some((url) => storage.keyFromUrl(url) === null)) {
      throw badRequest(
        'INVALID_IMAGE_URL',
        'Image URLs must come from the StockFlow upload endpoint',
      );
    }
  }

  async function categoryIdFor(
    db: Parameters<typeof categories.upsertByName>[0],
    storeId: number,
    name: string | undefined,
  ): Promise<number | null | undefined> {
    if (name === undefined) return undefined;
    return name === '' ? null : categories.upsertByName(db, storeId, name);
  }

  async function page(auth: AuthContext, query: PaginationQuery, filters: ProductFilters) {
    const storeId = requireStoreId(auth);
    const { rows, total } = await repo.listProducts(pool, storeId, filters, {
      limit: query.limit,
      offset: offsetOf(query),
    });
    return toPage(
      rows.map((row) => toDto(row, auth.role)),
      total,
      query,
    );
  }

  return {
    list: (auth: AuthContext, query: PaginationQuery & ProductFilters) =>
      page(auth, query, { q: query.q, category: query.category, stock: query.stock }),

    lowStock: (auth: AuthContext, query: PaginationQuery) =>
      page(auth, query, { lowStockOnly: true }),

    async getById(auth: AuthContext, id: number): Promise<ProductDto> {
      const row = await repo.findProductById(pool, requireStoreId(auth), id);
      if (!row) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
      return toDto(row, auth.role);
    },

    async getBySku(auth: AuthContext, sku: string): Promise<ProductDto> {
      const row = await repo.findProductBySku(pool, requireStoreId(auth), sku);
      if (!row) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
      return toDto(row, auth.role);
    },

    async create(auth: AuthContext, body: ProductBody): Promise<ProductDto> {
      const storeId = requireStoreId(auth);
      assertOwnImages(body.image_urls);

      try {
        return await withTransaction(pool, async (tx) => {
          // Eyni sahibin paralel sorğuları plan limitini aşmasın deyə növbəyə qoyulur.
          await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`products:${auth.userId}`]);

          const limit = await subscriptions.getProductLimit(tx, auth.userId);
          if (limit !== null && (await repo.countActiveProductsOfOwner(tx, auth.userId)) >= limit) {
            throw forbidden('PRODUCT_LIMIT_REACHED', `Your plan allows up to ${limit} products`, {
              limit,
            });
          }

          const id = await repo.insertProduct(tx, storeId, auth.userId, {
            name: body.name,
            sku: body.sku,
            category_id: (await categoryIdFor(tx, storeId, body.category)) ?? null,
            description: body.description ?? '',
            price: body.price,
            discount: body.discount ?? 0,
            cost_price: body.cost_price ?? 0,
            quantity: body.quantity ?? 0,
            low_stock_limit: body.low_stock_limit ?? 5,
            image_urls: body.image_urls ?? [],
            weight: body.weight ?? null,
            weight_unit: body.weight_unit ?? null,
            size: body.size ?? null,
          });
          const row = await repo.findProductById(tx, storeId, id);
          if (!row) throw new Error('Product disappeared after insert');
          return toDto(row, auth.role);
        });
      } catch (error) {
        if (isUniqueViolation(error, 'products_store_sku_uq')) {
          throw conflict('SKU_ALREADY_EXISTS', 'SKU already exists');
        }
        throw error;
      }
    },

    async update(auth: AuthContext, id: number, body: ProductBody): Promise<ProductDto> {
      const storeId = requireStoreId(auth);
      assertOwnImages(body.image_urls);

      let removedImages: string[] = [];
      try {
        const dto = await withTransaction(pool, async (tx) => {
          const existing = await repo.findProductById(tx, storeId, id);
          if (!existing) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');

          const fields: Partial<ProductWrite> = {
            name: body.name,
            sku: body.sku,
            price: body.price,
            description: body.description,
            discount: body.discount,
            cost_price: body.cost_price,
            quantity: body.quantity,
            low_stock_limit: body.low_stock_limit,
            image_urls: body.image_urls,
            weight: body.weight,
            weight_unit: body.weight_unit,
            size: body.size,
          };
          const categoryId = await categoryIdFor(tx, storeId, body.category);
          if (categoryId !== undefined) fields.category_id = categoryId;

          await repo.updateProduct(tx, storeId, id, fields);
          if (body.image_urls) {
            removedImages = existing.image_urls.filter((url) => !body.image_urls?.includes(url));
          }
          const row = await repo.findProductById(tx, storeId, id);
          if (!row) throw new Error('Product disappeared after update');
          return toDto(row, auth.role);
        });

        // Siyahıdan çıxarılan şəkillər saxlamadan silinir (xəta olsa yalnız loga yazılır).
        const keys = removedImages.flatMap((url) => keysForUrl(storage, url));
        if (keys.length > 0) {
          storage
            .delete(keys)
            .catch((error: unknown) => log.warn({ err: error }, 'Image cleanup failed'));
        }
        return dto;
      } catch (error) {
        if (isUniqueViolation(error, 'products_store_sku_uq')) {
          throw conflict('SKU_ALREADY_EXISTS', 'SKU already exists');
        }
        throw error;
      }
    },

    async remove(auth: AuthContext, id: number): Promise<void> {
      const deleted = await repo.softDeleteProduct(pool, requireStoreId(auth), id);
      if (!deleted) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
    },

    async setStock(auth: AuthContext, id: number, quantity: number): Promise<void> {
      const updated = await repo.setQuantity(pool, requireStoreId(auth), id, quantity);
      if (!updated) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
    },
  };
}
