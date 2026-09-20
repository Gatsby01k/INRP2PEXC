-- 0018 settlement receipts (Phase 8; DOMAIN_MODEL §2.8 `receipt`, ARCHITECTURE §2, FI-43, D-09).
--
-- A receipt is the exchange's written answer to "what happened to my money". It is generated once, when a trade
-- completes, from the rows as they stood at that moment — and from then on the **snapshot is the receipt**.
-- Every artifact a person can download (JSON, CSV, PDF) is a pure function of `snapshot_json`, so a receipt
-- regenerated a year later is the same document, byte for byte, even if the trade's neighbouring rows have
-- since been corrected, adjusted or archived. That is the whole point: a receipt that could change is not
-- evidence of anything.
--
-- What is stored is therefore the snapshot and the hashes of what it produces, not the artifacts themselves.
-- V1 has no object store; `*_key` are here because the domain model names them and stay null until one exists.
-- The hash is what proves a regenerated artifact is the same artifact, and it is checked on every regeneration.

CREATE TABLE receipt (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  trade_id       uuid NOT NULL REFERENCES trade (id),
  -- Bumped only if a receipt is ever reissued (a corrected trade). Each version keeps its own immutable snapshot,
  -- so a superseded receipt stays readable exactly as it was sent.
  version        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- The immutable record. Client-safe by construction: no route, margin, payer or provider fact is ever in it
  -- (SECURITY §5, S14), and the application asserts that before writing.
  snapshot_json  jsonb NOT NULL,
  -- sha256 over the canonical JSON bytes — sorted keys, no whitespace, decimal strings, never a float.
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Hashes of the artifacts the snapshot produces, so "regenerated" and "the same" are the same question.
  json_sha256    text NOT NULL CHECK (json_sha256 ~ '^[0-9a-f]{64}$'),
  csv_sha256     text NOT NULL CHECK (csv_sha256 ~ '^[0-9a-f]{64}$'),
  html_sha256    text NOT NULL CHECK (html_sha256 ~ '^[0-9a-f]{64}$'),
  json_key       text,
  csv_key        text,
  pdf_key        text,
  generated_at   timestamptz NOT NULL DEFAULT inrp2p_now(),
  generated_by   text NOT NULL,
  -- One receipt per trade per version; the outbox is at-least-once, and a redelivery must not issue a second.
  UNIQUE (trade_id, version)
);

CREATE INDEX receipt_trade_idx ON receipt (trade_id);

-- Immutable in every column. A receipt is not a row that gets corrected; a correction is a new version.
CREATE TRIGGER receipt_immutable BEFORE UPDATE ON receipt
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns();

CREATE TRIGGER receipt_no_delete BEFORE DELETE OR TRUNCATE ON receipt
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

GRANT SELECT, INSERT ON receipt TO inrp2p_app;
GRANT SELECT ON receipt TO inrp2p_readonly;
