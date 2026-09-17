-- 0004 double-entry ledger (FINANCIAL_INVARIANTS §3, FI-40..FI-44).
CREATE TABLE ledger_account (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  code       text NOT NULL CHECK (code ~ '^(ASSET|LIAB|REVENUE|EXPENSE|SUSPENSE):[A-Z][A-Z0-9_]*(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$'),
  type       text NOT NULL CHECK (type IN ('ASSET', 'LIAB', 'REVENUE', 'EXPENSE', 'SUSPENSE')),
  currency   text NOT NULL REFERENCES currency (code),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (code, currency),
  UNIQUE (id, currency),
  CHECK (split_part(code, ':', 1) = type)
);
CREATE TRIGGER ledger_account_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger_account
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

CREATE TABLE ledger_journal (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  -- e.g. trade:{uuid}:accept · fiat:{uuid}:confirm · crypto:{uuid}:confirm · adj:{uuid}
  posting_key         text NOT NULL UNIQUE CHECK (posting_key ~ '^[a-z][a-z_]*:[0-9A-Za-z-]+(:[a-z][a-z_]*)?$'),
  event_type          text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  trade_id            uuid,
  correlation_id      text NOT NULL,
  idempotency_key     text NOT NULL,
  posted_by           text NOT NULL,
  posted_at           timestamptz NOT NULL DEFAULT statement_timestamp(),
  reverses_journal_id uuid UNIQUE REFERENCES ledger_journal (id),
  created_txid        xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CHECK (reverses_journal_id IS DISTINCT FROM id)
);
CREATE INDEX ledger_journal_trade_idx ON ledger_journal (trade_id);

CREATE TABLE ledger_entry (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id          uuid NOT NULL REFERENCES ledger_journal (id),
  account_id          uuid NOT NULL,
  currency            text NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('DR', 'CR')),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  trade_id            uuid,
  route_obligation_id uuid,
  FOREIGN KEY (account_id, currency) REFERENCES ledger_account (id, currency)
);
CREATE INDEX ledger_entry_journal_idx ON ledger_entry (journal_id);
CREATE INDEX ledger_entry_account_idx ON ledger_entry (account_id);
CREATE INDEX ledger_entry_trade_idx ON ledger_entry (trade_id);
CREATE INDEX ledger_entry_route_obligation_idx ON ledger_entry (route_obligation_id);

-- Entries may only be written by the transaction that created their journal, so a journal
-- can never be extended after it was validated at commit.
CREATE FUNCTION inrp2p_ledger_entry_same_tx() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  j_txid xid8;
BEGIN
  SELECT created_txid INTO j_txid FROM ledger_journal WHERE id = NEW.journal_id;
  IF j_txid IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'ledger entries can only be added in the transaction that created journal %', NEW.journal_id
      USING ERRCODE = 'IX010';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ledger_entry_same_tx BEFORE INSERT ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION inrp2p_ledger_entry_same_tx();

-- Balanced per currency, at least two entries, and reversals must exactly mirror the original.
CREATE FUNCTION inrp2p_ledger_journal_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  n_entries bigint;
  unbalanced text;
  orig_reverses uuid;
  mismatch bigint;
BEGIN
  SELECT count(*) INTO n_entries FROM ledger_entry WHERE journal_id = NEW.id;
  IF n_entries < 2 THEN
    RAISE EXCEPTION 'journal % (%) must have at least two entries', NEW.id, NEW.posting_key USING ERRCODE = 'IX011';
  END IF;

  SELECT string_agg(currency, ',') INTO unbalanced FROM (
    SELECT currency
    FROM ledger_entry WHERE journal_id = NEW.id
    GROUP BY currency
    HAVING sum(CASE direction WHEN 'DR' THEN amount_minor ELSE 0 END)
        <> sum(CASE direction WHEN 'CR' THEN amount_minor ELSE 0 END)
  ) u;
  IF unbalanced IS NOT NULL THEN
    RAISE EXCEPTION 'journal % (%) is unbalanced in %', NEW.id, NEW.posting_key, unbalanced USING ERRCODE = 'IX012';
  END IF;

  IF NEW.reverses_journal_id IS NOT NULL THEN
    SELECT reverses_journal_id INTO orig_reverses FROM ledger_journal WHERE id = NEW.reverses_journal_id;
    IF orig_reverses IS NOT NULL THEN
      RAISE EXCEPTION 'journal % is itself a reversal and cannot be reversed', NEW.reverses_journal_id USING ERRCODE = 'IX013';
    END IF;
    SELECT count(*) INTO mismatch FROM (
      (SELECT account_id, currency, CASE direction WHEN 'DR' THEN 'CR' ELSE 'DR' END AS direction, amount_minor, trade_id, route_obligation_id
         FROM ledger_entry WHERE journal_id = NEW.reverses_journal_id
       EXCEPT ALL
       SELECT account_id, currency, direction, amount_minor, trade_id, route_obligation_id
         FROM ledger_entry WHERE journal_id = NEW.id)
      UNION ALL
      (SELECT account_id, currency, direction, amount_minor, trade_id, route_obligation_id
         FROM ledger_entry WHERE journal_id = NEW.id
       EXCEPT ALL
       SELECT account_id, currency, CASE direction WHEN 'DR' THEN 'CR' ELSE 'DR' END, amount_minor, trade_id, route_obligation_id
         FROM ledger_entry WHERE journal_id = NEW.reverses_journal_id)
    ) d;
    IF mismatch <> 0 THEN
      RAISE EXCEPTION 'reversal journal % does not exactly mirror journal %', NEW.id, NEW.reverses_journal_id USING ERRCODE = 'IX014';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER ledger_journal_balanced
  AFTER INSERT ON ledger_journal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inrp2p_ledger_journal_check();

CREATE TRIGGER ledger_journal_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger_journal
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();
CREATE TRIGGER ledger_entry_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

-- Balance views. Sign convention: DR positive, CR negative.
CREATE VIEW ledger_account_balance AS
  SELECT a.id AS account_id, a.code, a.type, a.currency,
         coalesce(sum(CASE e.direction WHEN 'DR' THEN e.amount_minor ELSE -e.amount_minor END), 0)::numeric(38, 0) AS dr_minus_cr_minor
  FROM ledger_account a
  LEFT JOIN ledger_entry e ON e.account_id = a.id
  GROUP BY a.id, a.code, a.type, a.currency;

-- FI-44: must always be empty.
CREATE VIEW ledger_global_imbalance AS
  SELECT currency,
         sum(CASE direction WHEN 'DR' THEN amount_minor ELSE -amount_minor END)::numeric(38, 0) AS dr_minus_cr_minor
  FROM ledger_entry
  GROUP BY currency
  HAVING sum(CASE direction WHEN 'DR' THEN amount_minor ELSE -amount_minor END) <> 0;

GRANT SELECT, INSERT ON ledger_account, ledger_journal, ledger_entry TO inrp2p_app;
GRANT SELECT ON ledger_account_balance, ledger_global_imbalance TO inrp2p_app;
GRANT SELECT ON ledger_account, ledger_journal, ledger_entry, ledger_account_balance, ledger_global_imbalance TO inrp2p_readonly;
