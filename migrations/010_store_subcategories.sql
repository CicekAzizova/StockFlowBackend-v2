-- Mağazanın işlətdiyi alt kateqoriyalar (kataloq kodları, məsələn food.dairy).
-- Boş siyahı "məhdudiyyət yoxdur" deməkdir: məhsul formasında seçilmiş əsas kateqoriyaların hamısı görünür.
ALTER TABLE stores ADD COLUMN subcategories TEXT[] NOT NULL DEFAULT '{}';
