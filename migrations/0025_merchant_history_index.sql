-- Keep Jev's last-five merchant history indexed without limiting it by age.
CREATE INDEX transactions_merchant_history
  ON transactions(COALESCE(NULLIF(merchant_name, ''), raw_name), date DESC, id DESC);
