-- Məkanlar arası mal köçürməsi (məs. anbardan mağazaya) və onun tarixçəsi.
CREATE TABLE stock_transfers (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id         BIGINT      NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  from_location_id BIGINT      NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  to_location_id   BIGINT      NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  created_by       BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_transfers_different_chk CHECK (from_location_id <> to_location_id)
);
CREATE INDEX stock_transfers_store_idx ON stock_transfers (store_id, created_at DESC, id DESC);
CREATE INDEX stock_transfers_from_idx ON stock_transfers (from_location_id);
CREATE INDEX stock_transfers_to_idx ON stock_transfers (to_location_id);

-- Məhsulun adı və SKU-su köçürmə anında saxlanır (məhsul sonradan silinsə də tarixçə qalsın).
CREATE TABLE stock_transfer_items (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  BIGINT  NOT NULL REFERENCES stock_transfers (id) ON DELETE CASCADE,
  product_id   BIGINT  REFERENCES products (id) ON DELETE SET NULL,
  product_name TEXT    NOT NULL,
  sku          TEXT    NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE INDEX stock_transfer_items_transfer_idx ON stock_transfer_items (transfer_id);
