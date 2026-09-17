-- 0013 trade requests, quotes, quote links, acceptance challenges, OTP deliveries
-- (DOMAIN_MODEL §2.5, STATE_MACHINES §1, §2, §12, FI-02..FI-07, D-01, D-15).

CREATE SEQUENCE trade_request_ref_seq;
CREATE SEQUENCE quote_ref_seq;

CREATE TABLE trade_request (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                   text NOT NULL UNIQUE DEFAULT ('RQ-' || to_char((inrp2p_now() AT TIME ZONE 'Asia/Kolkata'), 'YYMMDD') || '-' || lpad(nextval('trade_request_ref_seq')::text, 4, '0')),
  client_id             uuid NOT NULL REFERENCES client (id),
  direction             text NOT NULL CHECK (direction IN ('SELL_USDT', 'BUY_USDT')),
  fixed_side            text NOT NULL CHECK (fixed_side IN ('BASE', 'QUOTE')),
  requested_base_minor  bigint CHECK (requested_base_minor > 0),
  requested_quote_minor bigint CHECK (requested_quote_minor > 0),
  target_rate_micro     bigint CHECK (target_rate_micro > 0),
  bank_account_id       uuid REFERENCES bank_account (id),
  crypto_wallet_id      uuid REFERENCES crypto_wallet (id),
  source_wallet_id      uuid REFERENCES crypto_wallet (id),
  network               text NOT NULL DEFAULT 'TRON' CHECK (network IN ('TRON')),
  channel               text NOT NULL CHECK (channel IN ('CLIENT_APP', 'OPERATOR', 'LINK')),
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'QUOTED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED')),
  status_reason         text CHECK (length(status_reason) <= 500),
  assigned_dealer_id    uuid REFERENCES auth_user (id),
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT inrp2p_now(),
  last_activity_at      timestamptz NOT NULL DEFAULT inrp2p_now(),
  closed_at             timestamptz,
  version               integer NOT NULL DEFAULT 1,
  CHECK ((fixed_side = 'BASE') = (requested_base_minor IS NOT NULL AND requested_quote_minor IS NULL)),
  CHECK ((fixed_side = 'QUOTE') = (requested_quote_minor IS NOT NULL AND requested_base_minor IS NULL)),
  -- SELL pays INR to a bank account; BUY delivers USDT to a wallet (DOMAIN_MODEL §2.5).
  CHECK ((direction = 'SELL_USDT' AND bank_account_id IS NOT NULL AND crypto_wallet_id IS NULL)
      OR (direction = 'BUY_USDT' AND crypto_wallet_id IS NOT NULL AND bank_account_id IS NULL AND source_wallet_id IS NULL)),
  CHECK ((status IN ('ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED')) = (closed_at IS NOT NULL))
);
CREATE INDEX trade_request_client_idx ON trade_request (client_id, created_at DESC);
CREATE INDEX trade_request_open_idx ON trade_request (last_activity_at) WHERE status = 'OPEN';
CREATE TRIGGER trade_request_status BEFORE UPDATE ON trade_request
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'OPEN>QUOTED,QUOTED>OPEN,QUOTED>ACCEPTED,OPEN>DECLINED,QUOTED>DECLINED,OPEN>WITHDRAWN,QUOTED>WITHDRAWN,OPEN>EXPIRED');
CREATE TRIGGER trade_request_immutable BEFORE UPDATE ON trade_request
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'status_reason', 'assigned_dealer_id', 'last_activity_at', 'closed_at', 'version');

CREATE TABLE quote (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  ref                     text NOT NULL UNIQUE DEFAULT ('QT-' || to_char((inrp2p_now() AT TIME ZONE 'Asia/Kolkata'), 'YYMMDD') || '-' || lpad(nextval('quote_ref_seq')::text, 4, '0')),
  trade_request_id        uuid NOT NULL REFERENCES trade_request (id),
  client_id               uuid NOT NULL REFERENCES client (id),
  direction               text NOT NULL CHECK (direction IN ('SELL_USDT', 'BUY_USDT')),
  fixed_side              text NOT NULL CHECK (fixed_side IN ('BASE', 'QUOTE')),
  base_minor              bigint NOT NULL CHECK (base_minor > 0),
  quote_inr_minor         bigint NOT NULL CHECK (quote_inr_minor > 0),
  client_rate_micro       bigint NOT NULL CHECK (client_rate_micro > 0),
  route_rate_micro        bigint NOT NULL CHECK (route_rate_micro > 0),
  route_rate_snapshot_id  uuid NOT NULL REFERENCES rate_snapshot (id),
  route_id                uuid NOT NULL REFERENCES liquidity_route (id),
  route_value_inr_minor   bigint NOT NULL CHECK (route_value_inr_minor > 0),
  gross_margin_inr_minor  bigint NOT NULL,
  network                 text NOT NULL CHECK (network IN ('TRON')),
  bank_account_id         uuid REFERENCES bank_account (id),
  crypto_wallet_id        uuid REFERENCES crypto_wallet (id),
  valid_for_seconds       integer NOT NULL CHECK (valid_for_seconds BETWEEN 30 AND 1800),
  sent_at                 timestamptz,
  expires_at              timestamptz,
  status                  text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT', 'ACCEPTED', 'EXPIRED', 'REJECTED', 'CANCELLED')),
  cancel_reason           text CHECK (cancel_reason IN ('SUPERSEDED', 'DECLINED_BY_DESK', 'WITHDRAWN', 'OPERATOR', 'DISCARDED')),
  is_counter              boolean NOT NULL,
  negative_margin_reason  text CHECK (length(negative_margin_reason) BETWEEN 1 AND 500),
  created_by              text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT inrp2p_now(),
  sent_by                 text,
  accepted_by_user_id     uuid REFERENCES auth_user (id),
  accepted_via            text CHECK (accepted_via IN ('APP', 'LINK')),
  acceptance_challenge_id uuid UNIQUE,
  accepted_at             timestamptz,
  rejected_by_user_id     uuid REFERENCES auth_user (id),
  rejected_via            text CHECK (rejected_via IN ('APP', 'LINK')),
  rejected_at             timestamptz,
  closed_at               timestamptz,
  -- FI-02: margin is derived and consistent with the stored amounts, per direction.
  CONSTRAINT quote_margin_derived CHECK (
    (direction = 'SELL_USDT' AND gross_margin_inr_minor = route_value_inr_minor - quote_inr_minor)
    OR (direction = 'BUY_USDT' AND gross_margin_inr_minor = quote_inr_minor - route_value_inr_minor)),
  CHECK ((direction = 'SELL_USDT' AND bank_account_id IS NOT NULL AND crypto_wallet_id IS NULL)
      OR (direction = 'BUY_USDT' AND crypto_wallet_id IS NOT NULL AND bank_account_id IS NULL)),
  CHECK (gross_margin_inr_minor >= 0 OR negative_margin_reason IS NOT NULL),
  CHECK ((status = 'DRAFT') = (sent_at IS NULL AND expires_at IS NULL) OR status = 'CANCELLED'),
  CHECK (sent_at IS NULL OR expires_at = sent_at + make_interval(secs => valid_for_seconds)),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL)),
  CHECK ((status = 'ACCEPTED') = (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL AND accepted_via IS NOT NULL)),
  CHECK ((status = 'REJECTED') = (rejected_at IS NOT NULL AND rejected_by_user_id IS NOT NULL AND rejected_via IS NOT NULL)),
  -- FI-07: a LINK acceptance or rejection always records the consumed challenge.
  CONSTRAINT quote_link_decision_has_challenge CHECK (
    (coalesce(accepted_via, '') <> 'LINK' AND coalesce(rejected_via, '') <> 'LINK') OR acceptance_challenge_id IS NOT NULL),
  CHECK ((status IN ('ACCEPTED', 'EXPIRED', 'REJECTED', 'CANCELLED')) = (closed_at IS NOT NULL))
);
CREATE INDEX quote_request_idx ON quote (trade_request_id, created_at DESC);
CREATE INDEX quote_sent_expiry_idx ON quote (expires_at) WHERE status = 'SENT';
-- FI-06: at most one live quote per request. FI-05: at most one accepted quote per request.
CREATE UNIQUE INDEX quote_one_sent_per_request ON quote (trade_request_id) WHERE status = 'SENT';
CREATE UNIQUE INDEX quote_one_accepted_per_request ON quote (trade_request_id) WHERE status = 'ACCEPTED';
CREATE TRIGGER quote_status BEFORE UPDATE ON quote
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'DRAFT>SENT,DRAFT>CANCELLED,SENT>ACCEPTED,SENT>REJECTED,SENT>EXPIRED,SENT>CANCELLED');
-- FI-03: economic columns never change. Only lifecycle columns may be written.
CREATE TRIGGER quote_economics_immutable BEFORE UPDATE ON quote
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'cancel_reason', 'sent_at', 'expires_at', 'sent_by', 'accepted_by_user_id', 'accepted_via', 'acceptance_challenge_id', 'accepted_at', 'rejected_by_user_id', 'rejected_via', 'rejected_at', 'closed_at');
CREATE FUNCTION inrp2p_guard_quote_send_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sent_at IS NOT NULL AND (NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
    RAISE EXCEPTION 'quote % expiry is fixed once sent', OLD.id USING ERRCODE = 'IX041';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quote_send_once BEFORE UPDATE ON quote
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_quote_send_once();

-- View-only shareable token (SECURITY §2.3). Only the SHA-256 of the token is stored.
CREATE TABLE quote_link (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  quote_id        uuid NOT NULL UNIQUE REFERENCES quote (id),
  token_hash      text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT inrp2p_now(),
  first_opened_at timestamptz,
  open_count      integer NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  revoked_at      timestamptz,
  revoked_by      text,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE TRIGGER quote_link_immutable BEFORE UPDATE ON quote_link
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('first_opened_at', 'open_count', 'revoked_at', 'revoked_by');

-- Quote-bound OTP challenge: an INRP2P domain primitive, not Better Auth (D-01, D-06).
CREATE TABLE acceptance_challenge (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  quote_id           uuid NOT NULL REFERENCES quote (id),
  quote_link_id      uuid NOT NULL REFERENCES quote_link (id),
  client_user_id     uuid NOT NULL REFERENCES client_user (id),
  channel            text NOT NULL DEFAULT 'EMAIL' CHECK (channel IN ('EMAIL')),
  destination_masked text NOT NULL CHECK (length(destination_masked) BETWEEN 3 AND 254),
  code_hash          text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  code_salt          text NOT NULL CHECK (code_salt ~ '^[0-9a-f]{32}$'),
  expires_at         timestamptz NOT NULL,
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       integer NOT NULL DEFAULT 5 CHECK (max_attempts = 5),
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONSUMED', 'FAILED', 'EXPIRED', 'SUPERSEDED')),
  consumed_for       text CHECK (consumed_for IN ('ACCEPT', 'REJECT')),
  sent_at            timestamptz NOT NULL DEFAULT inrp2p_now(),
  consumed_at        timestamptz,
  closed_at          timestamptz,
  ip_hash            text CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  CHECK (attempts <= max_attempts),
  CHECK (expires_at > sent_at AND expires_at <= sent_at + interval '5 minutes'),
  CHECK ((status = 'CONSUMED') = (consumed_at IS NOT NULL AND consumed_for IS NOT NULL)),
  CHECK ((status = 'PENDING') = (closed_at IS NULL)),
  CHECK (status <> 'FAILED' OR attempts = max_attempts)
);
CREATE UNIQUE INDEX acceptance_challenge_one_pending ON acceptance_challenge (quote_id, client_user_id) WHERE status = 'PENDING';
CREATE INDEX acceptance_challenge_quote_sent_idx ON acceptance_challenge (quote_id, sent_at);
CREATE TRIGGER acceptance_challenge_status BEFORE UPDATE ON acceptance_challenge
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'PENDING>CONSUMED,PENDING>FAILED,PENDING>EXPIRED,PENDING>SUPERSEDED');
CREATE TRIGGER acceptance_challenge_immutable BEFORE UPDATE ON acceptance_challenge
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('attempts', 'status', 'consumed_for', 'consumed_at', 'closed_at');
CREATE FUNCTION inrp2p_guard_challenge_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'acceptance challenge % is % and final', OLD.id, OLD.status USING ERRCODE = 'IX040';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'challenge attempts cannot decrease' USING ERRCODE = 'IX041';
  END IF;
  -- A challenge is a quote-expiry-bounded credential: its expiry must never exceed the quote's.
  RETURN NEW;
END
$$;
CREATE TRIGGER acceptance_challenge_final BEFORE UPDATE ON acceptance_challenge
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_challenge_final();
CREATE FUNCTION inrp2p_guard_challenge_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q quote%ROWTYPE;
BEGIN
  SELECT * INTO q FROM quote WHERE id = NEW.quote_id;
  IF q.status <> 'SENT' THEN
    RAISE EXCEPTION 'challenge requires a SENT quote' USING ERRCODE = 'IX044';
  END IF;
  IF NEW.expires_at > q.expires_at THEN
    RAISE EXCEPTION 'challenge expiry % exceeds quote expiry %', NEW.expires_at, q.expires_at USING ERRCODE = 'IX044';
  END IF;
  IF (SELECT quote_id FROM quote_link WHERE id = NEW.quote_link_id) <> NEW.quote_id THEN
    RAISE EXCEPTION 'challenge link belongs to another quote' USING ERRCODE = 'IX044';
  END IF;
  IF (SELECT client_id FROM client_user WHERE id = NEW.client_user_id) <> q.client_id THEN
    RAISE EXCEPTION 'challenge recipient is not a user of the quote client' USING ERRCODE = 'IX044';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER acceptance_challenge_insert BEFORE INSERT ON acceptance_challenge
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_challenge_insert();
CREATE TRIGGER acceptance_challenge_no_delete BEFORE DELETE OR TRUNCATE ON acceptance_challenge
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

ALTER TABLE quote ADD CONSTRAINT quote_acceptance_challenge_fk FOREIGN KEY (acceptance_challenge_id) REFERENCES acceptance_challenge (id);
-- The challenge recorded on a quote must be CONSUMED for that same quote.
CREATE FUNCTION inrp2p_check_quote_challenge() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c acceptance_challenge%ROWTYPE;
BEGIN
  IF NEW.acceptance_challenge_id IS NOT NULL THEN
    SELECT * INTO c FROM acceptance_challenge WHERE id = NEW.acceptance_challenge_id;
    IF c.quote_id <> NEW.id OR c.status <> 'CONSUMED'
       OR (NEW.status = 'ACCEPTED' AND c.consumed_for <> 'ACCEPT') OR (NEW.status = 'REJECTED' AND c.consumed_for <> 'REJECT') THEN
      RAISE EXCEPTION 'quote % references challenge % that was not consumed for this decision', NEW.id, c.id USING ERRCODE = 'IX044';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER quote_challenge_consistent AFTER INSERT OR UPDATE ON quote
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inrp2p_check_quote_challenge();

-- The OTP code must reach the email channel but never the outbox payload, logs or audit (SECURITY §2.3).
-- It is envelope-encrypted here, bound to the challenge, and erased when delivered or when the challenge closes.
CREATE TABLE otp_delivery (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  challenge_id  uuid NOT NULL UNIQUE REFERENCES acceptance_challenge (id),
  code_sealed   inrp2p_sealed,
  created_at    timestamptz NOT NULL DEFAULT inrp2p_now(),
  delivered_at  timestamptz,
  provider_message_id text CHECK (length(provider_message_id) <= 200),
  erased_reason text CHECK (erased_reason IN ('DELIVERED', 'CHALLENGE_CLOSED')),
  CHECK ((code_sealed IS NULL) = (erased_reason IS NOT NULL)),
  CHECK (delivered_at IS NULL OR erased_reason = 'DELIVERED')
);
CREATE FUNCTION inrp2p_guard_otp_delivery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.challenge_id <> OLD.challenge_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'otp delivery identity is immutable' USING ERRCODE = 'IX041';
  END IF;
  IF OLD.code_sealed IS NULL AND NEW.code_sealed IS NOT NULL THEN
    RAISE EXCEPTION 'an erased OTP code cannot be restored' USING ERRCODE = 'IX041';
  END IF;
  IF OLD.code_sealed IS NOT NULL AND NEW.code_sealed IS NOT NULL AND NEW.code_sealed <> OLD.code_sealed THEN
    RAISE EXCEPTION 'OTP code cannot be replaced' USING ERRCODE = 'IX041';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER otp_delivery_guard BEFORE UPDATE ON otp_delivery
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_otp_delivery();
CREATE TRIGGER otp_delivery_no_delete BEFORE DELETE OR TRUNCATE ON otp_delivery
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

GRANT USAGE ON SEQUENCE trade_request_ref_seq, quote_ref_seq TO inrp2p_app;
GRANT SELECT, INSERT ON trade_request, quote, quote_link, acceptance_challenge, otp_delivery TO inrp2p_app;
GRANT UPDATE (status, status_reason, assigned_dealer_id, last_activity_at, closed_at, version) ON trade_request TO inrp2p_app;
GRANT UPDATE (status, cancel_reason, sent_at, expires_at, sent_by, accepted_by_user_id, accepted_via, acceptance_challenge_id, accepted_at, rejected_by_user_id, rejected_via, rejected_at, closed_at) ON quote TO inrp2p_app;
GRANT UPDATE (first_opened_at, open_count, revoked_at, revoked_by) ON quote_link TO inrp2p_app;
GRANT UPDATE (attempts, status, consumed_for, consumed_at, closed_at) ON acceptance_challenge TO inrp2p_app;
GRANT UPDATE (code_sealed, delivered_at, provider_message_id, erased_reason) ON otp_delivery TO inrp2p_app;
GRANT SELECT ON trade_request, quote TO inrp2p_readonly;
GRANT SELECT (id, quote_id, created_by, created_at, first_opened_at, open_count, revoked_at, revoked_by) ON quote_link TO inrp2p_readonly;
GRANT SELECT (id, challenge_id, created_at, delivered_at, erased_reason) ON otp_delivery TO inrp2p_readonly;
GRANT SELECT (id, quote_id, quote_link_id, client_user_id, channel, destination_masked, expires_at, attempts, max_attempts, status, consumed_for, sent_at, consumed_at, closed_at) ON acceptance_challenge TO inrp2p_readonly;
