-- Mağazanın öz alt kateqoriyaları: [{ "code": "food.c_ab12cd34", "main": "food", "name": "Qəhvə" }].
-- Kod sabit qalır, ad dəyişə bilər. Ad bir dildədir (kataloqdakılar kimi tərcümə olunmur).
ALTER TABLE stores ADD COLUMN custom_subcategories JSONB NOT NULL DEFAULT '[]';
