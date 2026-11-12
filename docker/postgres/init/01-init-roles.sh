#!/bin/sh
set -e

echo "[init-roles] Configuring least-privilege PostgreSQL roles for ${POSTGRES_DB}..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- 1. Create dedicated DDL migration owner role (no superuser, no bypassrls)
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_MIGRATOR_USER}') THEN
      CREATE ROLE ${DB_MIGRATOR_USER} WITH
        LOGIN
        PASSWORD '${DB_MIGRATOR_PASSWORD}'
        NOSUPERUSER
        NOCREATEDB
        NOCREATEROLE
        NOBYPASSRLS;
    END IF;
  END
  \$\$;

  -- 2. Create restricted runtime application role (MUST NOT own tables or have BYPASSRLS)
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_APP_USER}') THEN
      CREATE ROLE ${DB_APP_USER} WITH
        LOGIN
        PASSWORD '${DB_APP_PASSWORD}'
        NOSUPERUSER
        NOCREATEDB
        NOCREATEROLE
        NOBYPASSRLS
        NOINHERIT;
    END IF;
  END
  \$\$;

  -- 3. Lock down public schema creation and transfer schema DDL control to migrator
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${DB_MIGRATOR_USER}, ${DB_APP_USER};
  GRANT USAGE, CREATE ON SCHEMA public TO ${DB_MIGRATOR_USER};
  GRANT USAGE ON SCHEMA public TO ${DB_APP_USER};

  -- Pre-install safe extensions as superuser so ft360_migrator never needs superuser rights
  CREATE EXTENSION IF NOT EXISTS citext;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS btree_gist;
EOSQL

echo "[init-roles] Role separation complete: ${DB_MIGRATOR_USER} (DDL owner) / ${DB_APP_USER} (DML runtime, NOBYPASSRLS)."

