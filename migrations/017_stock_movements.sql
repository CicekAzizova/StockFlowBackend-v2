-- Məhsulun qalığındakı hər dəyişikliyin tarixçəsi (satış, qəbul, köçürmə, düzəliş).
CREATE TABLE stock_movements (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id            BIGINT      NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  product_id          BIGINT      NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  location_id         BIGINT      NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  type                TEXT        NOT NULL
                      CHECK (type IN ('initial', 'sale', 'restock', 'transfer_in', 'transfer_out', 'adjustment')),
  quantity_change     INTEGER     NOT NULL CHECK (quantity_change <> 0),
  -- Köhnə satış və köçürmələrdən köçürülən sətirlərdə məlum deyil.
  balance_after       INTEGER     CHECK (balance_after >= 0),
  user_id             BIGINT      REFERENCES users (id) ON DELETE SET NULL,
  sale_id             BIGINT      REFERENCES sales (id) ON DELETE SET NULL,
  transfer_id         BIGINT      REFERENCES stock_transfers (id) ON DELETE SET NULL,
  related_location_id BIGINT      REFERENCES locations (id) ON DELETE SET NULL,
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product_idx ON stock_movements (product_id, created_at DESC, id DESC);
CREATE INDEX stock_movements_location_idx ON stock_movements (location_id);

-- Mövcud satışlar tarixçəyə köçürülür.
INSERT INTO stock_movements (store_id, product_id, location_id, type, quantity_change,
                             user_id, sale_id, created_at)
SELECT s.store_id, si.product_id, s.location_id, 'sale', -si.quantity, s.sold_by, s.id, s.created_at
FROM sale_items si
JOIN sales s ON s.id = si.sale_id;

-- Mövcud köçürmələr: mənbədən çıxış və təyinata giriş.
INSERT INTO stock_movements (store_id, product_id, location_id, type, quantity_change,
                             user_id, transfer_id, related_location_id, created_at)
SELECT t.store_id, i.product_id, t.from_location_id, 'transfer_out', -i.quantity,
       t.created_by, t.id, t.to_location_id, t.created_at
FROM stock_transfer_items i
JOIN stock_transfers t ON t.id = i.transfer_id
WHERE i.product_id IS NOT NULL;

INSERT INTO stock_movements (store_id, product_id, location_id, type, quantity_change,
                             user_id, transfer_id, related_location_id, created_at)
SELECT t.store_id, i.product_id, t.to_location_id, 'transfer_in', i.quantity,
       t.created_by, t.id, t.from_location_id, t.created_at
FROM stock_transfer_items i
JOIN stock_transfers t ON t.id = i.transfer_id
WHERE i.product_id IS NOT NULL;
