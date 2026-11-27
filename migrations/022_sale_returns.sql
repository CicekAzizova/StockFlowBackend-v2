-- Qaytarma: qəbzin bir hissəsi və ya hamısı geri qaytarıla bilər.
-- Gəlir və qazanc hesabatları dəyişməsin deyə, qaytarılan məbləğ satışın özündə saxlanılır:
-- sales.returned_amount və sale_items.returned_* sütunları hesabat sorğularında çıxılır.
ALTER TABLE sales ADD COLUMN returned_amount NUMERIC(12,2) NOT NULL DEFAULT 0
  CHECK (returned_amount >= 0);
ALTER TABLE sale_items ADD COLUMN returned_quantity INTEGER NOT NULL DEFAULT 0
  CHECK (returned_quantity >= 0);
ALTER TABLE sale_items ADD COLUMN returned_amount NUMERIC(12,2) NOT NULL DEFAULT 0
  CHECK (returned_amount >= 0);

CREATE TABLE sale_returns (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id     BIGINT        NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  sale_id      BIGINT        NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  location_id  BIGINT        NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  created_by   BIGINT        NOT NULL REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED,
  reason       TEXT          NOT NULL
               CHECK (reason IN ('damaged', 'customer_declined', 'wrong_item', 'other')),
  -- Zədəli mal rəfə qayıtmır: onda qalıq dəyişmir.
  restocked    BOOLEAN       NOT NULL DEFAULT true,
  total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
  note         TEXT,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX sale_returns_sale_idx ON sale_returns (sale_id);
CREATE INDEX sale_returns_store_created_idx ON sale_returns (store_id, created_at DESC);

CREATE TABLE sale_return_items (
  id           BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id    BIGINT        NOT NULL REFERENCES sale_returns (id) ON DELETE CASCADE,
  sale_item_id BIGINT        NOT NULL REFERENCES sale_items (id) ON DELETE CASCADE,
  product_id   BIGINT        NOT NULL REFERENCES products (id) DEFERRABLE INITIALLY DEFERRED,
  quantity     INTEGER       NOT NULL CHECK (quantity > 0),
  line_total   NUMERIC(12,2) NOT NULL CHECK (line_total >= 0)
);
CREATE INDEX sale_return_items_return_idx ON sale_return_items (return_id);

-- Qalığa qayıdan mal tarixçədə ayrıca növ kimi görünür.
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_type_check
  CHECK (type IN ('initial', 'sale', 'restock', 'transfer_in', 'transfer_out', 'adjustment',
                  'return'));
