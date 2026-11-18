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

async function history(owner: Session, productId: number, query = '') {
  const res = await http.get(`/products/${productId}/history${query}`, owner.token);
  expect(res.status).toBe(200);
  return res.body as {
    total: number;
    items: Array<{
      type: string;
      quantity_change: number;
      balance_after: number | null;
      location_name: string;
      related_location_name: string | null;
      receipt_no: number | null;
      note: string | null;
    }>;
  };
}

describe('stock history', () => {
  it('records the starting stock of every location', async () => {
    const owner = await registerOwner(ctx);
    const main = await mainId(owner);
    const warehouse = await addLocation(owner, 'Warehouse', 'warehouse');
    const p = await createProduct(ctx, owner, {
      quantity: undefined,
      stocks: [
        { location_id: main, quantity: 24 },
        { location_id: warehouse, quantity: 60 },
      ],
    });

    const res = await history(owner, p.id);
    expect(res.total).toBe(2);
    expect(res.items.map((i) => [i.type, i.quantity_change, i.balance_after])).toEqual(
      expect.arrayContaining([
        ['initial', 24, 24],
        ['initial', 60, 60],
      ]),
    );
  });

  it('records restocks with a note, corrections, sales and transfers (newest first)', async () => {
    const owner = await registerOwner(ctx);
    const main = await mainId(owner);
    const warehouse = await addLocation(owner, 'Warehouse', 'warehouse');
    const p = await createProduct(ctx, owner, { quantity: 10 });

    await http.post(
      `/products/${p.id}/restock`,
      { quantity: 5, note: 'From supplier' },
      owner.token,
    );
    await http.patch(`/products/${p.id}/stock`, { quantity: 12, note: 'Damaged' }, owner.token);
    const sale = await http.post('/sales', { product_id: p.id, quantity: 2 }, owner.token);
    expect(sale.status).toBe(201);
    await http.post(
      '/transfers',
      {
        from_location_id: main,
        to_location_id: warehouse,
        items: [{ product_id: p.id, quantity: 4 }],
      },
      owner.token,
    );

    const res = await history(owner, p.id);
    expect(res.items.map((i) => [i.type, i.quantity_change, i.balance_after])).toEqual([
      ['transfer_in', 4, 4],
      ['transfer_out', -4, 6],
      ['sale', -2, 10],
      ['adjustment', -3, 12],
      ['restock', 5, 15],
      ['initial', 10, 10],
    ]);

    const byType = Object.fromEntries(res.items.map((i) => [i.type, i]));
    expect(byType.restock?.note).toBe('From supplier');
    expect(byType.adjustment?.note).toBe('Damaged');
    expect(byType.sale?.receipt_no).toBe(sale.body.receipt_no);
    expect(byType.transfer_out).toMatchObject({
      related_location_name: 'Warehouse',
    });
  });

  it('filters by location and paginates', async () => {
    const owner = await registerOwner(ctx);
    const main = await mainId(owner);
    const warehouse = await addLocation(owner, 'Warehouse', 'warehouse');
    const p = await createProduct(ctx, owner, { quantity: 10 });
    await http.post(
      '/transfers',
      {
        from_location_id: main,
        to_location_id: warehouse,
        items: [{ product_id: p.id, quantity: 3 }],
      },
      owner.token,
    );

    const onlyWarehouse = await history(owner, p.id, `?location_id=${warehouse}`);
    expect(onlyWarehouse.items.map((i) => i.type)).toEqual(['transfer_in']);

    const page = await http.get(`/products/${p.id}/history?limit=2`, owner.token);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.total).toBe(3);
    expect(page.body.has_next).toBe(true);
  });

  it('does not record a failed sale and is owner only', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { quantity: 1 });
    const fail = await http.post('/sales', { product_id: p.id, quantity: 5 }, owner.token);
    expect(fail.status).toBe(400);
    expect((await history(owner, p.id)).items.map((i) => i.type)).toEqual(['initial']);

    const seller = await createAssociate(ctx, owner);
    expect((await http.get(`/products/${p.id}/history`, seller.token)).status).toBe(403);
    expect((await http.get('/products/999999/history', owner.token)).status).toBe(404);
  });
});
