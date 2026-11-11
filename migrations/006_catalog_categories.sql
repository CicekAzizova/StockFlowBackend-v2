-- Mağazanın əsas kateqoriyaları (kataloq kodları, 1-5 ədəd). Köhnə mağazalar "other" olur.
ALTER TABLE stores
  ADD COLUMN main_categories TEXT[] NOT NULL DEFAULT '{other}'
  CONSTRAINT stores_main_categories_chk CHECK (cardinality(main_categories) BETWEEN 1 AND 5);

-- Məhsulun alt kateqoriyası (kataloq kodu, məsələn food.dairy). Tətbiq mağazanın kateqoriyalarına aid olmasını yoxlayır.
ALTER TABLE products ADD COLUMN subcategory TEXT;
