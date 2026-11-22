import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps, AuthContext, Role } from '../../app-types.js';
import { isUniqueViolation, withTransaction, type Queryable } from '../../db/pool.js';
import { keysForUrl, thumbnailUrlFor } from '../../infra/images.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { requireStoreId } from '../../shared/auth-helpers.js';
import { resolveLocation } from '../../shared/location-context.js';
import { formatTimestamp } from '../../shared/formatting.js';
import { offsetOf, toPage, type PaginationQuery } from '../../shared/schemas.js';
import * as categories from '../categories/categories.repository.js';
import * as locationsRepo from '../locations/locations.repository.js';
import * as stores from '../stores/stores.repository.js';
import * as subscriptions from '../subscriptions/subscriptions.repository.js';
import { isAllowedSubcategory } from '../stores/store-subcategories.js';
import * as movements from './stock-movements.repository.js';
import * as repo from './products.repository.js';
import type { ProductFilters, ProductRow, ProductWrite } from './products.repository.js';
import type { ProductBody, ProductDto, StockMovementDto } from './products.schemas.js';

type Header = string | string[] | undefined;

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
      stocks: row.stocks,
      low_stock_limit: row.low_stock_limit,
      image_url: row.image_urls[0] ?? null,
      image_urls: row.image_urls,
      thumbnail_urls: row.image_urls.map((url) => thumbnailUrlFor(storage, url)),
      weight: row.weight,
      weight_unit: row.weight_unit,
      size: row.size,
      unit: row.unit,
      for_sale: row.for_sale,
      subcategory: row.subcategory,
      sold_this_month: row.sold_this_month,
      created_at: formatTimestamp(row.created_at),
      updated_at: formatTimestamp(row.updated_at),
    };
  }

  /** Başlanğıc qalıq yalnız bu mağazanın məkanlarına yazıla bilər, təkrar məkan olmaz. */
  async function assertLocationsBelongToStore(
    db: Queryable,
    storeId: number,
    stocks: { location_id: number }[],
  ): Promise<void> {
    const ids = [...new Set(stocks.map((s) => s.location_id))];
    if (ids.length !== stocks.length) {
      throw badRequest('DUPLICATE_LOCATION', 'Each location can appear only once');
    }
    const rows = await locationsRepo.listLocations(db, storeId);
    const own = new Set(rows.map((l) => l.id));
    if (ids.some((id) => !own.has(id))) {
      throw badRequest('LOCATION_NOT_FOUND', 'Location not found');
    }
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

  /** Alt kateqoriya mağazanın seçdiyi əsas kateqoriyalardan birinə aid olmalıdır. */
  async function assertSubcategory(
    db: Parameters<typeof stores.findStoreById>[0],
    storeId: number,
    subcategory: string | null | undefined,
  ): Promise<void> {
    if (subcategory === undefined || subcategory === null) return;
    const store = await stores.findStoreById(db, storeId);
    if (
      !store ||
      !isAllowedSubcategory(subcategory, store.main_categories, store.custom_subcategories)
    ) {
      throw badRequest(
        'INVALID_SUBCATEGORY',
        'Subcategory does not belong to the categories of this store',
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

  async function page(
    auth: AuthContext,
    header: Header,
    query: PaginationQuery,
    filters: ProductFilters,
  ) {
    const storeId = requireStoreId(auth);
    const location = await resolveLocation(pool, auth, storeId, header);
    const { rows, total } = await repo.listProducts(pool, storeId, location.id, filters, {
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
    list: (auth: AuthContext, header: Header, query: PaginationQuery & ProductFilters) =>
      page(auth, header, query, { q: query.q, category: query.category, stock: query.stock }),

    lowStock: (auth: AuthContext, header: Header, query: PaginationQuery) =>
      page(auth, header, query, { lowStockOnly: true }),

    async stats(auth: AuthContext, header: Header) {
      const storeId = requireStoreId(auth);
      const location = await resolveLocation(pool, auth, storeId, header);
      return repo.countByStock(pool, storeId, location.id);
    },

    async getById(auth: AuthContext, header: Header, id: number): Promise<ProductDto> {
      const storeId = requireStoreId(auth);
      const location = await resolveLocation(pool, auth, storeId, header);
      const row = await repo.findProductById(pool, storeId, location.id, id);
      if (!row) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
      return toDto(row, auth.role);
    },

    async getBySku(auth: AuthContext, header: Header, sku: string): Promise<ProductDto> {
      const storeId = requireStoreId(auth);
      const location = await resolveLocation(pool, auth, storeId, header);
      const row = await repo.findProductBySku(pool, storeId, location.id, sku);
      if (!row) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
      return toDto(row, auth.role);
    },

    async create(auth: AuthContext, header: Header, body: ProductBody): Promise<ProductDto> {
      const storeId = requireStoreId(auth);
      assertOwnImages(body.image_urls);
      const location = await resolveLocation(pool, auth, storeId, header);

      try {
        return await withTransaction(pool, async (tx) => {
          // Eyni sahibin paralel sorğuları plan limitini aşmasın deyə növbəyə qoyulur.
          await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`products:${auth.userId}`]);

          await assertSubcategory(tx, storeId, body.subcategory);

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
            cost_price: body.cost_price ?? null,
            low_stock_limit: body.low_stock_limit ?? 5,
            image_urls: body.image_urls ?? [],
            weight: body.weight ?? null,
            weight_unit: body.weight_unit ?? null,
            size: body.size ?? null,
            subcategory: body.subcategory ?? null,
            unit: body.unit ?? 'piece',
          });
          const startingStocks = body.stocks ?? [
            { location_id: location.id, quantity: body.quantity ?? 0 },
          ];
          if (body.stocks) await assertLocationsBelongToStore(tx, storeId, body.stocks);
          for (const stock of startingStocks) {
            if (stock.quantity <= 0) continue;
            const { balance } = await repo.setQuantity(tx, id, stock.location_id, stock.quantity);
            await movements.recordMovement(tx, {
              storeId,
              productId: id,
              locationId: stock.location_id,
              type: 'initial',
              change: stock.quantity,
              balanceAfter: balance,
              userId: auth.userId,
            });
          }
          const row = await repo.findProductById(tx, storeId, location.id, id);
          if (!row) throw new Error('Product disappeared after insert');
          return toDto(row, auth.role);
        });
      } catch (error) {
        if (isUniqueViolation(error, 'products_store_sku_uq')) {
          throw conflict('SKU_ALREADY_EXISTS', 'Barcode already exists');
        }
        throw error;
      }
    },

    async update(
      auth: AuthContext,
      header: Header,
      id: number,
      body: ProductBody,
    ): Promise<ProductDto> {
      const storeId = requireStoreId(auth);
      assertOwnImages(body.image_urls);
      const location = await resolveLocation(pool, auth, storeId, header);

      let removedImages: string[] = [];
      try {
        const dto = await withTransaction(pool, async (tx) => {
          const existing = await repo.findProductById(tx, storeId, location.id, id);
          if (!existing) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');

          // Dəyişməyibsə yoxlanmır: sahib mağaza kateqoriyalarını sonradan dəyişsə də köhnə məhsul redaktə oluna bilsin.
          if (body.subcategory !== undefined && body.subcategory !== existing.subcategory) {
            await assertSubcategory(tx, storeId, body.subcategory);
          }

          const fields: Partial<ProductWrite> = {
            name: body.name,
            sku: body.sku,
            price: body.price,
            description: body.description,
            discount: body.discount,
            cost_price: body.cost_price,
            low_stock_limit: body.low_stock_limit,
            image_urls: body.image_urls,
            weight: body.weight,
            weight_unit: body.weight_unit,
            size: body.size,
            unit: body.unit,
            subcategory: body.subcategory,
          };
          const categoryId = await categoryIdFor(tx, storeId, body.category);
          if (categoryId !== undefined) fields.category_id = categoryId;

          await repo.updateProduct(tx, storeId, id, fields);
          if (body.quantity !== undefined) {
            const { previous, balance } = await repo.setQuantity(
              tx,
              id,
              location.id,
              body.quantity,
            );
            await movements.recordMovement(tx, {
              storeId,
              productId: id,
              locationId: location.id,
              type: 'adjustment',
              change: balance - previous,
              balanceAfter: balance,
              userId: auth.userId,
            });
          }
          if (body.image_urls) {
            removedImages = existing.image_urls.filter((url) => !body.image_urls?.includes(url));
          }
          const row = await repo.findProductById(tx, storeId, location.id, id);
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
          throw conflict('SKU_ALREADY_EXISTS', 'Barcode already exists');
        }
        throw error;
      }
    },

    async setForSale(
      auth: AuthContext,
      header: Header,
      id: number,
      forSale: boolean,
    ): Promise<ProductDto> {
      const storeId = requireStoreId(auth);
      const location = await resolveLocation(pool, auth, storeId, header);
      if ((await repo.setForSale(pool, storeId, id, forSale)) === 0) {
        throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
      }
      const row = await repo.findProductById(pool, storeId, location.id, id);
      if (!row) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
      return toDto(row, auth.role);
    },

    async remove(auth: AuthContext, id: number): Promise<void> {
      const deleted = await repo.softDeleteProduct(pool, requireStoreId(auth), id);
      if (!deleted) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
    },

    async restock(
      auth: AuthContext,
      header: Header,
      id: number,
      amount: number,
      note?: string,
    ): Promise<ProductDto> {
      const storeId = requireStoreId(auth);
      const location = await resolveLocation(pool, auth, storeId, header);
      if (!(await repo.productIsActive(pool, storeId, id))) {
        throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
      }
      await withTransaction(pool, async (tx) => {
        const balance = await repo.addQuantity(tx, id, location.id, amount);
        await movements.recordMovement(tx, {
          storeId,
          productId: id,
          locationId: location.id,
          type: 'restock',
          change: amount,
          balanceAfter: balance,
          userId: auth.userId,
          note,
        });
      });
      const row = await repo.findProductById(pool, storeId, location.id, id);
      if (!row) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
      return toDto(row, auth.role);
    },

    async setStock(
      auth: AuthContext,
      header: Header,
      id: number,
      quantity: number,
      note?: string,
    ): Promise<void> {
      const storeId = requireStoreId(auth);
      const location = await resolveLocation(pool, auth, storeId, header);
      if (!(await repo.productIsActive(pool, storeId, id))) {
        throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
      }
      await withTransaction(pool, async (tx) => {
        const { previous, balance } = await repo.setQuantity(tx, id, location.id, quantity);
        await movements.recordMovement(tx, {
          storeId,
          productId: id,
          locationId: location.id,
          type: 'adjustment',
          change: balance - previous,
          balanceAfter: balance,
          userId: auth.userId,
          note,
        });
      });
    },

    async history(
      auth: AuthContext,
      id: number,
      query: PaginationQuery & { location_id?: number | undefined },
    ) {
      const storeId = requireStoreId(auth);
      if (!(await repo.productIsActive(pool, storeId, id))) {
        throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
      }
      const { rows, total } = await movements.listMovements(pool, storeId, id, query.location_id, {
        limit: query.limit,
        offset: offsetOf(query),
      });
      const items: StockMovementDto[] = rows.map((row) => ({
        ...row,
        created_at: formatTimestamp(row.created_at),
      }));
      return toPage(items, total, query);
    },
  };
}
