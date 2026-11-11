-- Tətbiqdə Türkçe də var: istifadəçi dili üçün 'tr' icazə verilir.
ALTER TABLE users DROP CONSTRAINT users_locale_check;
ALTER TABLE users ADD CONSTRAINT users_locale_check CHECK (locale IN ('az', 'en', 'ru', 'tr'));
