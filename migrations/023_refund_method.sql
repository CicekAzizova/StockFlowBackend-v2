-- Pulun necə qaytarıldığı: gün sonunda kassadakı nağd düz çıxsın deyə lazımdır.
ALTER TABLE sale_returns ADD COLUMN refund_method TEXT NOT NULL DEFAULT 'cash'
  CHECK (refund_method IN ('cash', 'card', 'transfer', 'other'));

-- Köhnə qaytarmalar: satış tək üsulla ödənilibsə, pul da həmin üsulla qaytarılmış sayılır.
UPDATE sale_returns r SET refund_method = s.payment_method
FROM sales s
WHERE s.id = r.sale_id AND s.payment_method <> 'mixed';
