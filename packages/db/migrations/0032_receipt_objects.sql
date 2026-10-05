-- 0032 a receipt's artifacts stored in private object storage (production task E2, TD-12).
--
-- A receipt was proved by hash and re-rendered on every request; nothing was stored. Where a deployment configures a
-- receipts bucket, each artifact is now written once at issue, at a key that names its own content
-- (`receipts/{trade}/v{version}/{sha256}.{ext}`), and recorded here: which object it is, the sha256 of the stored bytes,
-- and which issued document it is. JSON, CSV and HTML are byte-for-byte the issued artifacts, so their stored hash *is*
-- the recorded hash. A PDF is printed from the HTML and its bytes carry print metadata, so it records both: the hash of
-- its own bytes (what a reader verifies) and the HTML hash it was printed from (what it means).
--
-- The `receipt` row stays as issued (every column immutable); `json_key`/`csv_key`/`pdf_key` there remain unused.
-- Error code IX097 belongs to this migration. 0001–0031 are not edited.

CREATE TABLE receipt_object (
  receipt_id    uuid NOT NULL REFERENCES receipt (id),
  format        text NOT NULL CHECK (format IN ('json', 'csv', 'html', 'pdf')),
  bucket        text NOT NULL CHECK (bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
  object_key    text NOT NULL,
  version_id    text CHECK (length(version_id) <= 1024),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size     bigint NOT NULL CHECK (byte_size > 0),
  retain_until  timestamptz,
  stored_at     timestamptz NOT NULL DEFAULT inrp2p_now(),
  PRIMARY KEY (receipt_id, format),
  -- Content-addressed: the key ends in the stored bytes' own hash and the format.
  CHECK (object_key ~ '^receipts/[0-9a-f-]{36}/v[0-9]+/[0-9a-f]{64}\.(json|csv|html|pdf)$' AND object_key LIKE '%/' || sha256 || '.' || format)
);

CREATE FUNCTION inrp2p_guard_receipt_object() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r receipt%ROWTYPE;
  issued text;
BEGIN
  SELECT * INTO r FROM receipt WHERE id = NEW.receipt_id;
  -- The key names this receipt's trade and version.
  IF NEW.object_key NOT LIKE 'receipts/' || r.trade_id::text || '/v' || r.version::text || '/%' THEN
    RAISE EXCEPTION 'receipt object % is not under its receipt''s trade and version', NEW.object_key USING ERRCODE = 'IX097';
  END IF;
  IF NEW.format = 'json' THEN
    issued := r.json_sha256;
  ELSIF NEW.format = 'csv' THEN
    issued := r.csv_sha256;
  ELSE
    issued := r.html_sha256;
  END IF;
  -- JSON, CSV and HTML are the issued bytes themselves; a PDF means the HTML it was printed from.
  IF NEW.source_sha256 <> issued OR (NEW.format <> 'pdf' AND NEW.sha256 <> issued) THEN
    RAISE EXCEPTION 'receipt object % is not the issued % artifact', NEW.object_key, NEW.format USING ERRCODE = 'IX097';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER receipt_object_guard BEFORE INSERT ON receipt_object
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_receipt_object();
CREATE TRIGGER receipt_object_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON receipt_object
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

GRANT SELECT, INSERT ON receipt_object TO inrp2p_app;
GRANT SELECT ON receipt_object TO inrp2p_readonly;
