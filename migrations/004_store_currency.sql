-- Mağazanın valyutası (ISO 4217 kodu). Owner seçir, mağazanın bütün istifadəçiləri eyni valyutanı görür.
-- Dəstəklənən siyahı tətbiq səviyyəsində yoxlanılır (users.schemas.ts), ona görə yeni valyuta əlavə etmək üçün miqrasiya lazım deyil.
ALTER TABLE stores
  ADD COLUMN currency TEXT NOT NULL DEFAULT 'AZN'
  CONSTRAINT stores_currency_chk CHECK (currency ~ '^[A-Z]{3}$');
