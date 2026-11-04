-- Satıcının son aktivlik vaxtı. "Onlayn" = son 5 dəqiqə ərzində aktiv.
ALTER TABLE users ADD COLUMN last_active_at TIMESTAMPTZ;
