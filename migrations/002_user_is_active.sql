-- Satıcını silmədən deaktiv etmək: hesab və satış tarixçəsi qalır, giriş bağlanır.
ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
