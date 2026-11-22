import type { AppDeps, AuthContext } from '../../app-types.js';
import { requireStoreId } from '../../shared/auth-helpers.js';
import { notFound } from '../../shared/errors.js';
import { roundMoney } from '../../shared/formatting.js';
import * as locations from '../locations/locations.repository.js';
import * as stores from '../stores/stores.repository.js';
import * as repo from './reports.repository.js';
import type { BucketRow, Granularity } from './reports.repository.js';
import type { SalesReportQuery } from './reports.schemas.js';

/** Hər dövr üçün bölgü: həftə = son 7 gün, ay = son 30 gün, il = son 12 ay. */
const PERIODS: Record<SalesReportQuery['period'], { granularity: Granularity; count: number }> = {
  week: { granularity: 'day', count: 7 },
  month: { granularity: 'day', count: 30 },
  year: { granularity: 'month', count: 12 },
};

function sum(rows: BucketRow[]) {
  return {
    revenue: roundMoney(rows.reduce((total, row) => total + row.revenue, 0)),
    profit: roundMoney(rows.reduce((total, row) => total + row.profit, 0)),
    orders: rows.reduce((total, row) => total + row.orders, 0),
    items_sold: rows.reduce((total, row) => total + row.items_sold, 0),
  };
}

export function createReportsService(deps: AppDeps) {
  const { pool, config } = deps;

  return {
    async sales(auth: AuthContext, query: SalesReportQuery) {
      const storeId = requireStoreId(auth);
      const store = await stores.findStoreById(pool, storeId);
      const timezone = store?.timezone ?? config.defaultTimezone;

      if (query.location_id !== undefined) {
        const found = await locations.findLocation(pool, storeId, query.location_id);
        if (!found) throw notFound('LOCATION_NOT_FOUND', 'Location not found');
      }

      const { granularity, count } = PERIODS[query.period];
      const base = { storeId, timezone, granularity, count, locationId: query.location_id };
      const [current, previous, byLocation] = await Promise.all([
        repo.salesBuckets(pool, { ...base, window: 0 }),
        repo.salesBuckets(pool, { ...base, window: 1 }),
        query.location_id === undefined
          ? repo.salesByLocation(pool, { storeId, timezone, granularity, count })
          : Promise.resolve([]),
      ]);

      return {
        period: query.period,
        from: current[0]?.label ?? '',
        to: current[current.length - 1]?.label ?? '',
        ...sum(current),
        unknown_cost_revenue: roundMoney(
          current.reduce((total, row) => total + row.unknown_cost_revenue, 0),
        ),
        previous: sum(previous),
        by_location: byLocation.map((row) => ({
          location_id: Number(row.location_id),
          name: row.name,
          revenue: roundMoney(row.revenue),
          profit: roundMoney(row.profit),
          orders: row.orders,
        })),
        buckets: current.map((row) => ({
          label: row.label,
          revenue: roundMoney(row.revenue),
          profit: roundMoney(row.profit),
          orders: row.orders,
          items_sold: row.items_sold,
        })),
      };
    },
  };
}
