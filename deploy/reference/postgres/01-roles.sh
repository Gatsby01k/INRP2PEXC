#!/bin/sh
# REFERENCE ONLY — the database layout a deployment needs, for a local reference stack (docs/DEPLOYMENT.md §Database).
# A managed PostgreSQL 18 does the same through its own console; passwords come from the platform's secret manager.
#
#   inrp2p_migrator        owns the schema; runs migrations; never used by web or worker
#   inrp2p_app_login       the web app        (member of inrp2p_app)
#   inrp2p_worker_login    the worker         (member of inrp2p_worker, which includes inrp2p_app)
#   inrp2p_readonly_login  reporting / audit  (member of inrp2p_readonly)
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE inrp2p_app NOLOGIN;
CREATE ROLE inrp2p_worker NOLOGIN;
CREATE ROLE inrp2p_readonly NOLOGIN;
GRANT inrp2p_app TO inrp2p_worker;
CREATE ROLE inrp2p_migrator LOGIN PASSWORD '${INRP2P_MIGRATOR_PASSWORD}';
-- The migrator grants the group roles their privileges and installs the queue schema for the worker role.
GRANT inrp2p_app TO inrp2p_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT inrp2p_readonly TO inrp2p_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT inrp2p_worker TO inrp2p_migrator WITH ADMIN TRUE;
CREATE ROLE inrp2p_app_login LOGIN PASSWORD '${INRP2P_APP_PASSWORD}' IN ROLE inrp2p_app;
CREATE ROLE inrp2p_worker_login LOGIN PASSWORD '${INRP2P_WORKER_PASSWORD}' IN ROLE inrp2p_worker;
CREATE ROLE inrp2p_readonly_login LOGIN PASSWORD '${INRP2P_READONLY_PASSWORD}' IN ROLE inrp2p_readonly;
CREATE DATABASE inrp2p OWNER inrp2p_migrator;
SQL
