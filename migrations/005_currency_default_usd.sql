-- Standart valyuta USD olur. 004-dən sonra heç kim valyuta seçməyib, ona görə mövcud mağazalar da USD-yə keçir.
ALTER TABLE stores ALTER COLUMN currency SET DEFAULT 'USD';
UPDATE stores SET currency = 'USD' WHERE currency = 'AZN';
