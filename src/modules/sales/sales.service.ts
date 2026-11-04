import type { AppDeps, AuthContext } from '../../app-types.js';
import { withTransaction } from '../../db/pool.js';
import { thumbnailUrlFor } from '../../infra/images.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { requireStoreId } from '../../shared/auth-helpers.js';
import { discountedPrice, formatTimestamp, roundMoney } from '../../shared/formatting.js';
import { offsetOf, toPage, type PaginationQuery } from '../../shared/schemas.js';
import * as stores from '../stores/stores.repository.js';
import * as repo from './sales.repository.js';
import type { SaleRow } from './sales.repository.js';
import type { CreateSaleInput, SaleDto } from './sales.schemas.js';
import type { Storage } from '../../infra/storage/storage.js';

export type SalesService = ReturnType<typeof createSalesService>;

export function toSaleDto(row: SaleRow, storage: Storage): SaleDto {
  const items = row.items.map((item) => ({
    ...item,
    product_image_url: item.product_image_url
      ? thumbnailUrlFor(storage, item.product_image_url)
      : null,
  }));
  // Köhnə iOS modeli düz sahələr gözləyir: onlar qəbzin ilk sətrindən götürülür.
  const first = items[0];
  return {
    id: row.id,
    receipt_no: row.receipt_no,
    product_id: first?.product_id ?? 0,
    product_name: first?.product_name ?? '',
    product_image_url: first?.product_image_url ?? null,
    quantity: first?.quantity ?? 0,
    unit_price: first?.unit_price ?? 0,
    total_price: row.total_price,
    sold_by: row.sold_by,
    seller_name: row.seller_name,
    payment_method: row.payment_method,
    created_at: formatTimestamp(row.created_at),
    items,
  };
}

export function createSalesService(deps: AppDeps) {
  const { pool, config, storage } = deps;

  async function storeTimezone(storeId: number): Promise<string> {
    const store = await stores.findStoreById(pool, storeId);
    return store?.timezone ?? config.defaultTimezone;
  }

  return {
    async create(auth: AuthContext, input: CreateSaleInput) {
      const storeId = requireStoreId(auth);

      // Eyni məhsul bir neçə dəfə göndərilibsə birləşdirilir, ID-yə görə sıralanır
      // ki, paralel satışlar bir-birini kilidləməsin (deadlock yoxdur).
      const merged = new Map<number, number>();
      for (const item of input.items) {
        merged.set(item.product_id, (merged.get(item.product_id) ?? 0) + item.quantity);
      }
      const lines = [...merged.entries()].sort(([a], [b]) => a - b);

      const saleId = await withTransaction(pool, async (tx) => {
        const items: repo.SaleItemRow[] = [];

        for (const [productId, quantity] of lines) {
          const product = await repo.decrementStock(tx, storeId, productId, quantity);
          if (!product) {
            const existing = await repo.productExists(tx, storeId, productId);
            if (!existing) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
            throw badRequest('INSUFFICIENT_STOCK', 'Insufficient stock', {
              product_id: productId,
              available: existing.quantity,
            });
          }
          const unitPrice = discountedPrice(product.price, product.discount);
          items.push({
            product_id: product.id,
            product_name: product.name,
            sku: product.sku,
            quantity,
            unit_price: unitPrice,
            line_total: roundMoney(unitPrice * quantity),
          });
        }

        const total = roundMoney(items.reduce((sum, item) => sum + item.line_total, 0));
        const receiptNo = await stores.nextReceiptNo(tx, storeId);
        const sale = await repo.insertSale(tx, {
          storeId,
          receiptNo,
          soldBy: auth.userId,
          paymentMethod: input.payment_method,
          totalPrice: total,
          note: input.note,
        });
        for (const item of items) await repo.insertSaleItem(tx, sale.id, item);
        return sale.id;
      });

      const row = await repo.findSale(pool, storeId, saleId);
      if (!row) throw new Error('Sale disappeared after insert');
      return toSaleDto(row, storage);
    },

    async list(
      auth: AuthContext,
      query: PaginationQuery & {
        seller_id?: number | undefined;
        from?: string | undefined;
        to?: string | undefined;
      },
    ) {
      const storeId = requireStoreId(auth);
      const timezone = await storeTimezone(storeId);
      // Satıcı yalnız öz satışlarını görür. Sahib isə seller_id ilə süzə bilər.
      const soldBy = auth.role === 'OWNER' ? query.seller_id : auth.userId;
      const { rows, total } = await repo.listSales(
        pool,
        storeId,
        timezone,
        { soldBy, from: query.from, to: query.to },
        { limit: query.limit, offset: offsetOf(query) },
      );
      return toPage(
        rows.map((row) => toSaleDto(row, storage)),
        total,
        query,
      );
    },

    async getById(auth: AuthContext, id: number): Promise<SaleDto> {
      const row = await repo.findSale(
        pool,
        requireStoreId(auth),
        id,
        auth.role === 'OWNER' ? undefined : auth.userId,
      );
      if (!row) throw notFound('SALE_NOT_FOUND', 'Sale not found');
      return toSaleDto(row, storage);
    },

    async summary(auth: AuthContext) {
      const storeId = requireStoreId(auth);
      const timezone = await storeTimezone(storeId);
      const row = await repo.monthSummary(
        pool,
        storeId,
        timezone,
        auth.role === 'OWNER' ? undefined : auth.userId,
      );
      return {
        today_sales: row.today_sales,
        today_orders: row.today_orders,
        total_sales: row.total_sales,
        total_orders: row.total_orders,
      };
    },
  };
}
