-- 0019 manual bank statement import (Phase 8; SECURITY §5 S7 "reconciliation against bank statements").
--
-- S7 is the fake-UTR risk: a trade marked paid when the bank never moved the money. Uniqueness, evidence and
-- step-up make that hard to do by accident; only the bank's own statement makes it hard to do on purpose. V1
-- imports the statement by hand, because there is no bank API yet — and a hand-imported file is still the
-- independent record the ledger gets checked against.
--
-- The import is evidence, so it is immutable: the file's own hash, its period, and every line as it was read.
-- Re-importing the same file for the same account and period is refused rather than merged, so two people
-- working the same morning cannot double-count a statement.

CREATE TABLE bank_statement_import (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  inr_account_id uuid NOT NULL REFERENCES inr_settlement_account (id),
  -- Inclusive IST day bounds the statement covers. Reconciliation only claims anything inside them.
  period_from    date NOT NULL,
  period_to      date NOT NULL CHECK (period_to >= period_from),
  filename       text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  -- sha256 of the uploaded bytes: the same file imported twice is the same evidence, not new evidence.
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  line_count     integer NOT NULL CHECK (line_count >= 0),
  matched        integer NOT NULL CHECK (matched >= 0),
  mismatched     integer NOT NULL CHECK (mismatched >= 0),
  unrecorded     integer NOT NULL CHECK (unrecorded >= 0),
  /** Recorded payments in the period that the statement does not show at all — the S7 case. */
  missing        integer NOT NULL CHECK (missing >= 0),
  imported_by    text NOT NULL,
  imported_at    timestamptz NOT NULL DEFAULT inrp2p_now(),
  UNIQUE (inr_account_id, sha256)
);

CREATE INDEX bank_statement_import_account_idx ON bank_statement_import (inr_account_id, period_from);

CREATE TABLE bank_statement_line (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  import_id      uuid NOT NULL REFERENCES bank_statement_import (id),
  seq            integer NOT NULL CHECK (seq >= 1),
  value_date     date NOT NULL,
  direction      text NOT NULL CHECK (direction IN ('CREDIT', 'DEBIT')),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  -- The bank's own reference for the line. Matched against `fiat_transfer.utr`, which is unique.
  reference      text NOT NULL CHECK (length(reference) BETWEEN 1 AND 40),
  description    text CHECK (length(description) <= 300),
  -- What this line turned out to be. Decided once, at import, from the rows as they stood.
  outcome        text NOT NULL CHECK (outcome IN ('MATCHED', 'MISMATCHED', 'UNRECORDED')),
  fiat_transfer_id uuid REFERENCES fiat_transfer (id),
  CHECK ((outcome = 'UNRECORDED') = (fiat_transfer_id IS NULL)),
  UNIQUE (import_id, seq)
);

CREATE INDEX bank_statement_line_import_idx ON bank_statement_line (import_id, seq);
CREATE INDEX bank_statement_line_reference_idx ON bank_statement_line (reference);

-- Evidence is not edited. A corrected statement is a new import of the corrected file.
CREATE TRIGGER bank_statement_import_immutable BEFORE UPDATE ON bank_statement_import
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns();
CREATE TRIGGER bank_statement_import_no_delete BEFORE DELETE OR TRUNCATE ON bank_statement_import
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TRIGGER bank_statement_line_immutable BEFORE UPDATE ON bank_statement_line
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns();
CREATE TRIGGER bank_statement_line_no_delete BEFORE DELETE OR TRUNCATE ON bank_statement_line
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

GRANT SELECT, INSERT ON bank_statement_import, bank_statement_line TO inrp2p_app;
GRANT SELECT ON bank_statement_import, bank_statement_line TO inrp2p_readonly;
