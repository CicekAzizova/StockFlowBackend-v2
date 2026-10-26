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

describe('products CRUD', () => {
  it('creates, reads, updates and soft-deletes', async () => {
    const owner = await registerOwner(ctx);
    const created = await http.post(
      '/products',
      {
        name: 'Cola',
        sku: 'COLA-1',
        price: 2.5,
        quantity: 12,
        category: 'Drinks',
        cost_price: 1.2,
        weight: 330,
        weight_unit: 'ml',
        size: 'S',
      },
      owner.token,
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Cola',
      sku: 'COLA-1',
      price: 2.5,
      quantity: 12,
      category: 'Drinks',
      cost_price: 1.2,
      weight: 330,
      weight_unit: 'ml',
      size: 'S',
      discount: 0,
    });

    const got = await http.get(`/products/${created.body.id}`, owner.token);
    expect(got.status).toBe(200);

    const updated = await http.put(
      `/products/${created.body.id}`,
      { name: 'Cola Zero', sku: 'COLA-1', price: 3, weight: null },
      owner.token,
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Cola Zero', price: 3, weight: null, quantity: 12 });

    expect((await http.delete(`/products/${created.body.id}`, owner.token)).status).toBe(200);
    expect((await http.get(`/products/${created.body.id}`, owner.token)).status).toBe(404);
    // Silinmiş məhsulun SKU-su yenidən istifadə oluna bilər.
    expect(
      (await http.post('/products', { name: 'Cola', sku: 'cola-1', price: 2 }, owner.token)).status,
    ).toBe(201);
  });

  it('keeps SKU unique per store, case-insensitively', async () => {
    const a = await registerOwner(ctx);
    const b = await registerOwner(ctx);
    await createProduct(ctx, a, { sku: 'ABC' });
    const dup = await http.post('/products', { name: 'X', sku: 'abc', price: 1 }, a.token);
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe('SKU already exists');
    expect(
      (await http.post('/products', { name: 'X', sku: 'ABC', price: 1 }, b.token)).status,
    ).toBe(201);
  });

  it('isolates stores from each other', async () => {
    const a = await registerOwner(ctx);
    const b = await registerOwner(ctx);
    const product = await createProduct(ctx, a);
    expect((await http.get(`/products/${product.id}`, b.token)).status).toBe(404);
    expect((await http.delete(`/products/${product.id}`, b.token)).status).toBe(404);
    expect((await http.get('/products', b.token)).body.total).toBe(0);
  });

  it('validates input', async () => {
    const owner = await registerOwner(ctx);
    expect(
      (await http.post('/products', { name: '', sku: 'X', price: 1 }, owner.token)).status,
    ).toBe(400);
    expect(
      (await http.post('/products', { name: 'X', sku: 'X', price: -1 }, owner.token)).status,
    ).toBe(400);
    expect(
      (await http.post('/products', { name: 'X', sku: 'X', price: 1.234 }, owner.token)).status,
    ).toBe(400);
    expect(
      (await http.post('/products', { name: 'X', sku: 'X', price: 1, quantity: 1.5 }, owner.token))
        .status,
    ).toBe(400);
    expect((await http.get('/products/abc', owner.token)).status).toBe(400);
  });

  it('is owner-only for writes, and hides cost_price from associates', async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner);
    const product = await createProduct(ctx, owner, { cost_price: 4 });

    expect(
      (await http.post('/products', { name: 'X', sku: 'X', price: 1 }, seller.token)).status,
    ).toBe(403);
    expect((await http.delete(`/products/${product.id}`, seller.token)).status).toBe(403);

    const seen = await http.get(`/products/${product.id}`, seller.token);
    expect(seen.status).toBe(200);
    expect(seen.body.cost_price).toBe(0);
    expect((await http.get('/products', seller.token)).body.items[0].cost_price).toBe(0);
    expect((await http.get(`/products/${product.id}`, owner.token)).body.cost_price).toBe(4);
  });
});

describe('listing', () => {
  it('searches name and SKU, filters category and stock, paginates', async () => {
    const owner = await registerOwner(ctx);
    await createProduct(ctx, owner, {
      name: 'Red Apple',
      sku: 'FR-1',
      category: 'Fruit',
      quantity: 20,
    });
    await createProduct(ctx, owner, {
      name: 'Green Apple',
      sku: 'FR-2',
      category: 'Fruit',
      quantity: 2,
      low_stock_limit: 5,
    });
    await createProduct(ctx, owner, { name: 'Milk', sku: 'DA-1', category: 'Dairy', quantity: 0 });

    const list = await http.get('/products', owner.token);
    expect(list.body).toMatchObject({ page: 1, limit: 20, total: 3, has_next: false });

    expect((await http.get('/products?q=apple', owner.token)).body.total).toBe(2);
    expect((await http.get('/products?q=da-1', owner.token)).body.items[0].name).toBe('Milk');
    expect((await http.get('/products?q=%25', owner.token)).body.total).toBe(0); // LIKE joker kimi işləməməli
    expect((await http.get('/products?category=Fruit', owner.token)).body.total).toBe(2);
    expect(
      (await http.get('/products?stock=out', owner.token)).body.items.map(
        (p: { name: string }) => p.name,
      ),
    ).toEqual(['Milk']);
    expect(
      (await http.get('/products?stock=low', owner.token)).body.items.map(
        (p: { name: string }) => p.name,
      ),
    ).toEqual(['Green Apple']);
    expect((await http.get('/products?stock=in', owner.token)).body.total).toBe(1);

    const page = await http.get('/products?limit=2&page=1', owner.token);
    expect(page.body).toMatchObject({ total: 3, has_next: true });
    expect(page.body.items).toHaveLength(2);
    expect((await http.get('/products?limit=500', owner.token)).status).toBe(400);
  });

  it('serves low-stock, by-sku and stock updates', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { sku: 'LOW-1', quantity: 1, low_stock_limit: 3 });
    expect((await http.get('/products/low-stock', owner.token)).body.items).toHaveLength(1);
    expect((await http.get('/products/by-sku?sku=low-1', owner.token)).body.id).toBe(p.id);
    expect((await http.get('/products/by-sku?sku=nope', owner.token)).status).toBe(404);
    const patched = await http.patch(`/products/${p.id}/stock`, { quantity: 50 }, owner.token);
    expect(patched.status).toBe(200);
    expect(patched.body.message).toBe('Stock updated successfully');
    expect((await http.get(`/products/${p.id}`, owner.token)).body.quantity).toBe(50);
    expect((await http.get('/products/low-stock', owner.token)).body.items).toHaveLength(0);
  });
});

describe('plan limit', () => {
  it('blocks new products once the free limit is reached', async () => {
    const limited = await createContext({ FREE_PRODUCT_LIMIT: '2' });
    try {
      const h = api(limited.app);
      const owner = await registerOwner(limited);
      await createProduct(limited, owner);
      await createProduct(limited, owner);
      const res = await h.post('/products', { name: 'Third', sku: 'T-3', price: 1 }, owner.token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PRODUCT_LIMIT_REACHED');
    } finally {
      await limited.close();
    }
  });
});
