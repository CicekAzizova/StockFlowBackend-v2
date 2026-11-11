-- Mağazanın ölkəsi (ISO 3166-1 alpha-2, məsələn AZ), şəhəri və qeydiyyat sehrbazının (wizard) vəziyyəti.
-- Köhnə mağazalar artıq hazırdır (onboarding_completed = true); yeni qeydiyyatda backend false yazır.
ALTER TABLE stores
  ADD COLUMN country TEXT CONSTRAINT stores_country_chk CHECK (country ~ '^[A-Z]{2}$'),
  ADD COLUMN city TEXT NOT NULL DEFAULT '',
  ADD COLUMN onboarding_completed BOOLEAN NOT NULL DEFAULT true;
