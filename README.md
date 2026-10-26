# StockFlow Backend

Anbar və satış tətbiqi StockFlow üçün API. TypeScript, Fastify 5, PostgreSQL.
Heç nə diskdə saxlanmır: məlumat PostgreSQL-də, şəkillər S3 uyğun anbardadır (Cloudflare R2 və s.).

Canlı sənəd (Swagger): `/api-docs`

## Lokal işə salma

```bash
cp .env.example .env            # JWT_SECRET-i dəyişin
docker compose up -d postgres   # və ya lokal PostgreSQL
npm install
npm run dev                     # migrasiyalar başlanğıcda avtomatik tətbiq olunur
npm run seed                    # istəyə bağlı: demo@stockflow.app / demo1234
```

## Əmrlər

| Əmr                                     | Nə edir                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| `npm run dev`                           | Faylı dəyişəndə yenidən başlayır                               |
| `npm test`                              | Real PostgreSQL ilə inteqrasiya testləri (`TEST_DATABASE_URL`) |
| `npm run lint` / `format` / `typecheck` | Kod keyfiyyəti                                                 |
| `npm run build` / `npm start`           | İstehsal                                                       |
| `npm run migrate`                       | Migrasiyaları əl ilə tətbiq edir                               |

## Mühit dəyişənləri

Bütün dəyişənlər `.env.example`-da izah olunub və başlanğıcda yoxlanılır; səhv olsa server açılmır.
İstehsalda məcburi: `DATABASE_URL`, `JWT_SECRET` (≥32 simvol), `STORAGE_DRIVER=s3` + `S3_*`, `MAIL_DRIVER=resend` + `RESEND_API_KEY`.

## Yerləşdirmə

1. **Baza**: Neon (pulsuz plan) və ya Railway/Render PostgreSQL. `DATABASE_URL`-i verin.
2. **Şəkillər**: Cloudflare R2 bucket yaradın, `S3_*` və ictimai ünvanı (`S3_PUBLIC_URL`) yazın.
3. **Server**: Railway, Render və ya Fly.io. Repo-nu bağlayın, `Dockerfile` avtomatik istifadə olunur. Region: Avropa (Frankfurt).
4. Şəbəkə arxasında olduğu üçün `trustProxy` aktivdir; HTTPS platforma tərəfindən verilir.
5. Yoxlama: `GET /health` (canlı), `GET /health/ready` (bazaya qoşulub).

Migrasiyalar server açılanda `schema_migrations` cədvəli və advisory lock ilə tətbiq olunur (bir neçə nüsxə eyni anda açılsa da təhlükəsizdir). Söndürmək üçün `RUN_MIGRATIONS_ON_START=false` və `npm run migrate:prod` istifadə edin.

## Memarlıq

`routes → service → repository`. Hər modul `src/modules/<ad>` altındadır. Sorğular zod ilə yoxlanılır və eyni sxemlərdən OpenAPI yaranır.
Xəta formatı: `{ message, code, details?, request_id? }`.

Auth: qısa ömürlü access JWT + dönən refresh token (oğurluq aşkarlanması), e-poçt təsdiqi və şifrə sıfırlama üçün 6 rəqəmli kod.
Stok azalması atomikdir (`UPDATE ... WHERE quantity >= n`), paralel satışlarda mənfi stok olmur.

## Bilinən məhdudiyyətlər

- `Dockerfile` bu mühitdə build olunub yoxlanmayıb (docker yox idi); ilk deploy zamanı logları izləyin.
- Resend poçt göndərişi canlı sınanmayıb.
- Eski SQLite məlumatı köçürülmür (yalnız demo seed var).
