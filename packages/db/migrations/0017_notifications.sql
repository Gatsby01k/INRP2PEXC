-- 0017 client notifications (Phase 7; ARCHITECTURE §3 `notifications`, UX_FLOWS §3 F1/F2).
-- The client's in-app inbox. Rows are written by the outbox handler from events the domain already emits, so a
-- notification can only exist because something really happened; nothing here decides anything.
--
-- A notification is a **pointer**, not a copy of the trade: it carries the reference a client already knows and
-- the few figures the message needs. It is client-facing text, so it must never carry route, margin, provider or
-- any other internal fact (SECURITY §5) — the check constraint below makes that a schema rule rather than a habit.

CREATE TABLE client_notification (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id      uuid NOT NULL REFERENCES client(id),
  -- Null means the whole client: every authorized user of that client sees it. A user id narrows it to one person.
  user_id        uuid REFERENCES auth_user(id),
  kind           text NOT NULL CHECK (kind IN (
                   'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED',
                   'PAYOUT_CONFIRMED', 'TRADE_COMPLETED', 'TRADE_CANCELLED', 'DESTINATION_ADDED', 'DESTINATION_ARCHIVED'
                 )),
  -- What the client sees. Plain text, already formatted for a person; no markup is rendered.
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body           text NOT NULL CHECK (length(body) BETWEEN 1 AND 400),
  -- The reference the client can act on: a quote ref, a trade ref. Never an internal id.
  subject_ref    text CHECK (subject_ref ~ '^[A-Z]{2}-[0-9]{6}-[0-9]{4}$'),
  -- Where the client product takes them. A relative path within the client app, never an absolute URL.
  href           text CHECK (href ~ '^/[A-Za-z0-9/_\-]{0,120}$'),
  -- The event that produced this row: one notification per event, so a redelivered outbox event is idempotent.
  -- Deliberately NOT a foreign key. The dispatcher holds `FOR UPDATE` on the event row while it runs handlers,
  -- and a foreign key here would make this insert wait for a key-share lock on that same row — the handler would
  -- block on the transaction that invoked it. The uniqueness is what this column is for; the outbox is
  -- append-only, so the reference cannot dangle in practice.
  outbox_event_id uuid NOT NULL UNIQUE,
  read_at        timestamptz,
  -- When the same message also went out by email. Null means it did not — either the kind does not warrant an
  -- email, or no email provider is configured (TD-04). The in-app inbox is the channel of record either way.
  email_sent_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT inrp2p_now(),
  -- No internal vocabulary in client-facing text (SECURITY §5). Cheap, and it fails at write time rather than in
  -- front of the client.
  CONSTRAINT client_notification_no_internal_terms CHECK (
    (title || ' ' || body) !~* '(route|margin|spread|provider|custody|dealer|obligation|liquidity|suspense)'
  )
);

CREATE INDEX client_notification_inbox ON client_notification (client_id, created_at DESC);
CREATE INDEX client_notification_unread ON client_notification (client_id) WHERE read_at IS NULL;

-- Everything but "I have read this" and "this also went out by email" is history: a notification says what
-- happened, and what happened does not change.
CREATE TRIGGER client_notification_immutable BEFORE UPDATE ON client_notification
  FOR EACH ROW EXECUTE FUNCTION inrp2p_guard_immutable_columns('read_at', 'email_sent_at');

CREATE TRIGGER client_notification_no_delete BEFORE DELETE OR TRUNCATE ON client_notification
  FOR EACH STATEMENT EXECUTE FUNCTION inrp2p_reject_mutation();

GRANT SELECT, INSERT ON client_notification TO inrp2p_app;
GRANT UPDATE (read_at, email_sent_at) ON client_notification TO inrp2p_app;
GRANT SELECT ON client_notification TO inrp2p_readonly;
