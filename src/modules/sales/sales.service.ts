import type { AppDeps, AuthContext } from '../../app-types.js';
import { withTransaction } from '../../db/pool.js';
import { thumbnailUrlFor } from '../../infra/images.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { requireStoreId } from '../../shared/auth-helpers.js';
import { resolveLocation } from '../../shared/location-context.js';
import { discountedPrice, formatTimestamp, roundMoney } from '../../shared/formatting.js';
import { offsetOf, toPage, type PaginationQuery } from '../../shared/schemas.js';
import * as movements from '../products/stock-movements.repository.js';
import * as locations from '../locations/locations.repository.js';
import * as stores from '../stores/stores.repository.js';
import * as repo from './sales.repository.js';
import type { SaleRow } from './sales.repository.js';
import type { CreateSaleInput, SaleDto } from './sales.schemas.js';
import type { Storage } from '../../infra/storage/storage.js';

const DAY_MS = 86_400_000;
/** Bir sorğuda ən çox gün (təxminən 13 ay). */
const MAX_RANGE_DAYS = 400;

function parseDay(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function withAverage(row: { revenue: number; orders: number }) {
  return {
    revenue: roundMoney(row.revenue),
    orders: row.orders,
    average_check: row.orders > 0 ? roundMoney(row.revenue / row.orders) : 0,
  };
}

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
    discount: row.discount_amount,
    sold_by: row.sold_by,
    seller_name: row.seller_name,
    seller_avatar_url: row.seller_avatar_url
      ? thumbnailUrlFor(storage, row.seller_avatar_url)
      : null,
    location_id: row.location_id,
    location_name: row.location_name,
    payment_method: row.payment_method,
    created_at: formatTimestamp(row.created_at),
    items,
  };
}

/**
 * Kassirin endirimini sətirlərə mütənasib paylayır (line_total azalır, unit_price qalır).
 * Beləliklə sətirlərin cəmi həmişə yekun məbləğə bərabərdir və hesabatlar düz çıxır.
 * Son sətir yuvarlaqlaşdırma qalığını götürür.
 */
function applyDiscount(items: repo.SaleItemRow[], subtotal: number, discount: number): void {
  if (discount <= 0 || subtotal <= 0) return;
  let remaining = discount;
  items.forEach((item, index) => {
    const isLast = index === items.length - 1;
    const share = isLast
      ? remaining
      : Math.min(item.line_total, roundMoney((discount * item.line_total) / subtotal));
    const applied = Math.min(item.line_total, roundMoney(share));
    item.line_total = roundMoney(item.line_total - applied);
    remaining = roundMoney(remaining - applied);
  });
}

export function createSalesService(deps: AppDeps) {
  const { pool, config, storage } = deps;

  async function storeTimezone(storeId: number): Promise<string> {
    const store = await stores.findStoreById(pool, storeId);
    return store?.timezone ?? config.defaultTimezone;
  }

  return {
    async create(auth: AuthContext, header: string | string[] | undefined, input: CreateSaleInput) {
      const storeId = requireStoreId(auth);
      const location = await resolveLocation(pool, auth, storeId, header);
      if (location.kind !== 'store') {
        throw badRequest('SALE_NOT_ALLOWED_AT_WAREHOUSE', 'Sales can only be made at a store');
      }

      // Eyni məhsul bir neçə dəfə göndərilibsə birləşdirilir, ID-yə görə sıralanır
      // ki, paralel satışlar bir-birini kilidləməsin (deadlock yoxdur).
      const merged = new Map<number, number>();
      for (const item of input.items) {
        merged.set(item.product_id, (merged.get(item.product_id) ?? 0) + item.quantity);
      }
      const lines = [...merged.entries()].sort(([a], [b]) => a - b);

      const saleId = await withTransaction(pool, async (tx) => {
        const items: repo.SaleItemRow[] = [];
        const balances = new Map<number, number>();

        for (const [productId, quantity] of lines) {
          const product = await repo.findProductForSale(tx, storeId, productId);
          if (!product) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');
          if (!product.for_sale) {
            throw badRequest('PRODUCT_NOT_FOR_SALE', 'This product is not for sale', {
              product_id: productId,
            });
          }
          const balance = await repo.decrementStock(tx, productId, location.id, quantity);
          if (balance === null) {
            throw badRequest('INSUFFICIENT_STOCK', 'Insufficient stock', {
              product_id: productId,
              available: await repo.stockAt(tx, productId, location.id),
            });
          }
          balances.set(productId, balance);
          const unitPrice = discountedPrice(product.price, product.discount);
          items.push({
            product_id: product.id,
            product_name: product.name,
            sku: product.sku,
            quantity,
            unit_price: unitPrice,
            line_total: roundMoney(unitPrice * quantity),
            unit_cost: product.cost_price,
          });
        }

        const subtotal = roundMoney(items.reduce((sum, item) => sum + item.line_total, 0));
        if (roundMoney(input.discount) > subtotal) {
          throw badRequest('INVALID_DISCOUNT', 'Discount cannot exceed the sale total', {
            subtotal,
          });
        }
        applyDiscount(items, subtotal, roundMoney(input.discount));
        // Yekun sətirlərin cəmindən götürülür: yuvarlaqlaşdırma 1 qəpik fərq yaratsa belə tutarlı qalır.
        const total = roundMoney(items.reduce((sum, item) => sum + item.line_total, 0));
        const discount = roundMoney(subtotal - total);
        const receiptNo = await stores.nextReceiptNo(tx, storeId);
        const sale = await repo.insertSale(tx, {
          storeId,
          locationId: location.id,
          receiptNo,
          soldBy: auth.userId,
          paymentMethod: input.payment_method,
          totalPrice: total,
          discountAmount: discount,
          note: input.note,
        });
        for (const item of items) {
          await repo.insertSaleItem(tx, sale.id, item);
          await movements.recordMovement(tx, {
            storeId,
            productId: item.product_id,
            locationId: location.id,
            type: 'sale',
            change: -item.quantity,
            balanceAfter: balances.get(item.product_id) ?? 0,
            userId: auth.userId,
            saleId: sale.id,
          });
        }
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

    /** Son N günün gündəlik satışları. Sahib bütün mağazanı, satıcı yalnız özünü görür. */
    async daily(auth: AuthContext, days: number) {
      const storeId = requireStoreId(auth);
      const timezone = await storeTimezone(storeId);
      const rows = await repo.dailySales(
        pool,
        storeId,
        timezone,
        days,
        auth.role === 'OWNER' ? undefined : auth.userId,
      );
      return {
        days: rows,
        total: roundMoney(rows.reduce((sum, row) => sum + row.total, 0)),
        orders: rows.reduce((sum, row) => sum + row.orders, 0),
      };
    },

    /**
     * Seçilmiş tarix aralığının cəmi və ondan dərhal əvvəlki eyni uzunluqlu dövrlə müqayisə.
     * Sahib bütün mağazanı (və ya seller_id / location_id ilə süzülmüş) görür, satıcı yalnız özünü.
     */
    async totals(
      auth: AuthContext,
      query: {
        from: string;
        to: string;
        seller_id?: number | undefined;
        location_id?: number | undefined;
      },
    ) {
      const storeId = requireStoreId(auth);
      const timezone = await storeTimezone(storeId);

      const fromMs = parseDay(query.from);
      const days = Math.round((parseDay(query.to) - fromMs) / DAY_MS) + 1;
      if (days < 1) throw badRequest('INVALID_RANGE', 'to must not be before from');
      if (days > MAX_RANGE_DAYS) {
        throw badRequest('RANGE_TOO_LONG', `The range can be at most ${MAX_RANGE_DAYS} days`);
      }

      if (query.location_id !== undefined) {
        const found = await locations.findLocation(pool, storeId, query.location_id);
        if (!found) throw notFound('LOCATION_NOT_FOUND', 'Location not found');
      }

      const filters = {
        soldBy: auth.role === 'OWNER' ? query.seller_id : auth.userId,
        locationId: query.location_id,
      };
      const current = { from: query.from, to: query.to };
      const previous = { from: formatDay(fromMs - days * DAY_MS), to: formatDay(fromMs - DAY_MS) };

      const [now, before, sellers] = await Promise.all([
        repo.salesTotals(pool, storeId, timezone, current, filters),
        repo.salesTotals(pool, storeId, timezone, previous, filters),
        repo.salesBySeller(pool, storeId, timezone, current, filters),
      ]);

      return {
        from: query.from,
        to: query.to,
        ...withAverage(now),
        previous: withAverage(before),
        by_seller: sellers.map((row) => ({
          seller_id: Number(row.seller_id),
          seller_name: row.seller_name,
          revenue: roundMoney(row.revenue),
          orders: row.orders,
        })),
      };
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
