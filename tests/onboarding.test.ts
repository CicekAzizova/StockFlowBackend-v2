import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  createAssociate,
  createContext,
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

const account = {
  name: 'Çiçək',
  email: 'cicek@test.com',
  password: 'secret1',
  phone: '+994501234567',
};

describe('registration without store details', () => {
  it('creates a placeholder store and marks the onboarding as not completed', async () => {
    const res = await http.post('/auth/register', account);
    expect(res.status).toBe(201);
    expect(res.body.store_name).toBe("Çiçək's store");
    expect(res.body.store_phone).toBe(account.phone);
    expect(res.body.user.onboarding_completed).toBe(false);

    const me = await http.get('/users/me', res.body.token);
    expect(me.body.onboarding_completed).toBe(false);

    const store = await http.get('/stores/current', res.body.token);
    expect(store.body).toMatchObject({ country: null, city: '', onboarding_completed: false });
  });

  it('a registration with a store name (old app) is already completed', async () => {
    const res = await http.post('/auth/register', {
      ...account,
      store_name: 'My Store',
      store_address: 'Baku',
      store_phone: '+994121234567',
    });
    expect(res.status).toBe(201);
    expect(res.body.store_name).toBe('My Store');
    expect(res.body.user.onboarding_completed).toBe(true);
  });
});

describe('store country, city and onboarding', () => {
  it('the owner finishes the wizard through PATCH /stores/current', async () => {
    const res = await http.post('/auth/register', account);
    const token = res.body.token as string;

    const patched = await http.patch(
      '/stores/current',
      { name: 'Çiçək Market', country: 'az', city: ' Baku ', onboarding_completed: true },
      token,
    );
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      name: 'Çiçək Market',
      country: 'AZ',
      city: 'Baku',
      onboarding_completed: true,
    });
    expect((await http.get('/users/me', token)).body.onboarding_completed).toBe(true);

    const cleared = await http.patch('/stores/current', { country: null }, token);
    expect(cleared.body.country).toBeNull();
  });

  it('rejects an invalid country code', async () => {
    const owner = await registerOwner(ctx);
    for (const bad of ['Azerbaijan', 'A', '12', '']) {
      const res = await http.patch('/stores/current', { country: bad }, owner.token);
      expect(res.status, bad).toBe(400);
    }
  });

  it('sellers are never sent to the wizard and cannot edit the store', async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner);
    expect((await http.get('/users/me', seller.token)).body.onboarding_completed).toBe(true);
    expect((await http.patch('/stores/current', { city: 'Baku' }, seller.token)).status).toBe(403);
  });
});

describe('review fixes', () => {
  it('saves the time zone at registration and in PATCH /stores/current', async () => {
    const res = await http.post('/auth/register', { ...account, timezone: 'America/New_York' });
    expect(res.status).toBe(201);
    const token = res.body.token as string;
    expect((await http.get('/stores/current', token)).body.timezone).toBe('America/New_York');

    const patched = await http.patch('/stores/current', { timezone: 'Europe/Istanbul' }, token);
    expect(patched.body.timezone).toBe('Europe/Istanbul');

    expect((await http.patch('/stores/current', { timezone: 'Mars/Base' }, token)).status).toBe(
      400,
    );
  });

  it('accepts Turkish as the user language', async () => {
    const res = await http.post('/auth/register', { ...account, locale: 'tr' });
    expect(res.status).toBe(201);
    expect(res.body.user.locale).toBe('tr');
    expect(ctx.mailer.outbox.at(-1)?.subject).toContain('doğrulama');
  });

  it('a product can still be edited after the store categories changed', async () => {
    const owner = await registerOwner(ctx, { main_categories: ['food'] });
    const created = await http.post(
      '/products',
      { name: 'Milk', sku: 'M-1', price: 2, subcategory: 'food.dairy' },
      owner.token,
    );
    expect(created.status).toBe(201);

    await http.patch('/stores/current', { main_categories: ['home'] }, owner.token);

    const edited = await http.put(
      `/products/${created.body.id}`,
      { name: 'Milk 1L', sku: 'M-1', price: 2, subcategory: 'food.dairy' },
      owner.token,
    );
    expect(edited.status).toBe(200);
    expect(edited.body.subcategory).toBe('food.dairy');

    const moved = await http.put(
      `/products/${created.body.id}`,
      { name: 'Milk 1L', sku: 'M-1', price: 2, subcategory: 'sports.fitness' },
      owner.token,
    );
    expect(moved.status).toBe(400);
  });
});
