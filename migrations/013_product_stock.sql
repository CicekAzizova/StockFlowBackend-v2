-- Qalıq artıq məhsulun özündə yox, məkan üzrə saxlanılır.
CREATE TABLE product_stock (
  product_id  BIGINT      NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  location_id BIGINT      NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  quantity    INTEGER     NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, location_id)
);
CREATE INDEX product_stock_location_idx ON product_stock (location_id);

-- Mövcud qalıqlar mağazanın əsas məkanına köçürülür.
INSERT INTO product_stock (product_id, location_id, quantity)
SELECT p.id, l.id, p.quantity
FROM products p
JOIN locations l ON l.store_id = p.store_id AND l.is_main
WHERE p.quantity > 0;

-- Satış hansı məkandan edilib. Köhnə satışlar əsas məkana yazılır.
ALTER TABLE sales ADD COLUMN location_id BIGINT REFERENCES locations (id) ON DELETE RESTRICT;
UPDATE sales s SET location_id = l.id FROM locations l WHERE l.store_id = s.store_id AND l.is_main;
ALTER TABLE sales ALTER COLUMN location_id SET NOT NULL;
CREATE INDEX sales_location_idx ON sales (location_id, created_at DESC);

DROP INDEX IF EXISTS products_low_stock_idx;
ALTER TABLE products DROP COLUMN quantity;
