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

const stockOf = async (id: number, token: string) =>
  (await http.get(`/products/${id}`, token)).body.quantity as number;

describe('single-product sale (legacy iOS shape)', () => {
  it('reduces stock and returns camelCase keys plus the full sale', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { price: 10, discount: 10, quantity: 5 });
    const res = await http.post('/sales', { product_id: p.id, quantity: 2 }, owner.token);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      message: 'Sale completed successfully',
      totalPrice: 18,
      receipt_no: 1,
    });
    expect(res.body.saleId).toEqual(expect.any(Number));
    expect(res.body.sale).toMatchObject({
      product_id: p.id,
      quantity: 2,
      unit_price: 9,
      total_price: 18,
      payment_method: 'cash',
    });
    expect(res.body.sale.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(await stockOf(p.id, owner.token)).toBe(3);
  });

  it('rejects overselling without touching stock', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { quantity: 1 });
    const res = await http.post('/sales', { product_id: p.id, quantity: 2 }, owner.token);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ message: 'Insufficient stock', code: 'INSUFFICIENT_STOCK' });
    expect(await stockOf(p.id, owner.token)).toBe(1);
  });

  it('validates input and unknown products', async () => {
    const owner = await registerOwner(ctx);
    expect((await http.post('/sales', {}, owner.token)).status).toBe(400);
    expect((await http.post('/sales', { product_id: 1, quantity: 0 }, owner.token)).status).toBe(
      400,
    );
    expect(
      (await http.post('/sales', { product_id: 999, quantity: 1 }, owner.token)).body.message,
    ).toBe('Product not found');
  });

  it("cannot sell another store's product", async () => {
    const a = await registerOwner(ctx);
    const b = await registerOwner(ctx);
    const p = await createProduct(ctx, a);
    expect((await http.post('/sales', { product_id: p.id, quantity: 1 }, b.token)).status).toBe(
      404,
    );
  });
});

describe('cart sale', () => {
  it('sells several products atomically with payment method and a per-store receipt number', async () => {
    const owner = await registerOwner(ctx);
    const a = await createProduct(ctx, owner, { price: 5, quantity: 10 });
    const b = await createProduct(ctx, owner, { price: 2.5, quantity: 10 });
    const first = await http.post(
      '/sales',
      {
        items: [
          { product_id: a.id, quantity: 2 },
          { product_id: b.id, quantity: 4 },
        ],
        payment_method: 'card',
      },
      owner.token,
    );
    expect(first.status).toBe(201);
    expect(first.body.totalPrice).toBe(20);
    expect(first.body.sale.items).toHaveLength(2);
    expect(first.body.sale.payment_method).toBe('card');
    const second = await http.post('/sales', { product_id: a.id, quantity: 1 }, owner.token);
    expect(second.body.receipt_no).toBe(2);

    const other = await registerOwner(ctx);
    const c = await createProduct(ctx, other);
    expect(
      (await http.post('/sales', { product_id: c.id, quantity: 1 }, other.token)).body.receipt_no,
    ).toBe(1);
  });

  it('rolls back everything if one line lacks stock', async () => {
    const owner = await registerOwner(ctx);
    const a = await createProduct(ctx, owner, { quantity: 10 });
    const b = await createProduct(ctx, owner, { quantity: 1 });
    const res = await http.post(
      '/sales',
      {
        items: [
          { product_id: a.id, quantity: 3 },
          { product_id: b.id, quantity: 5 },
        ],
      },
      owner.token,
    );
    expect(res.status).toBe(400);
    expect(await stockOf(a.id, owner.token)).toBe(10);
    expect(await stockOf(b.id, owner.token)).toBe(1);
    expect((await http.get('/sales', owner.token)).body.total).toBe(0);
  });

  it('merges duplicate lines instead of overselling', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { quantity: 3 });
    const res = await http.post(
      '/sales',
      {
        items: [
          { product_id: p.id, quantity: 2 },
          { product_id: p.id, quantity: 2 },
        ],
      },
      owner.token,
    );
    expect(res.status).toBe(400);
    expect(await stockOf(p.id, owner.token)).toBe(3);
  });
});

describe('concurrency', () => {
  it('never oversells under parallel requests', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { quantity: 5 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 400)).toHaveLength(5);
    expect(await stockOf(p.id, owner.token)).toBe(0);
    const receipts = results
      .filter((r) => r.status === 201)
      .map((r) => r.body.receipt_no)
      .sort((x, y) => x - y);
    expect(receipts).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('history and summary', () => {
  it('shows associates only their own sales; owners everything with filters', async () => {
    const owner = await registerOwner(ctx);
    const s1 = await createAssociate(ctx, owner);
    const s2 = await createAssociate(ctx, owner);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 100 });
    await http.post('/sales', { product_id: p.id, quantity: 1 }, s1.token);
    await http.post('/sales', { product_id: p.id, quantity: 2 }, s2.token);
    await http.post('/sales', { product_id: p.id, quantity: 3 }, owner.token);

    expect((await http.get('/sales', owner.token)).body.total).toBe(3);
    expect((await http.get('/sales', s1.token)).body.total).toBe(1);
    expect((await http.get(`/sales?seller_id=${s2.id}`, owner.token)).body.total).toBe(1);

    const today = new Date().toISOString().slice(0, 10);
    expect((await http.get(`/sales?from=${today}&to=${today}`, owner.token)).body.total).toBe(3);
    expect((await http.get('/sales?from=2001-01-01&to=2001-01-02', owner.token)).body.total).toBe(
      0,
    );
    expect((await http.get('/sales?from=bad', owner.token)).status).toBe(400);

    const list = (await http.get('/sales', owner.token)).body.items;
    expect(list[0].id).toBeGreaterThan(list[2].id); // ən yeni birinci

    const mine = await http.get(`/sales/${list[0].id}`, owner.token);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    const foreign = (await http.get('/sales', s2.token)).body.items[0].id;
    expect((await http.get(`/sales/${foreign}`, s1.token)).status).toBe(404);

    const summary = await http.get('/sales/summary', owner.token);
    expect(summary.body).toMatchObject({
      today_sales: 60,
      today_orders: 3,
      total_sales: 60,
      total_orders: 3,
    });
    expect((await http.get('/sales/summary', s1.token)).body).toMatchObject({
      total_sales: 10,
      total_orders: 1,
    });
  });

  it('returns zero totals for an empty month', async () => {
    const owner = await registerOwner(ctx);
    expect((await http.get('/sales/summary', owner.token)).body).toEqual({
      today_sales: 0,
      today_orders: 0,
      total_sales: 0,
      total_orders: 0,
    });
  });

  it('keeps the receipt snapshot after the product is deleted or changed', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { name: 'Old Name', price: 7, quantity: 5 });
    const sale = await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token);
    await http.put(`/products/${p.id}`, { name: 'New Name', sku: p.sku, price: 99 }, owner.token);
    await http.delete(`/products/${p.id}`, owner.token);
    const got = await http.get(`/sales/${sale.body.saleId}`, owner.token);
    expect(got.body).toMatchObject({ product_name: 'Old Name', unit_price: 7, total_price: 7 });
  });
});
