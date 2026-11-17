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

async function addLocation(owner: Session, name: string, kind: 'store' | 'warehouse') {
  const res = await http.post('/locations', { name, kind }, owner.token);
  expect(res.status).toBe(201);
  return res.body.id as number;
}

async function mainId(owner: Session) {
  return (await http.get('/locations', owner.token)).body[0].id as number;
}

const stocks = async (owner: Session, productId: number) =>
  (await http.get(`/products/${productId}`, owner.token)).body.stocks.map(
    (s: { quantity: number }) => s.quantity,
  ) as number[];

describe('stock transfers', () => {
  it('moves stock from the main store to a warehouse and keeps a history', async () => {
    const owner = await registerOwner(ctx);
    const main = await mainId(owner);
    const warehouse = await addLocation(owner, 'Warehouse', 'warehouse');
    const p = await createProduct(ctx, owner, { quantity: 10 });

    const res = await http.post(
      '/transfers',
      {
        from_location_id: main,
        to_location_id: warehouse,
        items: [{ product_id: p.id, quantity: 4 }],
        note: 'Seasonal stock',
      },
      owner.token,
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      from_location_id: main,
      to_location_id: warehouse,
      to_location_name: 'Warehouse',
      note: 'Seasonal stock',
      items: [{ product_id: p.id, quantity: 4 }],
    });
    expect(await stocks(owner, p.id)).toEqual([6, 4]);

    const list = (await http.get('/transfers', owner.token)).body;
    expect(list.total).toBe(1);
    expect((await http.get(`/transfers/${res.body.id}`, owner.token)).status).toBe(200);
  });

  it('moves several products at once and merges duplicates', async () => {
    const owner = await registerOwner(ctx);
    const main = await mainId(owner);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const a = await createProduct(ctx, owner, { quantity: 10 });
    const b = await createProduct(ctx, owner, { quantity: 5 });

    const res = await http.post(
      '/transfers',
      {
        from_location_id: main,
        to_location_id: shop,
        items: [
          { product_id: a.id, quantity: 2 },
          { product_id: a.id, quantity: 3 },
          { product_id: b.id, quantity: 5 },
        ],
      },
      owner.token,
    );
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(2);
    expect(await stocks(owner, a.id)).toEqual([5, 5]);
    expect(await stocks(owner, b.id)).toEqual([0, 5]);
  });

  it('changes nothing when one product has too little stock', async () => {
    const owner = await registerOwner(ctx);
    const main = await mainId(owner);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const a = await createProduct(ctx, owner, { quantity: 10 });
    const b = await createProduct(ctx, owner, { quantity: 1 });

    const res = await http.post(
      '/transfers',
      {
        from_location_id: main,
        to_location_id: shop,
        items: [
          { product_id: a.id, quantity: 5 },
          { product_id: b.id, quantity: 2 },
        ],
      },
      owner.token,
    );
    expect(res.status).toBe(400);
    expect(await stocks(owner, a.id)).toEqual([10, 0]);
    expect(await stocks(owner, b.id)).toEqual([1, 0]);
    expect((await http.get('/transfers', owner.token)).body.total).toBe(0);
  });

  it('rejects the same location, unknown locations and unknown products', async () => {
    const owner = await registerOwner(ctx);
    const main = await mainId(owner);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const p = await createProduct(ctx, owner, { quantity: 3 });
    const item = [{ product_id: p.id, quantity: 1 }];

    const same = await http.post(
      '/transfers',
      { from_location_id: main, to_location_id: main, items: item },
      owner.token,
    );
    expect(same.status).toBe(400);

    const unknown = await http.post(
      '/transfers',
      { from_location_id: main, to_location_id: 99999, items: item },
      owner.token,
    );
    expect(unknown.status).toBe(404);

    const noProduct = await http.post(
      '/transfers',
      {
        from_location_id: main,
        to_location_id: shop,
        items: [{ product_id: 99999, quantity: 1 }],
      },
      owner.token,
    );
    expect(noProduct.status).toBe(404);
  });

  it('is owner only and isolated between stores', async () => {
    const owner = await registerOwner(ctx);
    const main = await mainId(owner);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const p = await createProduct(ctx, owner, { quantity: 3 });
    const seller = await createAssociate(ctx, owner);
    const body = {
      from_location_id: main,
      to_location_id: shop,
      items: [{ product_id: p.id, quantity: 1 }],
    };

    expect((await http.post('/transfers', body, seller.token)).status).toBe(403);

    const stranger = await registerOwner(ctx);
    expect((await http.post('/transfers', body, stranger.token)).status).toBe(404);
  });

  it('filters history by location and blocks deleting a location with history', async () => {
    const owner = await registerOwner(ctx);
    const main = await mainId(owner);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const other = await addLocation(owner, 'Third shop', 'store');
    const p = await createProduct(ctx, owner, { quantity: 5 });
    await http.post(
      '/transfers',
      { from_location_id: main, to_location_id: shop, items: [{ product_id: p.id, quantity: 5 }] },
      owner.token,
    );

    expect((await http.get(`/transfers?location_id=${shop}`, owner.token)).body.total).toBe(1);
    expect((await http.get(`/transfers?location_id=${other}`, owner.token)).body.total).toBe(0);

    // Boşaldılsa belə, tarixçəsi olan məkan silinmir.
    await http.request('PATCH', `/products/${p.id}/stock`, {
      token: owner.token,
      headers: { 'x-location-id': String(shop) },
      payload: { quantity: 0 },
    });
    expect((await http.delete(`/locations/${shop}`, owner.token)).status).toBe(409);
    expect((await http.delete(`/locations/${other}`, owner.token)).status).toBe(200);
  });
});
