import type { AppDeps, AuthContext } from '../../app-types.js';
import { withTransaction } from '../../db/pool.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { requireStoreId } from '../../shared/auth-helpers.js';
import { formatTimestamp } from '../../shared/formatting.js';
import { offsetOf, toPage, type PaginationQuery } from '../../shared/schemas.js';
import * as locations from '../locations/locations.repository.js';
import * as movements from '../products/stock-movements.repository.js';
import * as products from '../products/products.repository.js';
import * as sales from '../sales/sales.repository.js';
import * as repo from './transfers.repository.js';
import type { TransferRow } from './transfers.repository.js';
import type { CreateTransferInput, TransferDto } from './transfers.schemas.js';

export type TransfersService = ReturnType<typeof createTransfersService>;

function toDto(row: TransferRow): TransferDto {
  return { ...row, created_at: formatTimestamp(row.created_at) };
}

export function createTransfersService(deps: AppDeps) {
  const { pool } = deps;

  return {
    async create(auth: AuthContext, input: CreateTransferInput): Promise<TransferDto> {
      const storeId = requireStoreId(auth);
      if (input.from_location_id === input.to_location_id) {
        throw badRequest('SAME_LOCATION', 'Choose two different locations');
      }

      // Eyni məhsul bir neçə dəfə göndərilibsə birləşdirilir, ID-yə görə sıralanır (deadlock yoxdur).
      const merged = new Map<number, number>();
      for (const item of input.items) {
        merged.set(item.product_id, (merged.get(item.product_id) ?? 0) + item.quantity);
      }
      const lines = [...merged.entries()].sort(([a], [b]) => a - b);

      const transferId = await withTransaction(pool, async (tx) => {
        const [from, to] = await Promise.all([
          locations.findLocation(tx, storeId, input.from_location_id),
          locations.findLocation(tx, storeId, input.to_location_id),
        ]);
        if (!from || !to) throw notFound('LOCATION_NOT_FOUND', 'Location not found');

        const id = await repo.insertTransfer(tx, {
          storeId,
          fromLocationId: from.id,
          toLocationId: to.id,
          createdBy: auth.userId,
          note: input.note,
        });

        for (const [productId, quantity] of lines) {
          const product = await sales.findProductForSale(tx, storeId, productId);
          if (!product) throw notFound('PRODUCT_NOT_FOUND', 'Product not found');

          // Mənbədən atomik azaldılır: kifayət qədər qalıq yoxdursa heç nə dəyişmir.
          const balanceFrom = await sales.decrementStock(tx, productId, from.id, quantity);
          if (balanceFrom === null) {
            throw badRequest('INSUFFICIENT_STOCK', 'Insufficient stock', {
              product_id: productId,
              available: await sales.stockAt(tx, productId, from.id),
            });
          }
          const balanceTo = await products.addQuantity(tx, productId, to.id, quantity);
          await movements.recordMovement(tx, {
            storeId,
            productId,
            locationId: from.id,
            type: 'transfer_out',
            change: -quantity,
            balanceAfter: balanceFrom,
            userId: auth.userId,
            transferId: id,
            relatedLocationId: to.id,
            note: input.note,
          });
          await movements.recordMovement(tx, {
            storeId,
            productId,
            locationId: to.id,
            type: 'transfer_in',
            change: quantity,
            balanceAfter: balanceTo,
            userId: auth.userId,
            transferId: id,
            relatedLocationId: from.id,
            note: input.note,
          });
          await repo.insertTransferItem(tx, id, {
            productId,
            productName: product.name,
            sku: product.sku,
            quantity,
          });
        }
        return id;
      });

      const row = await repo.findTransfer(pool, storeId, transferId);
      if (!row) throw new Error('Transfer disappeared after insert');
      return toDto(row);
    },

    async list(auth: AuthContext, query: PaginationQuery & { location_id?: number | undefined }) {
      const storeId = requireStoreId(auth);
      const { rows, total } = await repo.listTransfers(pool, storeId, query.location_id, {
        limit: query.limit,
        offset: offsetOf(query),
      });
      return toPage(rows.map(toDto), total, query);
    },

    async getById(auth: AuthContext, id: number): Promise<TransferDto> {
      const row = await repo.findTransfer(pool, requireStoreId(auth), id);
      if (!row) throw notFound('TRANSFER_NOT_FOUND', 'Transfer not found');
      return toDto(row);
    },
  };
}
