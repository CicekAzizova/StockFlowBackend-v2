import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  createAssociate,
  createContext,
  createProduct,
  registerOwner,
  type TestContext,
} from './helpers/context.js';

let ctx: TestContext;
let http: ReturnType<typeof api>;

beforeAll(async () => {
  ctx = await createContext();
  http = api(ctx.app);
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await ctx.pool.query(
    'TRUNCATE refresh_tokens, one_time_codes, sale_items, sales, products, categories, subscriptions, users, stores RESTART IDENTITY CASCADE',
  );
});

describe('sales report', () => {
  it('sums revenue and profit, and keeps unknown-cost sales out of profit', async () => {
    const owner = await registerOwner(ctx);
    const known = await createProduct(ctx, owner, { price: 10, quantity: 50, cost_price: 4 });
    const unknown = await createProduct(ctx, owner, { price: 5, quantity: 50 });

    await http.post('/sales', { product_id: known.id, quantity: 3 }, owner.token); // 30, profit 18
    await http.post('/sales', { product_id: unknown.id, quantity: 2 }, owner.token); // 10, no cost

    const res = await http.get('/reports/sales?period=week', owner.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      period: 'week',
      revenue: 40,
      profit: 18,
      orders: 2,
      items_sold: 5,
      unknown_cost_revenue: 10,
      previous: { revenue: 0, profit: 0, orders: 0, items_sold: 0 },
    });
    expect(res.body.buckets).toHaveLength(7);
    const today = res.body.buckets[6];
    expect(today).toMatchObject({ revenue: 40, profit: 18, orders: 2, items_sold: 5 });
    expect(res.body.to).toBe(today.label);
    expect(res.body.buckets[0]).toMatchObject({ revenue: 0, profit: 0, orders: 0 });
  });

  it('uses the cost at the time of sale, not the current cost', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 50, cost_price: 4 });
    await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token); // profit 6
    await http.put(
      `/products/${p.id}`,
      { name: 'Renamed', sku: p.sku, price: 10, cost_price: 9 },
      owner.token,
    );
    await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token); // profit 1

    const res = await http.get('/reports/sales?period=week', owner.token);
    expect(res.body).toMatchObject({ revenue: 20, profit: 7 });
  });

  it('compares with the previous period', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 50, cost_price: 4 });
    await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token);
    const old = await http.post('/sales', { product_id: p.id, quantity: 2 }, owner.token);
    await ctx.pool.query(
      "UPDATE sales SET created_at = created_at - interval '9 days' WHERE id = $1",
      [old.body.saleId],
    );

    const res = await http.get('/reports/sales?period=week', owner.token);
    expect(res.body).toMatchObject({
      revenue: 10,
      profit: 6,
      orders: 1,
      previous: { revenue: 20, profit: 12, orders: 1, items_sold: 2 },
    });
  });

  it('returns 30 daily buckets for a month and 12 monthly buckets for a year', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 50, cost_price: 4 });
    await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token);
    const old = await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token);
    await ctx.pool.query(
      "UPDATE sales SET created_at = created_at - interval '40 days' WHERE id = $1",
      [old.body.saleId],
    );

    const month = await http.get('/reports/sales?period=month', owner.token);
    expect(month.body.buckets).toHaveLength(30);
    expect(month.body.buckets[0].label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(month.body).toMatchObject({ revenue: 10, previous: { revenue: 10 } });

    const year = await http.get('/reports/sales?period=year', owner.token);
    expect(year.body.buckets).toHaveLength(12);
    expect(year.body.buckets[0].label).toMatch(/^\d{4}-\d{2}$/);
    expect(year.body).toMatchObject({ revenue: 20, profit: 12, orders: 2 });
    expect(year.body.to).toBe(year.body.buckets[11].label);
  });

  it('can be limited to one location', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 50, cost_price: 4 });
    const shop = (await http.post('/locations', { name: 'Second', kind: 'store' }, owner.token))
      .body;
    await http.post(`/products/${p.id}/restock`, { quantity: 20 }, owner.token);
    await http.request('POST', `/products/${p.id}/restock`, {
      token: owner.token,
      payload: { quantity: 20 },
      headers: { 'x-location-id': String(shop.id) },
    });

    await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token);
    await http.request('POST', '/sales', {
      token: owner.token,
      payload: { product_id: p.id, quantity: 2 },
      headers: { 'x-location-id': String(shop.id) },
    });

    const all = await http.get('/reports/sales?period=week', owner.token);
    expect(all.body).toMatchObject({ revenue: 30, orders: 2 });
    const second = await http.get(`/reports/sales?period=week&location_id=${shop.id}`, owner.token);
    expect(second.body).toMatchObject({ revenue: 20, profit: 12, orders: 1 });
    expect(
      (await http.get('/reports/sales?period=week&location_id=99999', owner.token)).status,
    ).toBe(404);
  });

  it('lists revenue per location, biggest first, only without a location filter', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 50, cost_price: 4 });
    const shop = (await http.post('/locations', { name: 'Second', kind: 'store' }, owner.token))
      .body;
    await http.request('POST', `/products/${p.id}/restock`, {
      token: owner.token,
      payload: { quantity: 20 },
      headers: { 'x-location-id': String(shop.id) },
    });

    await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token);
    await http.request('POST', '/sales', {
      token: owner.token,
      payload: { product_id: p.id, quantity: 2 },
      headers: { 'x-location-id': String(shop.id) },
    });

    const all = await http.get('/reports/sales?period=week', owner.token);
    expect(all.body.by_location).toHaveLength(2);
    expect(all.body.by_location[0]).toMatchObject({
      location_id: shop.id,
      name: 'Second',
      revenue: 20,
      profit: 12,
      orders: 1,
    });
    expect(all.body.by_location[1]).toMatchObject({ revenue: 10, profit: 6, orders: 1 });

    const one = await http.get(`/reports/sales?period=week&location_id=${shop.id}`, owner.token);
    expect(one.body.by_location).toEqual([]);
  });

  it('shows a calendar year and compares with the same months of the year before', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 50, cost_price: 4 });
    const thisYear = Number(
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Baku' }).slice(0, 4),
    );

    await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token);
    const old = await http.post('/sales', { product_id: p.id, quantity: 2 }, owner.token);
    await ctx.pool.query(
      "UPDATE sales SET created_at = created_at - interval '2 years' WHERE id = $1",
      [old.body.saleId],
    );

    const now = await http.get(`/reports/sales?period=year&year=${thisYear}`, owner.token);
    expect(now.status).toBe(200);
    expect(now.body.buckets).toHaveLength(12);
    expect(now.body.buckets[0].label).toBe(`${thisYear}-01`);
    expect(now.body.buckets[11].label).toBe(`${thisYear}-12`);
    expect(now.body).toMatchObject({
      first_year: thisYear - 2,
      revenue: 10,
      profit: 6,
      orders: 1,
      previous: { revenue: 0, orders: 0 },
    });
    expect(now.body.by_location).toHaveLength(1);
    expect(now.body.by_location[0]).toMatchObject({ revenue: 10, orders: 1 });

    const old2 = await http.get(`/reports/sales?period=year&year=${thisYear - 2}`, owner.token);
    expect(old2.body).toMatchObject({ revenue: 20, orders: 1, first_year: thisYear - 2 });
    expect(old2.body.by_location[0]).toMatchObject({ revenue: 20 });

    const next = await http.get(`/reports/sales?period=year&year=${thisYear - 1}`, owner.token);
    expect(next.body).toMatchObject({ revenue: 0, previous: { revenue: 20 } });

    expect((await http.get('/reports/sales?period=year&year=abc', owner.token)).status).toBe(400);
  });

  it('is owner-only and validates the period', async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner);
    expect((await http.get('/reports/sales', seller.token)).status).toBe(403);
    expect((await http.get('/reports/sales')).status).toBe(401);
    expect((await http.get('/reports/sales?period=day', owner.token)).status).toBe(400);
    expect((await http.get('/reports/sales', owner.token)).body.period).toBe('week');
  });
});
