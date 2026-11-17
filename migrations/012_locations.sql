-- Məkanlar: mağazanın satış nöqtələri (store) və anbarları (warehouse).
-- Hər mağazada tam bir "əsas" məkan var (həmişə növü store). Satış yalnız mağaza növlü məkanlarda olur.
CREATE TABLE locations (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id   BIGINT      NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  kind       TEXT        NOT NULL DEFAULT 'store' CHECK (kind IN ('store', 'warehouse')),
  address    TEXT        NOT NULL DEFAULT '',
  is_main    BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT locations_main_is_store_chk CHECK (NOT is_main OR kind = 'store')
);
CREATE UNIQUE INDEX locations_store_name_uq ON locations (store_id, lower(name));
CREATE UNIQUE INDEX locations_one_main_uq ON locations (store_id) WHERE is_main;
CREATE INDEX locations_store_idx ON locations (store_id, id);

-- Mövcud hər mağaza üçün əsas məkan yaranır.
INSERT INTO locations (store_id, name, kind, address, is_main)
SELECT id, name, 'store', address, true FROM stores;
