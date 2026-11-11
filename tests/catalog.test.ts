import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  createAssociate,
  createContext,
  createProduct,
  registerOwner,
  type TestContext,
} from './helpers/context.js';
import { MAIN_CATEGORY_CODES, type CATALOG } from '../src/modules/catalog/catalog.data.js';

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

describe('catalog', () => {
  it('is public and lists every category with names in four languages', async () => {
    const res = await http.get('/catalog/categories');
    expect(res.status).toBe(200);
    const categories = res.body.categories as typeof CATALOG;
    expect(categories.map((c) => c.code)).toEqual([...MAIN_CATEGORY_CODES]);

    const seen = new Set<string>();
    for (const category of categories) {
      for (const lang of ['en', 'az', 'ru', 'tr'] as const) {
        expect(category.names[lang], `${category.code} ${lang}`).toBeTruthy();
      }
      expect(category.subcategories.length).toBeGreaterThan(0);
      expect(category.subcategories.at(-1)?.code).toBe(`${category.code}.other`);
      for (const sub of category.subcategories) {
        expect(sub.code.startsWith(`${category.code}.`)).toBe(true);
        expect(seen.has(sub.code), `duplicate ${sub.code}`).toBe(false);
        seen.add(sub.code);
        for (const lang of ['en', 'az', 'ru', 'tr'] as const) {
          expect(sub.names[lang], `${sub.code} ${lang}`).toBeTruthy();
        }
      }
    }
  });
});

describe('store categories', () => {
  it('defaults to "other", accepts several categories at registration and in updates', async () => {
    const plain = await registerOwner(ctx);
    expect((await http.get('/stores/current', plain.token)).body.main_categories).toEqual([
      'other',
    ]);
    expect((await http.get('/users/me', plain.token)).body.main_categories).toEqual(['other']);

    const mixed = await registerOwner(ctx, { main_categories: ['food', 'home'] });
    expect((await http.get('/stores/current', mixed.token)).body.main_categories).toEqual([
      'food',
      'home',
    ]);
    expect((await http.get('/users/me', mixed.token)).body.main_categories).toEqual([
      'food',
      'home',
    ]);

    const patched = await http.patch(
      '/stores/current',
      { main_categories: ['clothing', 'sports', 'kids'] },
      mixed.token,
    );
    expect(patched.status).toBe(200);
    expect(patched.body.main_categories).toEqual(['clothing', 'sports', 'kids']);
  });

  it('rejects unknown, repeated, empty and too many categories', async () => {
    const owner = await registerOwner(ctx);
    for (const bad of [
      ['nope'],
      ['food', 'food'],
      [],
      ['food', 'clothing', 'home', 'beauty', 'kids', 'books'],
    ]) {
      expect(
        (await http.patch('/stores/current', { main_categories: bad }, owner.token)).status,
      ).toBe(400);
    }
    expect((await http.get('/stores/current', owner.token)).body.main_categories).toEqual([
      'other',
    ]);
  });

  it('only the owner can change the categories', async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner);
    expect(
      (await http.patch('/stores/current', { main_categories: ['food'] }, seller.token)).status,
    ).toBe(403);
  });
});

describe('product subcategory', () => {
  it('accepts subcategories of the store categories only', async () => {
    const owner = await registerOwner(ctx, { main_categories: ['food', 'home'] });

    const dairy = await createProduct(ctx, owner, { subcategory: 'food.dairy' });
    expect(dairy).toMatchObject({ subcategory: 'food.dairy' });
    const kitchen = await createProduct(ctx, owner, { subcategory: 'home.other' });
    expect(kitchen).toMatchObject({ subcategory: 'home.other' });
    const none = await createProduct(ctx, owner);
    expect(none).toMatchObject({ subcategory: null });

    for (const bad of ['clothing.men', 'food.unknown', 'nonsense']) {
      const res = await http.post(
        '/products',
        { name: 'X', sku: `BAD-${bad}`, price: 1, subcategory: bad },
        owner.token,
      );
      expect(res.status, bad).toBe(400);
      expect(res.body.code).toBe('INVALID_SUBCATEGORY');
    }
  });

  it('validates and clears the subcategory when updating', async () => {
    const owner = await registerOwner(ctx, { main_categories: ['food'] });
    const p = await createProduct(ctx, owner, { sku: 'SC-1', subcategory: 'food.dairy' });
    const body = { name: p.name, sku: 'SC-1', price: 10 };

    // Göndərilməyibsə dəyişmir.
    const same = await http.put(`/products/${p.id}`, body, owner.token);
    expect(same.body.subcategory).toBe('food.dairy');

    const changed = await http.put(
      `/products/${p.id}`,
      { ...body, subcategory: 'food.drinks' },
      owner.token,
    );
    expect(changed.body.subcategory).toBe('food.drinks');

    const wrong = await http.put(
      `/products/${p.id}`,
      { ...body, subcategory: 'sports.fitness' },
      owner.token,
    );
    expect(wrong.status).toBe(400);

    const cleared = await http.put(
      `/products/${p.id}`,
      { ...body, subcategory: null },
      owner.token,
    );
    expect(cleared.body.subcategory).toBeNull();
  });
});
