-- Applied by installQueue() after graphile-worker's own migrations. Idempotent.
-- The queue schema is owned by inrp2p_worker (graphile-worker protects its private tables with
-- row-level security that only the owner bypasses). The app role gets exactly one enqueue
-- capability and has no privileges on the queue schema itself. The migrator must be a member of
-- inrp2p_worker to run future graphile-worker upgrades.
CREATE OR REPLACE FUNCTION inrp2p_enqueue_outbox_dispatch() RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT graphile_worker.add_job(
    identifier   => 'outbox_dispatch',
    payload      => '{}'::json,
    job_key      => 'outbox_dispatch',
    job_key_mode => 'preserve_run_at',
    max_attempts => 25
  );
$$;

DO $$
DECLARE
  r record;
BEGIN
  EXECUTE 'ALTER SCHEMA graphile_worker OWNER TO inrp2p_worker';
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'graphile_worker' AND c.relkind IN ('r', 'p', 'v', 'm')  -- owned sequences follow their table
    LOOP
    IF r.relkind IN ('v') THEN
      EXECUTE format('ALTER VIEW graphile_worker.%I OWNER TO inrp2p_worker', r.relname);
    ELSE
      EXECUTE format('ALTER TABLE graphile_worker.%I OWNER TO inrp2p_worker', r.relname);
    END IF;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'graphile_worker' LOOP
    IF r.prokind = 'p' THEN
      EXECUTE format('ALTER PROCEDURE %s OWNER TO inrp2p_worker', r.sig);
    ELSE
      EXECUTE format('ALTER FUNCTION %s OWNER TO inrp2p_worker', r.sig);
    END IF;
  END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'graphile_worker' AND t.typtype IN ('c', 'e', 'd') AND t.typrelid = 0 LOOP
    EXECUTE format('ALTER TYPE graphile_worker.%I OWNER TO inrp2p_worker', r.typname);
  END LOOP;
END
$$;

ALTER FUNCTION inrp2p_enqueue_outbox_dispatch() OWNER TO inrp2p_worker;
REVOKE ALL ON FUNCTION inrp2p_enqueue_outbox_dispatch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inrp2p_enqueue_outbox_dispatch() TO inrp2p_app;
REVOKE ALL ON SCHEMA graphile_worker FROM PUBLIC;
