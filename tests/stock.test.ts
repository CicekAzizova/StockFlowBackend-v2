import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  createAssociate,
  createContext,
  createProduct,
  registerOwner,
  type Session,
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

const at = (owner: { token: string }, locationId: number) => ({
  token: owner.token,
  headers: { 'x-location-id': String(locationId) },
});

async function addLocation(owner: Session, name: string, kind: 'store' | 'warehouse') {
  const res = await http.post('/locations', { name, kind }, owner.token);
  expect(res.status).toBe(201);
  return res.body.id as number;
}

describe('stock per location', () => {
  it('puts the quantity of a new product into the main location', async () => {
    const owner = await registerOwner(ctx);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const p = await createProduct(ctx, owner, { quantity: 10 });

    const main = (await http.get(`/products/${p.id}`, owner.token)).body;
    expect(main.quantity).toBe(10);
    expect(main.stocks).toEqual([
      expect.objectContaining({ quantity: 10 }),
      expect.objectContaining({ location_id: shop, quantity: 0 }),
    ]);

    const other = await http.request('GET', `/products/${p.id}`, at(owner, shop));
    expect(other.body.quantity).toBe(0);
  });

  it('keeps stock separate for each location when restocking and setting', async () => {
    const owner = await registerOwner(ctx);
    const warehouse = await addLocation(owner, 'Warehouse', 'warehouse');
    const p = await createProduct(ctx, owner, { quantity: 5 });

    const restock = await http.request('POST', `/products/${p.id}/restock`, {
      ...at(owner, warehouse),
      payload: { quantity: 20 },
    });
    expect(restock.status).toBe(200);
    expect(restock.body.quantity).toBe(20);

    await http.request('PATCH', `/products/${p.id}/stock`, {
      ...at(owner, warehouse),
      payload: { quantity: 7 },
    });

    const main = (await http.get(`/products/${p.id}`, owner.token)).body;
    expect(main.quantity).toBe(5);
    expect(main.stocks.map((s: { quantity: number }) => s.quantity)).toEqual([5, 7]);
  });

  it('filters the product list by the stock of the selected location', async () => {
    const owner = await registerOwner(ctx);
    const shop = await addLocation(owner, 'Second shop', 'store');
    await createProduct(ctx, owner, { quantity: 10 });

    expect((await http.get('/products?stock=in', owner.token)).body.total).toBe(1);
    const there = await http.request('GET', '/products?stock=out', at(owner, shop));
    expect(there.body.total).toBe(1);
    const low = await http.request('GET', '/products/low-stock', at(owner, shop));
    expect(low.body.total).toBe(1);
  });

  it('rejects an unknown or invalid X-Location-Id', async () => {
    const owner = await registerOwner(ctx);
    const missing = await http.request('GET', '/products', at(owner, 99999));
    expect(missing.status).toBe(404);
    const bad = await http.request('GET', '/products', {
      token: owner.token,
      headers: { 'x-location-id': 'abc' },
    });
    expect(bad.status).toBe(400);
  });
});

describe('sales per location', () => {
  it('takes the sale from the selected store and leaves the others untouched', async () => {
    const owner = await registerOwner(ctx);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const p = await createProduct(ctx, owner, { price: 10, quantity: 5 });
    await http.request('PATCH', `/products/${p.id}/stock`, {
      ...at(owner, shop),
      payload: { quantity: 3 },
    });

    const sale = await http.request('POST', '/sales', {
      ...at(owner, shop),
      payload: { product_id: p.id, quantity: 2 },
    });
    expect(sale.status).toBe(201);

    const product = (await http.get(`/products/${p.id}`, owner.token)).body;
    expect(product.stocks.map((s: { quantity: number }) => s.quantity)).toEqual([5, 1]);
  });

  it('reports insufficient stock of the selected location', async () => {
    const owner = await registerOwner(ctx);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const p = await createProduct(ctx, owner, { quantity: 50 });

    const res = await http.request('POST', '/sales', {
      ...at(owner, shop),
      payload: { product_id: p.id, quantity: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code ?? res.body.error?.code).toBe('INSUFFICIENT_STOCK');
  });

  it('does not allow selling from a warehouse', async () => {
    const owner = await registerOwner(ctx);
    const warehouse = await addLocation(owner, 'Warehouse', 'warehouse');
    const p = await createProduct(ctx, owner, { quantity: 5 });

    const res = await http.request('POST', '/sales', {
      ...at(owner, warehouse),
      payload: { product_id: p.id, quantity: 1 },
    });
    expect(res.status).toBe(400);
  });

  it('makes an associate sell from the main location, ignoring the header', async () => {
    const owner = await registerOwner(ctx);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const p = await createProduct(ctx, owner, { quantity: 5 });
    const seller = await createAssociate(ctx, owner);

    const res = await http.request('POST', '/sales', {
      ...at(seller, shop),
      payload: { product_id: p.id, quantity: 1 },
    });
    expect(res.status).toBe(201);
    const product = (await http.get(`/products/${p.id}`, owner.token)).body;
    expect(product.stocks[0].quantity).toBe(4);
  });
});

describe('deleting locations with data', () => {
  it('refuses to delete a location that still has stock, allows it once emptied', async () => {
    const owner = await registerOwner(ctx);
    const warehouse = await addLocation(owner, 'Warehouse', 'warehouse');
    const p = await createProduct(ctx, owner, { quantity: 1 });
    await http.request('PATCH', `/products/${p.id}/stock`, {
      ...at(owner, warehouse),
      payload: { quantity: 4 },
    });

    const blocked = await http.delete(`/locations/${warehouse}`, owner.token);
    expect(blocked.status).toBe(409);

    await http.request('PATCH', `/products/${p.id}/stock`, {
      ...at(owner, warehouse),
      payload: { quantity: 0 },
    });
    expect((await http.delete(`/locations/${warehouse}`, owner.token)).status).toBe(200);
  });

  it('refuses to delete a location that has sales', async () => {
    const owner = await registerOwner(ctx);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const p = await createProduct(ctx, owner, { quantity: 1 });
    await http.request('PATCH', `/products/${p.id}/stock`, {
      ...at(owner, shop),
      payload: { quantity: 2 },
    });
    await http.request('POST', '/sales', {
      ...at(owner, shop),
      payload: { product_id: p.id, quantity: 2 },
    });

    const res = await http.delete(`/locations/${shop}`, owner.token);
    expect(res.status).toBe(409);
  });
});

describe('product stats', () => {
  it('counts products by stock status at the selected location', async () => {
    const owner = await registerOwner(ctx);
    const shop = await addLocation(owner, 'Second shop', 'store');
    await createProduct(ctx, owner, { quantity: 20, low_stock_limit: 5 });
    await createProduct(ctx, owner, { quantity: 3, low_stock_limit: 5 });
    await createProduct(ctx, owner, { quantity: 0, low_stock_limit: 5 });

    expect((await http.get('/products/stats', owner.token)).body).toEqual({
      total: 3,
      in_stock: 1,
      low_stock: 1,
      out_of_stock: 1,
    });

    const other = await http.request('GET', '/products/stats', at(owner, shop));
    expect(other.body).toEqual({ total: 3, in_stock: 0, low_stock: 0, out_of_stock: 3 });
  });

  it('is available to sales associates for their own location', async () => {
    const owner = await registerOwner(ctx);
    await createProduct(ctx, owner, { quantity: 10 });
    const seller = await createAssociate(ctx, owner);
    const res = await http.get('/products/stats', seller.token);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });
});

describe('product unit and initial stocks', () => {
  it('defaults the unit to piece and stores the chosen one', async () => {
    const owner = await registerOwner(ctx);
    const plain = await createProduct(ctx, owner);
    expect((await http.get(`/products/${plain.id}`, owner.token)).body.unit).toBe('piece');

    const kg = await createProduct(ctx, owner, { unit: 'kg' });
    expect((await http.get(`/products/${kg.id}`, owner.token)).body.unit).toBe('kg');

    const bad = await http.post(
      '/products',
      { name: 'X', sku: 'BAD-UNIT', price: 1, unit: 'box' },
      owner.token,
    );
    expect(bad.status).toBe(400);
  });

  it('sets the starting stock of every location on create', async () => {
    const owner = await registerOwner(ctx);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const warehouse = await addLocation(owner, 'Warehouse', 'warehouse');
    const main = (await http.get('/locations', owner.token)).body.find(
      (l: { is_main: boolean }) => l.is_main,
    ).id as number;

    const p = await createProduct(ctx, owner, {
      quantity: undefined,
      stocks: [
        { location_id: main, quantity: 24 },
        { location_id: shop, quantity: 12 },
        { location_id: warehouse, quantity: 60 },
      ],
    });

    const res = await http.get(`/products/${p.id}`, owner.token);
    const byLocation = Object.fromEntries(
      res.body.stocks.map((s: { location_id: number; quantity: number }) => [
        s.location_id,
        s.quantity,
      ]),
    );
    expect(byLocation).toEqual({ [main]: 24, [shop]: 12, [warehouse]: 60 });
  });

  it('rejects stocks for a location of another store or a repeated location', async () => {
    const owner = await registerOwner(ctx);
    const other = await registerOwner(ctx);
    const foreign = await addLocation(other, 'Foreign shop', 'store');
    const own = await addLocation(owner, 'Own shop', 'store');

    const foreignRes = await http.post(
      '/products',
      { name: 'A', sku: 'A-1', price: 1, stocks: [{ location_id: foreign, quantity: 3 }] },
      owner.token,
    );
    expect(foreignRes.status).toBe(400);

    const repeated = await http.post(
      '/products',
      {
        name: 'B',
        sku: 'B-1',
        price: 1,
        stocks: [
          { location_id: own, quantity: 1 },
          { location_id: own, quantity: 2 },
        ],
      },
      owner.token,
    );
    expect(repeated.status).toBe(400);
  });
});
