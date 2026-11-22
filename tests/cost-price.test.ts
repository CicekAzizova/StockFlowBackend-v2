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

/** PUT bütün məcburi xanaları tələb edir (ad, barkod, qiymət). */
const edit = (
  product: { id: number; name: string; sku: string; price: number },
  extra: object,
) => ({
  name: product.name,
  sku: product.sku,
  price: product.price,
  ...extra,
});

describe('nullable cost price', () => {
  it('stores null when the cost price is not given, and keeps a real zero', async () => {
    const owner = await registerOwner(ctx);

    const unknown = await createProduct(ctx, owner, {});
    expect((await http.get(`/products/${unknown.id}`, owner.token)).body.cost_price).toBeNull();

    const free = await createProduct(ctx, owner, { cost_price: 0 });
    expect((await http.get(`/products/${free.id}`, owner.token)).body.cost_price).toBe(0);
  });

  it('clears the cost price with null and leaves it alone when omitted', async () => {
    const owner = await registerOwner(ctx);
    const product = await createProduct(ctx, owner, { cost_price: 4 });

    const untouched = await http.put(
      `/products/${product.id}`,
      edit(product, { name: 'Renamed' }),
      owner.token,
    );
    expect(untouched.status).toBe(200);
    expect(untouched.body.cost_price).toBe(4);

    const cleared = await http.put(
      `/products/${product.id}`,
      edit(product, { cost_price: null }),
      owner.token,
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.cost_price).toBeNull();

    const set = await http.put(
      `/products/${product.id}`,
      edit(product, { cost_price: 6.5 }),
      owner.token,
    );
    expect(set.body.cost_price).toBe(6.5);
  });

  it('still shows 0 to sales associates, even when the cost is unknown', async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner);
    const product = await createProduct(ctx, owner, {});
    expect((await http.get(`/products/${product.id}`, seller.token)).body.cost_price).toBe(0);
  });

  it('rejects a negative cost price', async () => {
    const owner = await registerOwner(ctx);
    const product = await createProduct(ctx, owner, { cost_price: 4 });
    const res = await http.put(
      `/products/${product.id}`,
      edit(product, { cost_price: -1 }),
      owner.token,
    );
    expect(res.status).toBe(400);
  });
});

describe('cost snapshot on sales', () => {
  it('copies the cost price into the sale item and keeps it when the cost changes later', async () => {
    const owner = await registerOwner(ctx);
    const product = await createProduct(ctx, owner, { price: 10, quantity: 20, cost_price: 4 });

    const first = await http.post('/sales', { product_id: product.id, quantity: 2 }, owner.token);
    expect(first.status).toBe(201);

    await http.put(`/products/${product.id}`, edit(product, { cost_price: 7 }), owner.token);
    const second = await http.post('/sales', { product_id: product.id, quantity: 1 }, owner.token);
    expect(second.status).toBe(201);

    await http.put(`/products/${product.id}`, edit(product, { cost_price: null }), owner.token);
    await http.post('/sales', { product_id: product.id, quantity: 1 }, owner.token);

    const { rows } = await ctx.pool.query('SELECT unit_cost FROM sale_items ORDER BY id');
    expect(rows.map((row) => (row.unit_cost === null ? null : Number(row.unit_cost)))).toEqual([
      4,
      7,
      null,
    ]);
  });
});
