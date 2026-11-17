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

const at = (owner: { token: string }, locationId: number) => ({
  token: owner.token,
  headers: { 'x-location-id': String(locationId) },
});

describe('sales associate location', () => {
  it('defaults to the main location and shows it in the team list', async () => {
    const owner = await registerOwner(ctx, { store_name: 'Main shop' });
    const seller = await createAssociate(ctx, owner);

    const team = (await http.get('/users', owner.token)).body;
    expect(team[0]).toMatchObject({ id: seller.id, location_name: 'Main shop' });

    const me = (await http.get('/users/me', seller.token)).body;
    expect(me).toMatchObject({ location_name: 'Main shop' });
  });

  it('assigns a store when creating and changes it later', async () => {
    const owner = await registerOwner(ctx);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const other = await addLocation(owner, 'Third shop', 'store');
    const seller = await createAssociate(ctx, owner, { location_id: shop });

    expect((await http.get('/users/me', seller.token)).body.location_id).toBe(shop);

    const moved = await http.patch(
      `/users/sales-associate/${seller.id}`,
      { location_id: other },
      owner.token,
    );
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ location_id: other, location_name: 'Third shop' });

    const back = await http.patch(
      `/users/sales-associate/${seller.id}`,
      { location_id: null },
      owner.token,
    );
    expect(back.body.location_id).not.toBe(other);
  });

  it('rejects warehouses and locations of other stores', async () => {
    const owner = await registerOwner(ctx);
    const warehouse = await addLocation(owner, 'Warehouse', 'warehouse');
    const stranger = await registerOwner(ctx);
    const foreign = (await http.get('/locations', stranger.token)).body[0].id as number;

    const base = {
      name: 'Seller',
      surname: 'Two',
      fin: 'FIN0001',
      phone: '+994507654321',
      email: 'x@test.com',
      password: 'seller123',
    };
    const a = await http.post(
      '/users/sales-associate',
      { ...base, location_id: warehouse },
      owner.token,
    );
    expect(a.status).toBe(400);
    const b = await http.post(
      '/users/sales-associate',
      { ...base, location_id: foreign },
      owner.token,
    );
    expect(b.status).toBe(404);
  });

  it('shows the associate only the stock of their location and sells from it', async () => {
    const owner = await registerOwner(ctx);
    const shop = await addLocation(owner, 'Second shop', 'store');
    const p = await createProduct(ctx, owner, { price: 10, quantity: 5 });
    await http.request('PATCH', `/products/${p.id}/stock`, {
      ...at(owner, shop),
      payload: { quantity: 3 },
    });
    const seller = await createAssociate(ctx, owner, { location_id: shop });

    const seen = (await http.get(`/products/${p.id}`, seller.token)).body;
    expect(seen.quantity).toBe(3);
    expect(seen.stocks).toHaveLength(1);

    const sale = await http.post('/sales', { product_id: p.id, quantity: 2 }, seller.token);
    expect(sale.status).toBe(201);

    const stocks = (await http.get(`/products/${p.id}`, owner.token)).body.stocks;
    expect(stocks.map((s: { quantity: number }) => s.quantity)).toEqual([5, 1]);
  });

  it('refuses to delete a location that has an associate', async () => {
    const owner = await registerOwner(ctx);
    const shop = await addLocation(owner, 'Second shop', 'store');
    await createAssociate(ctx, owner, { location_id: shop });

    const res = await http.delete(`/locations/${shop}`, owner.token);
    expect(res.status).toBe(409);
  });
});
