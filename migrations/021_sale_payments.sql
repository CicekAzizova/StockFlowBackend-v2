-- Satış bir neçə üsulla ödənə bilər (məs. 20 nağd + 30 kart). Hər üsul üzrə məbləğ burada saxlanır.
-- sales.payment_method qalır: bir üsul varsa həmin üsul, birdən çoxdursa 'mixed'.
ALTER TABLE sales DROP CONSTRAINT sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check
  CHECK (payment_method IN ('cash', 'card', 'transfer', 'other', 'mixed'));

CREATE TABLE sale_payments (
  sale_id BIGINT        NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  method  TEXT          NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'other')),
  amount  NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (sale_id, method)
);

-- Köhnə satışlar: bütün məbləğ onların tək ödəniş üsulu ilə ödənilib.
INSERT INTO sale_payments (sale_id, method, amount)
SELECT id, payment_method, total_price FROM sales WHERE total_price > 0;
