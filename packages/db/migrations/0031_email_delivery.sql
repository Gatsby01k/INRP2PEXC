-- 0031 one row per client notification email, per recipient (production task E1, TD-04).
--
-- The email channel claimed `client_notification.email_sent_at` before it sent anything, so a provider failure after
-- the claim read as "sent" — a delivery success that never happened. Each recipient now has its own delivery row:
-- PENDING until the provider accepts it (its message id recorded), FAILED when the provider refuses it or the
-- attempts run out. The row id is the provider's idempotency key, so a retried send after a crash or an ambiguous
-- answer is the same email, never a second one. `email_sent_at` is now written only when every recipient has it.
--
-- No message body is stored here — the text is the inbox row's — and no provider response beyond its id and an
-- error code. 0001–0030 are not edited.

CREATE TABLE client_notification_email (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  notification_id     uuid NOT NULL REFERENCES client_notification (id),
  user_id             uuid NOT NULL REFERENCES auth_user (id),
  -- The verified address at the time it was queued: where this email went, even if the person changes it later.
  address             text NOT NULL CHECK (length(address) BETWEEN 3 AND 320),
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  provider_message_id text CHECK (length(provider_message_id) <= 200),
  -- A code only (`PROVIDER_TIMEOUT`, `PROVIDER_REJECTED_422`…): never the body, the address or a provider payload.
  last_error          text CHECK (last_error ~ '^[A-Z0-9_]{1,80}$'),
  created_at          timestamptz NOT NULL DEFAULT inrp2p_now(),
  sent_at             timestamptz,
  failed_at           timestamptz,
  UNIQUE (notification_id, user_id),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL AND provider_message_id IS NOT NULL)),
  CHECK ((status = 'FAILED') = (failed_at IS NOT NULL AND last_error IS NOT NULL))
);
CREATE INDEX client_notification_email_open_idx ON client_notification_email (status, created_at) WHERE status <> 'SENT';
CREATE TRIGGER client_notification_email_status BEFORE UPDATE ON client_notification_email
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_status_transition('status', 'PENDING>SENT,PENDING>FAILED');
CREATE TRIGGER client_notification_email_immutable BEFORE UPDATE ON client_notification_email
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('status', 'attempts', 'provider_message_id', 'last_error', 'sent_at', 'failed_at');
CREATE TRIGGER client_notification_email_no_delete BEFORE DELETE OR TRUNCATE ON client_notification_email
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

GRANT SELECT, INSERT ON client_notification_email TO inrp2p_app;
GRANT UPDATE (status, attempts, provider_message_id, last_error, sent_at, failed_at) ON client_notification_email TO inrp2p_app;
GRANT SELECT ON client_notification_email TO inrp2p_readonly;
