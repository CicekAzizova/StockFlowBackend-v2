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

  it('rejects unknown, repeated and empty categories', async () => {
    const owner = await registerOwner(ctx);
    for (const bad of [['nope'], ['food', 'food'], []]) {
      expect(
        (await http.patch('/stores/current', { main_categories: bad }, owner.token)).status,
      ).toBe(400);
    }
    expect((await http.get('/stores/current', owner.token)).body.main_categories).toEqual([
      'other',
    ]);
  });

  it('accepts any number of categories, up to all of them', async () => {
    const owner = await registerOwner(ctx);
    const res = await http.patch(
      '/stores/current',
      { main_categories: [...MAIN_CATEGORY_CODES] },
      owner.token,
    );
    expect(res.status).toBe(200);
    expect(res.body.main_categories).toEqual([...MAIN_CATEGORY_CODES]);
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

describe('store subcategories', () => {
  it('starts empty, saves catalog subcategories and returns them in the store and profile', async () => {
    const owner = await registerOwner(ctx, { main_categories: ['food', 'home'] });
    expect((await http.get('/stores/current', owner.token)).body.subcategories).toEqual([]);

    const patched = await http.patch(
      '/stores/current',
      { subcategories: ['food.dairy', 'food.drinks'] },
      owner.token,
    );
    expect(patched.status).toBe(200);
    expect(patched.body.subcategories).toEqual(['food.dairy', 'food.drinks']);
    expect((await http.get('/users/me', owner.token)).body.subcategories).toEqual([
      'food.dairy',
      'food.drinks',
    ]);
  });

  it('rejects unknown, repeated and foreign subcategories', async () => {
    const owner = await registerOwner(ctx, { main_categories: ['food'] });
    for (const bad of [['nope'], ['food.dairy', 'food.dairy'], ['clothing.other']]) {
      expect(
        (await http.patch('/stores/current', { subcategories: bad }, owner.token)).status,
      ).toBe(400);
    }
    expect((await http.get('/stores/current', owner.token)).body.subcategories).toEqual([]);
  });

  it('drops subcategories of a main category that is removed', async () => {
    const owner = await registerOwner(ctx, { main_categories: ['food', 'home'] });
    await http.patch(
      '/stores/current',
      { subcategories: ['food.dairy', 'food.drinks'] },
      owner.token,
    );
    const patched = await http.patch('/stores/current', { main_categories: ['home'] }, owner.token);
    expect(patched.status).toBe(200);
    expect(patched.body.subcategories).toEqual([]);
  });
});

describe('custom subcategories', () => {
  const coffee = { main: 'food', name: 'Qəhvə' };

  it('creates a code for a new one and returns it in the store and profile', async () => {
    const owner = await registerOwner(ctx, { main_categories: ['food'] });
    const res = await http.patch(
      '/stores/current',
      { custom_subcategories: [coffee] },
      owner.token,
    );
    expect(res.status).toBe(200);
    expect(res.body.custom_subcategories).toHaveLength(1);
    expect(res.body.custom_subcategories[0]).toMatchObject({ main: 'food', name: 'Qəhvə' });
    expect(res.body.custom_subcategories[0].code).toMatch(/^food\.c_[0-9a-f]{8}$/);
    // Seçilmiş siyahı boş idi: "hamısı" qalır, yalnız yenisi seçilmir.
    expect(res.body.subcategories).toEqual([]);
    expect((await http.get('/users/me', owner.token)).body.custom_subcategories).toEqual(
      res.body.custom_subcategories,
    );
  });

  it('selects the new one when the store already narrows its subcategories', async () => {
    const owner = await registerOwner(ctx, { main_categories: ['food'] });
    await http.patch('/stores/current', { subcategories: ['food.dairy'] }, owner.token);
    const res = await http.patch(
      '/stores/current',
      { custom_subcategories: [coffee] },
      owner.token,
    );
    const code = res.body.custom_subcategories[0].code as string;
    expect(res.body.subcategories).toEqual(['food.dairy', code]);
  });

  it('keeps the code when renaming and drops the ones that are left out', async () => {
    const owner = await registerOwner(ctx, { main_categories: ['food'] });
    const first = await http.patch(
      '/stores/current',
      { custom_subcategories: [coffee, { main: 'food', name: 'Çay' }] },
      owner.token,
    );
    const [kept, removed] = first.body.custom_subcategories as { code: string }[];
    await http.patch(
      '/stores/current',
      { subcategories: [kept!.code, removed!.code] },
      owner.token,
    );

    const res = await http.patch(
      '/stores/current',
      { custom_subcategories: [{ code: kept!.code, main: 'food', name: 'Espresso' }] },
      owner.token,
    );
    expect(res.status).toBe(200);
    expect(res.body.custom_subcategories).toEqual([
      { code: kept!.code, main: 'food', name: 'Espresso' },
    ]);
    expect(res.body.subcategories).toEqual([kept!.code]);
  });

  it('rejects duplicates, a main category the store does not have and unknown codes', async () => {
    const owner = await registerOwner(ctx, { main_categories: ['food'] });
    const bad = [
      [coffee, { main: 'food', name: 'qəhvə' }],
      [{ main: 'home', name: 'Lampa' }],
      [{ code: 'food.c_00000000', main: 'food', name: 'Yox' }],
      [{ main: 'food', name: '   ' }],
    ];
    for (const list of bad) {
      expect(
        (await http.patch('/stores/current', { custom_subcategories: list }, owner.token)).status,
      ).toBe(400);
    }
    expect((await http.get('/stores/current', owner.token)).body.custom_subcategories).toEqual([]);
  });

  it('drops them when their main category is removed', async () => {
    const owner = await registerOwner(ctx, { main_categories: ['food', 'home'] });
    await http.patch('/stores/current', { custom_subcategories: [coffee] }, owner.token);
    const res = await http.patch('/stores/current', { main_categories: ['home'] }, owner.token);
    expect(res.body.custom_subcategories).toEqual([]);
  });

  it('can be used as a product subcategory, but not by another store', async () => {
    const owner = await registerOwner(ctx, { main_categories: ['food'] });
    const stranger = await registerOwner(ctx, { main_categories: ['food'] });
    const res = await http.patch(
      '/stores/current',
      { custom_subcategories: [coffee] },
      owner.token,
    );
    const code = res.body.custom_subcategories[0].code as string;

    const product = await createProduct(ctx, owner, { subcategory: code });
    expect(product).toMatchObject({ subcategory: code });
    const rejected = await http.post(
      '/products',
      { name: 'X', sku: 'CUSTOM-X', price: 1, subcategory: code },
      stranger.token,
    );
    expect(rejected.status).toBe(400);
  });
});
