-- 0020 reference numbers keep every digit of their sequence number.
--
-- Every human reference (CL-, RQ-, QT-, IX-, RO-, EX-, RS-, AJ-) was built as lpad(nextval(...)::text, n, '0').
-- lpad does not only pad: it also truncates a longer string to n characters. From the 10,000th client, request,
-- quote or trade (the 1,000,000th obligation, case, route settlement or adjustment) the number lost its last digit,
-- so 10000..10009 all became "1000": the second insert in each block of ten hit the UNIQUE constraint on `ref`
-- and failed — a client could not be onboarded, a quote could not be created, an acceptance rolled back. For
-- clients (no date prefix) client 10000 collided with client 1000 forever.
--
-- The widths stay as they were, as a minimum: existing references do not change, and new ones simply grow a digit
-- when the sequence needs one.

CREATE FUNCTION inrp2p_ref_number(n bigint, min_width integer) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT lpad(n::text, greatest(min_width, length(n::text)), '0')
$$;
GRANT EXECUTE ON FUNCTION inrp2p_ref_number(bigint, integer) TO inrp2p_app, inrp2p_readonly;

ALTER TABLE client ALTER COLUMN ref SET DEFAULT ('CL-' || inrp2p_ref_number(nextval('client_ref_seq'), 4));
ALTER TABLE trade_request ALTER COLUMN ref SET DEFAULT
  ('RQ-' || to_char((inrp2p_now() AT TIME ZONE 'Asia/Kolkata'), 'YYMMDD') || '-' || inrp2p_ref_number(nextval('trade_request_ref_seq'), 4));
ALTER TABLE quote ALTER COLUMN ref SET DEFAULT
  ('QT-' || to_char((inrp2p_now() AT TIME ZONE 'Asia/Kolkata'), 'YYMMDD') || '-' || inrp2p_ref_number(nextval('quote_ref_seq'), 4));
ALTER TABLE trade ALTER COLUMN ref SET DEFAULT
  ('IX-' || to_char((inrp2p_now() AT TIME ZONE 'Asia/Kolkata'), 'YYMMDD') || '-' || inrp2p_ref_number(nextval('trade_ref_seq'), 4));
ALTER TABLE route_obligation ALTER COLUMN ref SET DEFAULT ('RO-' || inrp2p_ref_number(nextval('route_obligation_ref_seq'), 6));
ALTER TABLE exception_case ALTER COLUMN ref SET DEFAULT ('EX-' || inrp2p_ref_number(nextval('exception_case_ref_seq'), 6));
ALTER TABLE route_settlement ALTER COLUMN ref SET DEFAULT ('RS-' || inrp2p_ref_number(nextval('route_settlement_ref_seq'), 6));
ALTER TABLE financial_adjustment ALTER COLUMN ref SET DEFAULT ('AJ-' || inrp2p_ref_number(nextval('financial_adjustment_ref_seq'), 6));
