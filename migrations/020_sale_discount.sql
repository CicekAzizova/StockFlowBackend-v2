-- Kassirin satış zamanı əl ilə verdiyi ümumi endirim (məbləğ, mağaza valyutasında).
-- Məhsulun öz endirimi (products.discount, faiz) bundan ayrıdır və qiymətə artıq daxildir.
-- total_price endirimdən sonrakı yekun məbləğdir; endirim sale_items.line_total-lara paylanır
-- ki, hesabatlardakı gəlir və qazanc düzgün qalsın.
ALTER TABLE sales ADD COLUMN discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0
  CHECK (discount_amount >= 0);
