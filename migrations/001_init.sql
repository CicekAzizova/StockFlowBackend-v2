-- StockFlow ilkin sxem.
-- Qaydalar: pul və say sahələrində CHECK, məhsul silinməsi yumşaqdır (deleted_at),
-- bütün mağaza məlumatı stores(id) üzrə izolyasiya olunur.

-- =====================================================================
-- İstifadəçilər. OWNER mağazalara stores.owner_id ilə bağlanır (store_id boşdur),
-- SALES_ASSOCIATE isə tək mağazaya (store_id) aiddir.
-- =====================================================================
CREATE TABLE users (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role              TEXT        NOT NULL CHECK (role IN ('OWNER', 'SALES_ASSOCIATE')),
  name              TEXT        NOT NULL,
  surname           TEXT        NOT NULL DEFAULT '',
  email             TEXT        NOT NULL CHECK (email = lower(email)),
  phone             TEXT        NOT NULL DEFAULT '',
  fin               TEXT,
  password_hash     TEXT        NOT NULL,
  store_id          BIGINT,
  avatar_url        TEXT,
  locale            TEXT        NOT NULL DEFAULT 'az' CHECK (locale IN ('az', 'en', 'ru')),
  email_verified_at TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_role_store_chk CHECK (
    (role = 'OWNER' AND store_id IS NULL) OR (role = 'SALES_ASSOCIATE' AND store_id IS NOT NULL)
  )
);

-- Silinmiş (anonimləşdirilmiş) hesablar email və FIN-i azad edir.
CREATE UNIQUE INDEX users_email_active_uq ON users (email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_fin_active_uq ON users (fin)
  WHERE fin IS NOT NULL AND deleted_at IS NULL;

-- =====================================================================
-- Mağazalar (filiallar). Bir sahibin bir neçə mağazası ola bilər.
-- =====================================================================
CREATE TABLE stores (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id        BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  address         TEXT        NOT NULL DEFAULT '',
  phone           TEXT        NOT NULL DEFAULT '',
  timezone        TEXT        NOT NULL DEFAULT 'Asia/Baku',
  last_receipt_no INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stores_owner_idx ON stores (owner_id);

ALTER TABLE users
  ADD CONSTRAINT users_store_fk FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE;
CREATE INDEX users_store_idx ON users (store_id) WHERE store_id IS NOT NULL;

-- =====================================================================
-- Kateqoriyalar (mağaza üzrə, böyük-kiçik hərfə həssas deyil)
-- =====================================================================
CREATE TABLE categories (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id   BIGINT      NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_store_name_uq ON categories (store_id, lower(name));

-- =====================================================================
-- Məhsullar
-- =====================================================================
CREATE TABLE products (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id        BIGINT        NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  category_id     BIGINT        REFERENCES categories (id) ON DELETE SET NULL,
  name            TEXT          NOT NULL,
  sku             TEXT          NOT NULL,
  description     TEXT          NOT NULL DEFAULT '',
  price           NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  discount        NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (discount >= 0 AND discount <= 100),
  cost_price      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  quantity        INTEGER       NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  low_stock_limit INTEGER       NOT NULL DEFAULT 5 CHECK (low_stock_limit >= 0),
  image_urls      TEXT[]        NOT NULL DEFAULT '{}',
  weight          NUMERIC(10,3) CHECK (weight >= 0),
  weight_unit     TEXT          CHECK (weight_unit IN ('mg', 'g', 'kg', 'ml', 'l')),
  size            TEXT,
  created_by      BIGINT        REFERENCES users (id) ON DELETE SET NULL,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- SKU mağaza daxilində unikaldır; silinmiş məhsulun SKU-su təkrar istifadə oluna bilər.
CREATE UNIQUE INDEX products_store_sku_uq ON products (store_id, lower(sku))
  WHERE deleted_at IS NULL;
CREATE INDEX products_store_list_idx ON products (store_id, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX products_low_stock_idx ON products (store_id, quantity)
  WHERE deleted_at IS NULL AND quantity <= low_stock_limit;
CREATE INDEX products_category_idx ON products (category_id) WHERE category_id IS NOT NULL;

-- =====================================================================
-- Satışlar (qəbz) və qəbzdəki sətirlər
-- =====================================================================
CREATE TABLE sales (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id       BIGINT        NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  receipt_no     INTEGER       NOT NULL,
  sold_by        BIGINT        NOT NULL REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED,
  payment_method TEXT          NOT NULL DEFAULT 'cash'
                 CHECK (payment_method IN ('cash', 'card', 'transfer', 'other')),
  total_price    NUMERIC(12,2) NOT NULL CHECK (total_price >= 0),
  note           TEXT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT sales_store_receipt_uq UNIQUE (store_id, receipt_no)
);
CREATE INDEX sales_store_created_idx ON sales (store_id, created_at DESC);
CREATE INDEX sales_seller_created_idx ON sales (sold_by, created_at DESC);

-- Ad, SKU və qiymət satış anında kopyalanır: sonradan məhsul dəyişsə qəbz dəyişmir.
CREATE TABLE sale_items (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id      BIGINT        NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  product_id   BIGINT        NOT NULL REFERENCES products (id) DEFERRABLE INITIALLY DEFERRED,
  product_name TEXT          NOT NULL,
  sku          TEXT          NOT NULL,
  quantity     INTEGER       NOT NULL CHECK (quantity > 0),
  unit_price   NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  line_total   NUMERIC(12,2) NOT NULL CHECK (line_total >= 0)
);
CREATE INDEX sale_items_sale_idx ON sale_items (sale_id);
CREATE INDEX sale_items_product_idx ON sale_items (product_id);

-- =====================================================================
-- Sessiyalar: refresh token-lər (yalnız hash saxlanılır) və birdəfəlik kodlar
-- =====================================================================
CREATE TABLE refresh_tokens (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id  UUID        NOT NULL,
  token_hash TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  -- Yalnız normal rotasiya zamanı doldurulur; qısa "grace" pəncərəsi yalnız bunun üçündür.
  rotated_at TIMESTAMPTZ,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens (expires_at);

CREATE TABLE one_time_codes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     TEXT        NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  code_hash   TEXT        NOT NULL,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX one_time_codes_lookup_idx ON one_time_codes (user_id, purpose, created_at DESC);

-- =====================================================================
-- Abunəlik (sahib üzrə). product_limit boşdursa limit yoxdur.
-- =====================================================================
CREATE TABLE subscriptions (
  owner_id                       BIGINT      PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  plan                           TEXT        NOT NULL DEFAULT 'free',
  status                         TEXT        NOT NULL DEFAULT 'active',
  product_limit                  INTEGER     CHECK (product_limit > 0),
  current_period_end             TIMESTAMPTZ,
  apple_original_transaction_id  TEXT        UNIQUE,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);
