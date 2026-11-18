-- Satış vahidi: ədəd, kq, litr və ya paket.
ALTER TABLE products
  ADD COLUMN unit TEXT NOT NULL DEFAULT 'piece'
  CHECK (unit IN ('piece', 'kg', 'l', 'pack'));
