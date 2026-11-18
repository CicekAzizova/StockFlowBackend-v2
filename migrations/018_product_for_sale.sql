-- Məhsulu silmədən satışdan müvəqqəti çıxarmaq üçün.
ALTER TABLE products ADD COLUMN for_sale BOOLEAN NOT NULL DEFAULT TRUE;
