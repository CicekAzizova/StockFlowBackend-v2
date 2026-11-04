import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  createAssociate,
  createContext,
  createProduct,
  makeJpeg,
  multipart,
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
  ctx.storage.objects.clear();
});

describe('profile', () => {
  it('reads and edits the own profile', async () => {
    const owner = await registerOwner(ctx);
    const me = await http.get('/users/me', owner.token);
    expect(me.body).toMatchObject({ role: 'OWNER', locale: 'az', email_verified: false });
    const patched = await http.patch('/users/me', { name: 'Yeni', locale: 'ru' }, owner.token);
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: 'Yeni', locale: 'ru' });
    expect((await http.patch('/users/me', { locale: 'xx' }, owner.token)).status).toBe(400);
  });

  it('edits the current store', async () => {
    const owner = await registerOwner(ctx);
    const res = await http.patch(
      '/stores/current',
      { name: 'Renamed', address: 'Ganja' },
      owner.token,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Renamed', address: 'Ganja' });
    expect((await http.get('/stores/current', owner.token)).body.name).toBe('Renamed');
  });

  it('uploads and removes an avatar', async () => {
    const owner = await registerOwner(ctx);
    const { payload, headers } = multipart('image', 'me.jpg', 'image/jpeg', await makeJpeg());
    const up = await ctx.app.inject({
      method: 'POST',
      url: '/users/me/avatar',
      payload,
      headers: { ...headers, authorization: `Bearer ${owner.token}` },
    });
    expect(up.statusCode).toBe(200);
    const url = up.json().avatar_url as string;
    expect(url).toBeTruthy();
    expect(ctx.storage.objects.size).toBeGreaterThan(0);
    const removed = await http.delete('/users/me/avatar', owner.token);
    expect(removed.body.avatar_url).toBeNull();
    expect(ctx.storage.objects.size).toBe(0);
  });
});

describe('team', () => {
  it('creates, lists, edits and removes associates', async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner, { name: 'Ali', fin: 'ABC1234' });
    const p = await createProduct(ctx, owner, { price: 10, quantity: 10 });
    await http.post('/sales', { product_id: p.id, quantity: 2 }, seller.token);

    const team = await http.get('/users', owner.token);
    expect(Array.isArray(team.body)).toBe(true);
    expect(team.body).toHaveLength(1);
    expect(team.body[0]).toMatchObject({ id: seller.id, name: 'Ali' });
    expect(team.body[0].total_sales_this_month).toBe(20);
    expect(team.body[0]).toMatchObject({
      today_sales: 20,
      today_orders: 1,
      month_sales: 20,
      month_orders: 1,
    });

    const edited = await http.patch(
      `/users/sales-associate/${seller.id}`,
      { name: 'Veli' },
      owner.token,
    );
    expect(edited.body.name).toBe('Veli');

    expect((await http.delete(`/users/${seller.id}`, owner.token)).status).toBe(200);
    expect((await http.get('/users', owner.token)).body).toHaveLength(0);
    // Silinmiş satıcı daxil ola bilmir, amma satış tarixçəsi qalır.
    expect(
      (await http.post('/auth/login', { email: seller.email, password: 'seller123' })).status,
    ).toBe(401);
    expect((await http.get('/sales', owner.token)).body.total).toBe(1);
  });

  it('deactivates and reactivates an associate without losing the account or sales', async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner);
    const p = await createProduct(ctx, owner, { price: 10, quantity: 10 });
    await http.post('/sales', { product_id: p.id, quantity: 1 }, seller.token);

    const off = await http.post(`/users/sales-associate/${seller.id}/deactivate`, {}, owner.token);
    expect(off.status).toBe(200);
    expect(off.body.is_active).toBe(false);

    // Köhnə token da, yeni giriş də bağlanır.
    expect((await http.get('/sales', seller.token)).status).toBe(401);
    const login = await http.post('/auth/login', { email: seller.email, password: 'seller123' });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('ACCOUNT_DEACTIVATED');

    // Siyahıda qalır, satış tarixçəsi qalır.
    const team = await http.get('/users', owner.token);
    expect(team.body).toHaveLength(1);
    expect(team.body[0]).toMatchObject({ id: seller.id, is_active: false, month_orders: 1 });
    expect((await http.get('/sales', owner.token)).body.total).toBe(1);

    const on = await http.post(`/users/sales-associate/${seller.id}/activate`, {}, owner.token);
    expect(on.status).toBe(200);
    expect(on.body.is_active).toBe(true);
    const again = await http.post('/auth/login', { email: seller.email, password: 'seller123' });
    expect(again.status).toBe(200);
  });

  it('shows whether an associate is online', async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner);

    // Hələ heç nə etməyib: oflayn və son aktivlik yoxdur.
    let row = (await http.get('/users', owner.token)).body[0];
    expect(row).toMatchObject({ is_online: false, last_active_at: null });

    // İstənilən sorğu (məsələn heartbeat) onu onlayn edir.
    expect((await http.post('/users/me/heartbeat', {}, seller.token)).status).toBe(200);
    row = (await http.get('/users', owner.token)).body[0];
    expect(row.is_online).toBe(true);
    expect(row.last_active_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // 10 dəqiqə əvvəl: oflayn, amma son aktivlik qalır.
    await ctx.pool.query(
      "UPDATE users SET last_active_at = now() - interval '10 minutes' WHERE id = $1",
      [seller.id],
    );
    row = (await http.get('/users', owner.token)).body[0];
    expect(row.is_online).toBe(false);
    expect(row.last_active_at).not.toBeNull();

    // Dəqiqədə bir dəfədən tez yazılmır, amma köhnəlmişsə yenilənir.
    await http.post('/users/me/heartbeat', {}, seller.token);
    expect((await http.get('/users', owner.token)).body[0].is_online).toBe(true);

    // Deaktiv satıcı onlayn sayılmır.
    await http.post(`/users/sales-associate/${seller.id}/deactivate`, {}, owner.token);
    expect((await http.get('/users', owner.token)).body[0].is_online).toBe(false);
  });

  it('only the owner can deactivate, and only own associates', async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner);
    const other = await registerOwner(ctx);

    expect(
      (await http.post(`/users/sales-associate/${seller.id}/deactivate`, {}, seller.token)).status,
    ).toBe(403);
    expect(
      (await http.post(`/users/sales-associate/${seller.id}/deactivate`, {}, other.token)).status,
    ).toBe(404);
  });

  it('rejects a duplicate email or FIN with the old message', async () => {
    const owner = await registerOwner(ctx);
    const first = await createAssociate(ctx, owner, { fin: 'SAME123' });
    const dup = await http.post(
      '/users/sales-associate',
      {
        name: 'B',
        surname: 'B',
        fin: 'SAME123',
        phone: '+994507654321',
        email: 'other@test.com',
        password: 'seller123',
      },
      owner.token,
    );
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe('Email or FIN is already registered');
    expect(first.id).toBeGreaterThan(0);
  });

  it('cannot touch associates of another store', async () => {
    const a = await registerOwner(ctx);
    const b = await registerOwner(ctx);
    const seller = await createAssociate(ctx, a);
    expect((await http.delete(`/users/${seller.id}`, b.token)).status).toBe(404);
    expect(
      (await http.patch(`/users/sales-associate/${seller.id}`, { name: 'Z' }, b.token)).status,
    ).toBe(404);
  });
});

describe('account deletion', () => {
  it('requires the password', async () => {
    const owner = await registerOwner(ctx, { password: 'secret123' });
    expect((await http.delete('/users/me', owner.token, { password: 'wrong-pass' })).status).toBe(
      400,
    );
    expect((await http.get('/users/me', owner.token)).status).toBe(200);
  });

  it('removes an owner with all store data and stored images', async () => {
    const owner = await registerOwner(ctx, { password: 'secret123', email: 'bye@test.com' });
    const seller = await createAssociate(ctx, owner);
    const p = await createProduct(ctx, owner, { quantity: 5 });
    await http.post('/sales', { product_id: p.id, quantity: 1 }, seller.token);

    const res = await http.delete('/users/me', owner.token, { password: 'secret123' });
    expect(res.status).toBe(200);
    for (const table of ['users', 'stores', 'products', 'sales', 'sale_items', 'refresh_tokens']) {
      const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
    // Eyni e-poçt yenidən qeydiyyatdan keçə bilər.
    await registerOwner(ctx, { email: 'bye@test.com' });
  });

  it("anonymizes an associate but keeps the owner's sales history", async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner, { password: 'seller123' });
    const p = await createProduct(ctx, owner, { quantity: 5 });
    await http.post('/sales', { product_id: p.id, quantity: 1 }, seller.token);
    expect((await http.delete('/users/me', seller.token, { password: 'seller123' })).status).toBe(
      200,
    );
    expect((await http.get('/sales', owner.token)).body.total).toBe(1);
    expect(
      (await http.post('/auth/login', { email: seller.email, password: 'seller123' })).status,
    ).toBe(401);
  });
});
