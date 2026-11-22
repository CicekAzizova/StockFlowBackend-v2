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

function toBucket(row: BucketRow) {
  return {
    label: row.label,
    revenue: roundMoney(row.revenue),
    profit: roundMoney(row.profit),
    orders: row.orders,
    items_sold: row.items_sold,
  };
}

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

  /**
   * Bir təqvim ili: yanvar-dekabr. Müqayisə keçən ilin eyni aylarıdır
   * (cari ildə yanvardan bu aya qədər, keçmiş ildə bütün 12 ay).
   */
  async function calendarYear(
    storeId: number,
    timezone: string,
    year: number,
    locationId: number | undefined,
  ) {
    const [years, current, previousYear, byLocation] = await Promise.all([
      repo.reportYears(pool, { storeId, timezone, locationId }),
      repo.salesBucketsForYear(pool, { storeId, timezone, year, locationId }),
      repo.salesBucketsForYear(pool, { storeId, timezone, year: year - 1, locationId }),
      locationId === undefined
        ? repo.salesByLocationForYear(pool, { storeId, timezone, year })
        : Promise.resolve([]),
    ]);
    const months = year === years.current_year ? years.current_month : 12;

    return {
      period: 'year' as const,
      first_year: Math.min(years.first_year, years.current_year),
      from: current[0]?.label ?? '',
      to: current[current.length - 1]?.label ?? '',
      ...sum(current),
      unknown_cost_revenue: roundMoney(
        current.reduce((total, row) => total + row.unknown_cost_revenue, 0),
      ),
      previous: sum(previousYear.slice(0, months)),
      by_location: byLocation.map((row) => ({
        location_id: Number(row.location_id),
        name: row.name,
        revenue: roundMoney(row.revenue),
        profit: roundMoney(row.profit),
        orders: row.orders,
      })),
      buckets: current.map(toBucket),
    };
  }

  return {
    async sales(auth: AuthContext, query: SalesReportQuery) {
      const storeId = requireStoreId(auth);
      const store = await stores.findStoreById(pool, storeId);
      const timezone = store?.timezone ?? config.defaultTimezone;

      if (query.location_id !== undefined) {
        const found = await locations.findLocation(pool, storeId, query.location_id);
        if (!found) throw notFound('LOCATION_NOT_FOUND', 'Location not found');
      }

      if (query.period === 'year' && query.year !== undefined) {
        return calendarYear(storeId, timezone, query.year, query.location_id);
      }

      const { granularity, count } = PERIODS[query.period];
      const base = { storeId, timezone, granularity, count, locationId: query.location_id };
      const [current, previous, byLocation, years] = await Promise.all([
        repo.salesBuckets(pool, { ...base, window: 0 }),
        repo.salesBuckets(pool, { ...base, window: 1 }),
        query.location_id === undefined
          ? repo.salesByLocation(pool, { storeId, timezone, granularity, count })
          : Promise.resolve([]),
        repo.reportYears(pool, { storeId, timezone, locationId: query.location_id }),
      ]);

      return {
        period: query.period,
        first_year: Math.min(years.first_year, years.current_year),
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
        buckets: current.map(toBucket),
      };
    },
  };
}
