-- Alış qiyməti məlum olmaya bilər: NULL = "məlum deyil", 0 isə həqiqətən pulsuz alış deməkdir.
-- Əvvəl boş buraxılanda 0 saxlanırdı və qazanc yalan çıxırdı.
ALTER TABLE products ALTER COLUMN cost_price DROP NOT NULL;
ALTER TABLE products ALTER COLUMN cost_price DROP DEFAULT;
UPDATE products SET cost_price = NULL WHERE cost_price = 0;

-- Satış anındakı alış qiyməti (bir vahid üçün). Sonradan məhsulun alış qiyməti dəyişsə,
-- köhnə satışların qazancı dəyişməsin. NULL = o vaxt məlum deyildi.
ALTER TABLE sale_items ADD COLUMN unit_cost NUMERIC(12,2) CHECK (unit_cost >= 0);

-- Köhnə satışlar üçün ən yaxşı təxmin: məhsulun hazırkı alış qiyməti (məlumdursa).
UPDATE sale_items si SET unit_cost = p.cost_price
FROM products p
WHERE p.id = si.product_id AND p.cost_price IS NOT NULL;
