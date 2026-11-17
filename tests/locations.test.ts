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

describe('locations', () => {
  it('creates the main location together with the store', async () => {
    const owner = await registerOwner(ctx, { store_name: 'Çiçək Market', store_address: 'Baku' });
    const res = await http.get('/locations', owner.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: expect.any(Number),
        name: 'Çiçək Market',
        kind: 'store',
        address: 'Baku',
        is_main: true,
      },
    ]);
  });

  it('adds stores and warehouses, main first in the list', async () => {
    const owner = await registerOwner(ctx, { store_name: 'Main' });
    const branch = await http.post(
      '/locations',
      { name: 'Yasamal', address: 'Sh. Mehdiyev 45' },
      owner.token,
    );
    expect(branch.status).toBe(201);
    expect(branch.body).toMatchObject({ name: 'Yasamal', kind: 'store', is_main: false });

    const warehouse = await http.post(
      '/locations',
      { name: 'Central warehouse', kind: 'warehouse' },
      owner.token,
    );
    expect(warehouse.status).toBe(201);
    expect(warehouse.body).toMatchObject({ kind: 'warehouse', address: '', is_main: false });

    const list = await http.get('/locations', owner.token);
    expect((list.body as { name: string }[]).map((l) => l.name)).toEqual([
      'Main',
      'Yasamal',
      'Central warehouse',
    ]);
  });

  it('rejects a duplicate name (any letter case), blank names and bad kinds', async () => {
    const owner = await registerOwner(ctx, { store_name: 'Main' });
    expect((await http.post('/locations', { name: 'main' }, owner.token)).status).toBe(409);
    for (const bad of [{ name: '   ' }, {}, { name: 'X', kind: 'shop' }]) {
      expect((await http.post('/locations', bad, owner.token)).status).toBe(400);
    }
  });

  it('keeps exactly one main location and never makes a warehouse main', async () => {
    const owner = await registerOwner(ctx, { store_name: 'Main' });
    const branch = await http.post('/locations', { name: 'Yasamal' }, owner.token);

    const promoted = await http.patch(
      `/locations/${branch.body.id}`,
      { is_main: true },
      owner.token,
    );
    expect(promoted.status).toBe(200);
    expect(promoted.body.is_main).toBe(true);

    const list = (await http.get('/locations', owner.token)).body as {
      name: string;
      is_main: boolean;
    }[];
    expect(list.filter((l) => l.is_main).map((l) => l.name)).toEqual(['Yasamal']);
    expect(list[0]?.name).toBe('Yasamal');

    const warehouse = await http.post(
      '/locations',
      { name: 'Depot', kind: 'warehouse' },
      owner.token,
    );
    expect(
      (await http.patch(`/locations/${warehouse.body.id}`, { is_main: true }, owner.token)).status,
    ).toBe(400);
    expect(
      (
        await http.post(
          '/locations',
          { name: 'Depot 2', kind: 'warehouse', is_main: true },
          owner.token,
        )
      ).status,
    ).toBe(400);
    expect(
      (await http.patch(`/locations/${branch.body.id}`, { is_main: false }, owner.token)).status,
    ).toBe(400);
  });

  it('can create a new main location, replacing the old one', async () => {
    const owner = await registerOwner(ctx, { store_name: 'Main' });
    const created = await http.post('/locations', { name: 'Flagship', is_main: true }, owner.token);
    expect(created.status).toBe(201);
    const list = (await http.get('/locations', owner.token)).body as {
      name: string;
      is_main: boolean;
    }[];
    expect(list.filter((l) => l.is_main).map((l) => l.name)).toEqual(['Flagship']);
  });

  it('renames a location and rejects a name another location already uses', async () => {
    const owner = await registerOwner(ctx, { store_name: 'Main' });
    const branch = await http.post('/locations', { name: 'Yasamal' }, owner.token);
    const renamed = await http.patch(
      `/locations/${branch.body.id}`,
      { name: 'Yasamal branch', address: 'New street' },
      owner.token,
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Yasamal branch', address: 'New street' });
    expect(
      (await http.patch(`/locations/${branch.body.id}`, { name: 'MAIN' }, owner.token)).status,
    ).toBe(409);
  });

  it('is private to the store and to the owner', async () => {
    const owner = await registerOwner(ctx);
    const stranger = await registerOwner(ctx);
    const branch = await http.post('/locations', { name: 'Yasamal' }, owner.token);

    expect(
      (await http.patch(`/locations/${branch.body.id}`, { name: 'Hacked' }, stranger.token)).status,
    ).toBe(404);
    expect((await http.get('/locations', stranger.token)).body).toHaveLength(1);

    const seller = await createAssociate(ctx, owner);
    expect((await http.get('/locations', seller.token)).status).toBe(403);
    expect((await http.post('/locations', { name: 'X' }, seller.token)).status).toBe(403);
    expect((await http.get('/locations')).status).toBe(401);
  });

  it('limits the number of locations per store', async () => {
    const owner = await registerOwner(ctx, { store_name: 'Main' });
    for (let i = 1; i < 20; i++) {
      expect((await http.post('/locations', { name: `L${i}` }, owner.token)).status).toBe(201);
    }
    const over = await http.post('/locations', { name: 'One too many' }, owner.token);
    expect(over.status).toBe(400);
    expect(over.body.code).toBe('LOCATION_LIMIT');
  });

  it('makes the main location follow the store name unless it was renamed', async () => {
    const owner = await registerOwner(ctx, { store_name: 'Old name' });
    await http.patch('/stores/current', { name: 'New name', address: 'New address' }, owner.token);
    expect((await http.get('/locations', owner.token)).body[0]).toMatchObject({
      name: 'New name',
      address: 'New address',
    });

    const main = (await http.get('/locations', owner.token)).body[0] as { id: number };
    await http.patch(`/locations/${main.id}`, { name: 'HQ' }, owner.token);
    await http.patch('/stores/current', { name: 'Third name' }, owner.token);
    expect((await http.get('/locations', owner.token)).body[0]).toMatchObject({ name: 'HQ' });
  });
});
