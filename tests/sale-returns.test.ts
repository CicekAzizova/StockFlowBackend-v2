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

/** Mağaza vaxtı ilə (Asia/Baku) bu günün tarixi, YYYY-MM-DD. */
function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Baku' });
}

describe('sale returns', () => {
  it('returns part of a sale, puts the goods back and lowers revenue', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 20, cost_price: 4 });
    const sale = await http.post('/sales', { product_id: p.id, quantity: 5 }, owner.token);
    const line = sale.body.sale.items[0];

    const res = await http.post(
      `/sales/${sale.body.saleId}/returns`,
      { items: [{ sale_item_id: line.id, quantity: 2 }], reason: 'wrong_item' },
      owner.token,
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ total_amount: 20, restocked: true, reason: 'wrong_item' });

    const stock = await http.get(`/products/${p.id}`, owner.token);
    expect(stock.body.quantity).toBe(17); // 20 - 5 + 2

    const updated = await http.get(`/sales/${sale.body.saleId}`, owner.token);
    expect(updated.body.returned_amount).toBe(20);
    expect(updated.body.items[0].returned_quantity).toBe(2);

    const totals = await http.get(`/sales/totals?from=${today()}&to=${today()}`, owner.token);
    expect(totals.body.revenue).toBe(30); // 50 - 20

    const report = await http.get('/reports/sales?period=week', owner.token);
    expect(report.body).toMatchObject({ revenue: 30, profit: 18, items_sold: 3 });
  });

  it('keeps stock unchanged for damaged goods', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 20 });
    const sale = await http.post('/sales', { product_id: p.id, quantity: 3 }, owner.token);
    const line = sale.body.sale.items[0];

    await http.post(
      `/sales/${sale.body.saleId}/returns`,
      { items: [{ sale_item_id: line.id, quantity: 1 }], reason: 'damaged', restock: false },
      owner.token,
    );

    const stock = await http.get(`/products/${p.id}`, owner.token);
    expect(stock.body.quantity).toBe(17); // qalığa qayıtmır
  });

  it('refuses to return more than what is left and refuses associates', async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 20 });
    const sale = await http.post('/sales', { product_id: p.id, quantity: 2 }, owner.token);
    const line = sale.body.sale.items[0];

    const tooMany = await http.post(
      `/sales/${sale.body.saleId}/returns`,
      { items: [{ sale_item_id: line.id, quantity: 3 }] },
      owner.token,
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe('TOO_MANY_RETURNED');

    await http.post(
      `/sales/${sale.body.saleId}/returns`,
      { items: [{ sale_item_id: line.id, quantity: 2 }] },
      owner.token,
    );
    const again = await http.post(
      `/sales/${sale.body.saleId}/returns`,
      { items: [{ sale_item_id: line.id, quantity: 1 }] },
      owner.token,
    );
    expect(again.status).toBe(400);

    const bySeller = await http.post(
      `/sales/${sale.body.saleId}/returns`,
      { items: [{ sale_item_id: line.id, quantity: 1 }] },
      seller.token,
    );
    expect(bySeller.status).toBe(403);
  });
});

describe('refund method', () => {
  it('takes the refund out of the chosen method in the totals', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 50 });

    // 50 nağd, 30 kart
    const cashSale = await http.post('/sales', { product_id: p.id, quantity: 5 }, owner.token);
    await http.post(
      '/sales',
      { items: [{ product_id: p.id, quantity: 3 }], payment_method: 'card' },
      owner.token,
    );

    await http.post(
      `/sales/${cashSale.body.saleId}/returns`,
      {
        items: [{ sale_item_id: cashSale.body.sale.items[0].id, quantity: 2 }],
        refund_method: 'cash',
      },
      owner.token,
    );

    const res = await http.get(`/sales/totals?from=${today()}&to=${today()}`, owner.token);
    // Məbləğlər bərabərdir, ona görə ad üzrə əlifba sırası.
    expect(res.body.by_payment).toEqual([
      { method: 'card', amount: 30 },
      { method: 'cash', amount: 30 }, // 50 - 20
    ]);
    expect(res.body.revenue).toBe(60);
  });
});
