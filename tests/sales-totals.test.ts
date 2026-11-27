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

/** Mağaza vaxtı ilə (Asia/Baku) bu gündən `offset` gün əvvəlki tarix, YYYY-MM-DD. */
function day(offset = 0): string {
  const date = new Date(Date.now() - offset * 86_400_000);
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Baku' });
}

describe('sales totals', () => {
  it('sums a date range and compares with the period right before it', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 50, cost_price: 4 });

    await http.post('/sales', { product_id: p.id, quantity: 3 }, owner.token); // 30 today
    await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token); // 10 today
    const old = await http.post('/sales', { product_id: p.id, quantity: 2 }, owner.token);
    await ctx.pool.query(
      "UPDATE sales SET created_at = created_at - interval '8 days' WHERE id = $1",
      [old.body.saleId],
    ); // 20, falls in the 7 days before the last 7 days

    const res = await http.get(`/sales/totals?from=${day(6)}&to=${day(0)}`, owner.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      from: day(6),
      to: day(0),
      revenue: 40,
      orders: 2,
      average_check: 20,
      previous: { revenue: 20, orders: 1, average_check: 20 },
    });
    expect(res.body.by_seller).toHaveLength(1);
    expect(res.body.by_seller[0]).toMatchObject({ revenue: 40, orders: 2 });
  });

  it('returns zeros and a zero average for an empty range', async () => {
    const owner = await registerOwner(ctx);
    const res = await http.get(`/sales/totals?from=${day(30)}&to=${day(20)}`, owner.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      revenue: 0,
      orders: 0,
      average_check: 0,
      previous: { revenue: 0, orders: 0, average_check: 0 },
      by_seller: [],
    });
  });

  it('breaks totals down by seller and filters by seller and location', async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 50, cost_price: 4 });

    await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token); // 10
    await http.post('/sales', { product_id: p.id, quantity: 4 }, seller.token); // 40

    const all = await http.get(`/sales/totals?from=${day(0)}&to=${day(0)}`, owner.token);
    expect(all.body).toMatchObject({ revenue: 50, orders: 2, average_check: 25 });
    expect(all.body.by_seller).toHaveLength(2);
    expect(all.body.by_seller[0]).toMatchObject({ revenue: 40, orders: 1 });

    const one = await http.get(
      `/sales/totals?from=${day(0)}&to=${day(0)}&seller_id=${seller.id}`,
      owner.token,
    );
    expect(one.body).toMatchObject({ revenue: 40, orders: 1 });

    // satıcı yalnız özünü görür, seller_id göndərsə də
    const own = await http.get(
      `/sales/totals?from=${day(0)}&to=${day(0)}&seller_id=${owner.userId}`,
      seller.token,
    );
    expect(own.body).toMatchObject({ revenue: 40, orders: 1 });
    expect(own.body.by_seller).toHaveLength(1);

    const main = await http.get(`/locations`, owner.token);
    const mainId = main.body.find((l: { is_main: boolean }) => l.is_main).id;
    const atMain = await http.get(
      `/sales/totals?from=${day(0)}&to=${day(0)}&location_id=${mainId}`,
      owner.token,
    );
    expect(atMain.body).toMatchObject({ revenue: 50, orders: 2 });
    expect(
      (await http.get(`/sales/totals?from=${day(0)}&to=${day(0)}&location_id=99999`, owner.token))
        .status,
    ).toBe(404);
  });

  it('validates the range', async () => {
    const owner = await registerOwner(ctx);
    expect((await http.get('/sales/totals', owner.token)).status).toBe(400);
    expect((await http.get(`/sales/totals?from=${day(0)}&to=${day(3)}`, owner.token)).status).toBe(
      400,
    );
    expect(
      (await http.get(`/sales/totals?from=${day(500)}&to=${day(0)}`, owner.token)).status,
    ).toBe(400);
    expect((await http.get(`/sales/totals?from=abc&to=${day(0)}`, owner.token)).status).toBe(400);
    expect((await http.get(`/sales/totals?from=${day(1)}&to=${day(0)}`)).status).toBe(401);
  });
});

describe('end of day numbers', () => {
  it('counts units sold and the refunded amount', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 50 });

    const sale = await http.post('/sales', { product_id: p.id, quantity: 4 }, owner.token);
    await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token);
    await http.post(
      `/sales/${sale.body.saleId}/returns`,
      { items: [{ sale_item_id: sale.body.sale.items[0].id, quantity: 1 }] },
      owner.token,
    );

    const res = await http.get(`/sales/totals?from=${day(0)}&to=${day(0)}`, owner.token);
    expect(res.body).toMatchObject({
      revenue: 40, // 50 - 10
      orders: 2,
      items_sold: 4, // 5 satılıb, 1 qaytarılıb
      returned: 10,
    });
  });
});
