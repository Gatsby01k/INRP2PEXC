-- 0012 business clock and rate-limit counters (ARCHITECTURE §4 "Time", SECURITY §7).

-- Every business time decision in Phase 3+ (quote expiry, OTP expiry, request TTL) reads inrp2p_now().
-- In deployed databases it is exactly statement_timestamp(). Test databases can pin it with the session
-- setting `inrp2p.clock_override`, which is honoured ONLY when the table `inrp2p_test_clock_permit` exists.
-- No migration creates that table; the integration-test template creates it (test/global-setup.ts).
CREATE FUNCTION inrp2p_now() RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE
  override text;
BEGIN
  override := current_setting('inrp2p.clock_override', true);
  IF override IS NOT NULL AND override <> '' AND to_regclass('public.inrp2p_test_clock_permit') IS NOT NULL THEN
    RETURN override::timestamptz;
  END IF;
  RETURN statement_timestamp();
END
$$;
GRANT EXECUTE ON FUNCTION inrp2p_now() TO inrp2p_app, inrp2p_readonly;

-- Fixed-window counters for public endpoints (link open, OTP send, accept/reject attempts). Keys are hashed
-- (never raw IPs or tokens). Rows are short-lived; the worker prunes expired windows.
CREATE TABLE rate_limit_counter (
  bucket       text NOT NULL CHECK (bucket ~ '^[a-z_]+:[0-9a-f]{64}$'),
  window_start timestamptz NOT NULL,
  hits         integer NOT NULL CHECK (hits >= 0),
  PRIMARY KEY (bucket, window_start)
);
GRANT SELECT, INSERT, UPDATE (hits) ON rate_limit_counter TO inrp2p_app;
GRANT DELETE ON rate_limit_counter TO inrp2p_worker;
