-- Satıcının işlədiyi məkan. NULL: mağazanın əsas məkanı.
ALTER TABLE users
  ADD COLUMN location_id BIGINT REFERENCES locations (id) ON DELETE SET NULL;
CREATE INDEX users_location_idx ON users (location_id) WHERE location_id IS NOT NULL;
