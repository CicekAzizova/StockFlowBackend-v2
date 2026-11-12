-- Mağaza istədiyi qədər əsas kateqoriya seçə bilər (yalnız ən azı biri məcburidir).
ALTER TABLE stores DROP CONSTRAINT stores_main_categories_chk;
ALTER TABLE stores ADD CONSTRAINT stores_main_categories_chk CHECK (cardinality(main_categories) >= 1);
