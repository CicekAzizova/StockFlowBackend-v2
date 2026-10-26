import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  createContext,
  makeJpeg,
  multipart,
  registerOwner,
  createAssociate,
  createProduct,
  type TestContext,
} from './helpers/context.js';

let ctx: TestContext;
let http: ReturnType<typeof api>;
beforeAll(async () => {
  ctx = await createContext();
  http = api(ctx.app);
});
afterAll(() => ctx.close());

const upload = (token: string, content: Buffer, type = 'image/jpeg') => {
  const { payload, headers } = multipart('image', 'p.jpg', type, content);
  return ctx.app.inject({
    method: 'POST',
    url: '/uploads/images',
    payload,
    headers: { ...headers, authorization: `Bearer ${token}` },
  });
};

describe('uploads', () => {
  it('stores a processed image and a thumbnail', async () => {
    const owner = await registerOwner(ctx);
    const res = await upload(owner.token, await makeJpeg(3000, 2000));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.imageUrl).toBeTruthy();
    expect(body.thumbnailUrl).toContain('_t');
  });

  it('rejects non-images and unauthenticated or associate uploads', async () => {
    const owner = await registerOwner(ctx);
    expect((await upload(owner.token, Buffer.from('not an image'))).statusCode).toBe(400);
    const seller = await createAssociate(ctx, owner);
    expect((await upload(seller.token, await makeJpeg())).statusCode).toBe(403);
    const { payload, headers } = multipart('image', 'p.jpg', 'image/jpeg', await makeJpeg());
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/uploads/images', payload, headers }))
        .statusCode,
    ).toBe(401);
  });

  it('rejects files over 5 MB', async () => {
    const owner = await registerOwner(ctx);
    const res = await upload(owner.token, Buffer.alloc(6 * 1024 * 1024, 1));
    expect(res.statusCode).toBe(413);
  });
});

describe('platform', () => {
  it('reports health and readiness', async () => {
    expect((await http.get('/health')).body).toMatchObject({ status: 'OK' });
    expect((await http.get('/health/ready')).status).toBe(200);
  });

  it('generates OpenAPI docs including the sale body', async () => {
    const res = await http.get('/api-docs/json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/auth/login', '/products', '/sales', '/sales/summary']),
    );
  });

  it('answers unknown routes in the common error format', async () => {
    const res = await http.get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ message: 'Route not found', code: 'ROUTE_NOT_FOUND' });
  });

  it('accepts trailing slashes and sets a request id', async () => {
    const owner = await registerOwner(ctx);
    const res = await http.get('/products/', owner.token);
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('rate limits with the common error format', async () => {
    const limited = await createContext({ RATE_LIMIT_ENABLED: 'true' });
    try {
      const h = api(limited.app);
      let last: Awaited<ReturnType<typeof h.post>> | undefined;
      for (let i = 0; i < 12; i++)
        last = await h.post('/auth/login', { email: 'a@b.com', password: 'whatever1' });
      expect(last?.status).toBe(429);
      expect(last?.body.code).toBe('RATE_LIMITED');
      expect(last?.body.message).toEqual(expect.any(String));
    } finally {
      await limited.close();
    }
  });
});

describe('iOS contract', () => {
  it('keeps the keys the app decodes', async () => {
    const owner = await registerOwner(ctx);
    const p = await createProduct(ctx, owner, { quantity: 5 });
    const login = (await http.post('/auth/login', { email: owner.email, password: 'secret123' }))
      .body;
    expect(Object.keys(login)).toEqual(expect.arrayContaining(['message', 'token', 'user']));
    expect(Object.keys(login.user)).toEqual(
      expect.arrayContaining(['id', 'name', 'email', 'role', 'store_id', 'store_name']),
    );
    const product = (await http.get(`/products/${p.id}`, owner.token)).body;
    expect(Object.keys(product)).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'sku',
        'category',
        'description',
        'price',
        'discount',
        'cost_price',
        'quantity',
        'low_stock_limit',
        'image_url',
        'image_urls',
        'created_at',
        'updated_at',
      ]),
    );
    const sale = (await http.post('/sales', { product_id: p.id, quantity: 1 }, owner.token)).body;
    expect(Object.keys(sale)).toEqual(expect.arrayContaining(['message', 'saleId', 'totalPrice']));
    expect(Object.keys(sale.sale)).toEqual(
      expect.arrayContaining([
        'id',
        'product_id',
        'product_name',
        'quantity',
        'unit_price',
        'total_price',
        'sold_by',
        'seller_name',
        'created_at',
      ]),
    );
    const store = (await http.get('/stores/current', owner.token)).body;
    expect(Object.keys(store)).toEqual(expect.arrayContaining(['id', 'name', 'address', 'phone']));
    const list = (await http.get('/products', owner.token)).body;
    expect(Object.keys(list)).toEqual(
      expect.arrayContaining(['items', 'page', 'limit', 'total', 'has_next']),
    );
  });
});
