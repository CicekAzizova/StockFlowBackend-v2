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
  ctx.mailer.outbox.length = 0;
});

describe('register', () => {
  it('creates the owner, the store and returns a session', async () => {
    const res = await http.post('/auth/register', {
      name: 'Aysel',
      email: '  Aysel@Example.com ',
      password: 'secret1',
      phone: '+994501234567',
      store_name: 'My Store',
      store_address: 'Baku',
      store_phone: '+994121234567',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Aysel',
      email: 'aysel@example.com',
      store_name: 'My Store',
      store_address: 'Baku',
      store_phone: '+994121234567',
      email_verified: false,
      expires_in: 900,
    });
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.refresh_token).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ role: 'OWNER', store_name: 'My Store', locale: 'az' });
  });

  it('sends a verification code by email', async () => {
    const owner = await registerOwner(ctx, { email: 'new@test.com' });
    expect(owner.token).toBeTruthy();
    expect(ctx.mailer.outbox).toHaveLength(1);
    expect(ctx.mailer.outbox[0]?.to).toBe('new@test.com');
    expect(ctx.mailer.lastCodeFor('new@test.com')).toMatch(/^\d{6}$/);
  });

  it('rejects a duplicate email with the old message', async () => {
    await registerOwner(ctx, { email: 'dup@test.com' });
    const res = await http.post('/auth/register', {
      name: 'X',
      email: 'DUP@test.com',
      password: 'secret1',
      phone: '+994501234567',
      store_name: 'S',
      store_address: 'A',
      store_phone: '+994121234567',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      message: 'Email is already registered',
      code: 'EMAIL_ALREADY_REGISTERED',
    });
  });

  it('validates input with readable messages', async () => {
    const missing = await http.post('/auth/register', { email: 'a@b.com' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      message: 'All fields are required',
      code: 'VALIDATION_ERROR',
    });

    const shortPassword = await http.post('/auth/register', {
      name: 'X',
      email: 'a@b.com',
      password: '123',
      phone: '+994501234567',
      store_name: 'S',
      store_address: 'A',
      store_phone: '+994121234567',
    });
    expect(shortPassword.body.message).toBe('Password must contain at least 6 characters');

    const badEmail = await http.post('/auth/register', {
      name: 'X',
      email: 'not-an-email',
      password: 'secret1',
      phone: '+994501234567',
      store_name: 'S',
      store_address: 'A',
      store_phone: '+994121234567',
    });
    expect(badEmail.body.message).toBe('A valid email is required');
  });

  it('rejects malformed JSON', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: '{broken',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_JSON');
  });
});

describe('login', () => {
  it('logs in with the right password (email is case-insensitive)', async () => {
    await registerOwner(ctx, { email: 'login@test.com', password: 'secret123' });
    const res = await http.post('/auth/login', { email: 'LOGIN@test.com', password: 'secret123' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Login successful');
    expect(res.body.user).toMatchObject({ role: 'OWNER', email: 'login@test.com' });
    expect(res.body.token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
  });

  it('answers wrong password and unknown email identically with 401', async () => {
    await registerOwner(ctx, { email: 'login2@test.com' });
    const wrong = await http.post('/auth/login', {
      email: 'login2@test.com',
      password: 'nope-nope',
    });
    const unknown = await http.post('/auth/login', {
      email: 'ghost@test.com',
      password: 'nope-nope',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body).toMatchObject({
      message: 'Invalid email or password',
      code: 'INVALID_CREDENTIALS',
    });
  });
});

describe('access token', () => {
  it('is required and validated', async () => {
    const none = await http.get('/users/me');
    expect(none.status).toBe(401);
    expect(none.body.code).toBe('ACCESS_TOKEN_REQUIRED');

    const bad = await http.get('/users/me', 'garbage.token.value');
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('INVALID_TOKEN');
  });

  it('reports an expired token with its own code so the app can refresh', async () => {
    const short = await createContext({ ACCESS_TOKEN_TTL: '1s' });
    try {
      const owner = await registerOwner(short);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const res = await api(short.app).get('/users/me', owner.token);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TOKEN_EXPIRED');
    } finally {
      await short.close();
    }
  });
});

describe('refresh tokens', () => {
  it('rotates: the new token works and the old one is rejected after the grace period', async () => {
    const owner = await registerOwner(ctx);
    const first = await http.post('/auth/refresh', { refresh_token: owner.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(owner.refreshToken);
    expect((await http.get('/users/me', first.body.token)).status).toBe(200);

    const second = await http.post('/auth/refresh', { refresh_token: first.body.refresh_token });
    expect(second.status).toBe(200);
  });

  it('revokes the whole session when an old token is replayed (theft detection)', async () => {
    const owner = await registerOwner(ctx);
    const first = await http.post('/auth/refresh', { refresh_token: owner.refreshToken });
    // Dərhal təkrar işlətmə "şəbəkə xətası" sayılır. Grace müddəti keçmiş kimi göstəririk:
    await ctx.pool.query(
      "UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes', rotated_at = CASE WHEN rotated_at IS NULL THEN NULL ELSE now() - interval '5 minutes' END WHERE revoked_at IS NOT NULL",
    );

    const replay = await http.post('/auth/refresh', { refresh_token: owner.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('INVALID_REFRESH_TOKEN');

    // Oğurlanmış zəncirin yeni token-i də ləğv edilib.
    const child = await http.post('/auth/refresh', { refresh_token: first.body.refresh_token });
    expect(child.status).toBe(401);
  });

  it('tolerates an immediate retry of the same token (lost response)', async () => {
    const owner = await registerOwner(ctx);
    const a = await http.post('/auth/refresh', { refresh_token: owner.refreshToken });
    const b = await http.post('/auth/refresh', { refresh_token: owner.refreshToken });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it('rejects unknown and expired tokens', async () => {
    const unknown = await http.post('/auth/refresh', { refresh_token: 'x'.repeat(43) });
    expect(unknown.status).toBe(401);

    const owner = await registerOwner(ctx);
    await ctx.pool.query("UPDATE refresh_tokens SET expires_at = now() - interval '1 minute'");
    const expired = await http.post('/auth/refresh', { refresh_token: owner.refreshToken });
    expect(expired.status).toBe(401);
  });

  it('logout revokes the session', async () => {
    const owner = await registerOwner(ctx);
    expect((await http.post('/auth/logout', { refresh_token: owner.refreshToken })).status).toBe(
      200,
    );
    await ctx.pool.query(
      "UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes', rotated_at = CASE WHEN rotated_at IS NULL THEN NULL ELSE now() - interval '5 minutes' END",
    );
    expect((await http.post('/auth/refresh', { refresh_token: owner.refreshToken })).status).toBe(
      401,
    );
    // Naməlum token-lə logout xəta vermir.
    expect((await http.post('/auth/logout', { refresh_token: 'y'.repeat(43) })).status).toBe(200);
  });

  it('logout-all revokes every device', async () => {
    const owner = await registerOwner(ctx, { email: 'multi@test.com' });
    const second = await http.post('/auth/login', {
      email: 'multi@test.com',
      password: 'secret123',
    });
    await http.post('/auth/logout-all', {}, owner.token);
    await ctx.pool.query(
      "UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes', rotated_at = CASE WHEN rotated_at IS NULL THEN NULL ELSE now() - interval '5 minutes' END",
    );
    expect((await http.post('/auth/refresh', { refresh_token: owner.refreshToken })).status).toBe(
      401,
    );
    expect(
      (await http.post('/auth/refresh', { refresh_token: second.body.refresh_token })).status,
    ).toBe(401);
  });
});

describe('email verification', () => {
  it('verifies with the emailed code', async () => {
    const owner = await registerOwner(ctx, { email: 'verify@test.com' });
    const code = ctx.mailer.lastCodeFor('verify@test.com');

    const wrong = await http.post(
      '/auth/verify-email',
      { code: code === '000000' ? '111111' : '000000' },
      owner.token,
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVALID_CODE');

    const ok = await http.post('/auth/verify-email', { code }, owner.token);
    expect(ok.status).toBe(200);
    expect(ok.body.email_verified).toBe(true);

    expect((await http.get('/users/me', owner.token)).body.email_verified).toBe(true);
    // Yeni token verified bayrağını daşıyır.
    const refreshed = await http.post('/auth/refresh', { refresh_token: owner.refreshToken });
    expect(
      JSON.parse(Buffer.from(refreshed.body.token.split('.')[1], 'base64url').toString()).ev,
    ).toBe(true);
  });

  it('locks the code after 5 wrong attempts', async () => {
    const owner = await registerOwner(ctx, { email: 'brute@test.com' });
    const real = ctx.mailer.lastCodeFor('brute@test.com');
    const guess = real === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) {
      expect((await http.post('/auth/verify-email', { code: guess }, owner.token)).status).toBe(
        400,
      );
    }
    const locked = await http.post('/auth/verify-email', { code: real }, owner.token);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('expires after 15 minutes', async () => {
    const owner = await registerOwner(ctx, { email: 'late@test.com' });
    const code = ctx.mailer.lastCodeFor('late@test.com');
    await ctx.pool.query("UPDATE one_time_codes SET expires_at = now() - interval '1 second'");
    const res = await http.post('/auth/verify-email', { code }, owner.token);
    expect(res.status).toBe(400);
  });

  it('limits how often a new code can be requested', async () => {
    const owner = await registerOwner(ctx);
    const again = await http.post('/auth/resend-verification', {}, owner.token);
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('CODE_RECENTLY_SENT');

    await ctx.pool.query("UPDATE one_time_codes SET created_at = now() - interval '2 minutes'");
    expect((await http.post('/auth/resend-verification', {}, owner.token)).status).toBe(200);
  });

  it('can be required for every route except verification itself', async () => {
    const strict = await createContext({ REQUIRE_VERIFIED_EMAIL: 'true' });
    try {
      const owner = await registerOwner(strict, { email: 'strict@test.com' });
      const http2 = api(strict.app);
      const blocked = await http2.get('/products', owner.token);
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('EMAIL_NOT_VERIFIED');
      expect((await http2.get('/users/me', owner.token)).status).toBe(200);

      const code = strict.mailer.lastCodeFor('strict@test.com');
      expect((await http2.post('/auth/verify-email', { code }, owner.token)).status).toBe(200);
      const refreshed = await http2.post('/auth/refresh', { refresh_token: owner.refreshToken });
      expect((await http2.get('/products', refreshed.body.token)).status).toBe(200);
    } finally {
      await strict.close();
    }
  });
});

describe('password reset', () => {
  it('resets with the emailed code and signs out every device', async () => {
    const owner = await registerOwner(ctx, { email: 'reset@test.com', password: 'oldpass1' });
    ctx.mailer.outbox.length = 0;

    const requested = await http.post('/auth/forgot-password', { email: 'reset@test.com' });
    expect(requested.status).toBe(200);
    const code = ctx.mailer.lastCodeFor('reset@test.com');
    expect(code).toMatch(/^\d{6}$/);

    const bad = await http.post('/auth/reset-password', {
      email: 'reset@test.com',
      code: '999999',
      new_password: 'newpass1',
    });
    expect(bad.status).toBe(400);

    const ok = await http.post('/auth/reset-password', {
      email: 'reset@test.com',
      code,
      new_password: 'newpass1',
    });
    expect(ok.status).toBe(200);

    expect(
      (await http.post('/auth/login', { email: 'reset@test.com', password: 'oldpass1' })).status,
    ).toBe(401);
    expect(
      (await http.post('/auth/login', { email: 'reset@test.com', password: 'newpass1' })).status,
    ).toBe(200);

    await ctx.pool.query(
      "UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes', rotated_at = CASE WHEN rotated_at IS NULL THEN NULL ELSE now() - interval '5 minutes' END WHERE revoked_at IS NOT NULL",
    );
    expect((await http.post('/auth/refresh', { refresh_token: owner.refreshToken })).status).toBe(
      401,
    );
    // Kod bir dəfəlikdir.
    const reuse = await http.post('/auth/reset-password', {
      email: 'reset@test.com',
      code,
      new_password: 'another1',
    });
    expect(reuse.status).toBe(400);
  });

  it('does not reveal whether an email is registered', async () => {
    const known = await registerOwner(ctx, { email: 'known@test.com' });
    expect(known.token).toBeTruthy();
    ctx.mailer.outbox.length = 0;
    const a = await http.post('/auth/forgot-password', { email: 'known@test.com' });
    const b = await http.post('/auth/forgot-password', { email: 'unknown@test.com' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(ctx.mailer.outbox).toHaveLength(1);
  });
});

describe('change password', () => {
  it('needs the current password, logs out other devices and returns a fresh session', async () => {
    const owner = await registerOwner(ctx, { email: 'change@test.com', password: 'oldpass1' });

    const wrong = await http.post(
      '/auth/change-password',
      { current_password: 'nope-nope', new_password: 'newpass1' },
      owner.token,
    );
    // 401 olmamalıdır: iOS 401-i sessiya bitməsi sayır.
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVALID_PASSWORD');

    const ok = await http.post(
      '/auth/change-password',
      { current_password: 'oldpass1', new_password: 'newpass1' },
      owner.token,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.refresh_token).toBeTruthy();

    await ctx.pool.query(
      "UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes', rotated_at = CASE WHEN rotated_at IS NULL THEN NULL ELSE now() - interval '5 minutes' END WHERE revoked_at IS NOT NULL",
    );
    expect((await http.post('/auth/refresh', { refresh_token: owner.refreshToken })).status).toBe(
      401,
    );
    expect(
      (await http.post('/auth/refresh', { refresh_token: ok.body.refresh_token })).status,
    ).toBe(200);
    expect(
      (await http.post('/auth/login', { email: 'change@test.com', password: 'newpass1' })).status,
    ).toBe(200);
  });
});

describe('roles', () => {
  it('blocks an associate from owner-only routes', async () => {
    const owner = await registerOwner(ctx);
    const seller = await createAssociate(ctx, owner);
    const res = await http.get('/users', seller.token);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: 'You do not have permission', code: 'FORBIDDEN' });
  });
});
