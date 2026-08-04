-- Training V1 contained pilot-only data. The production owner explicitly
-- approved removing it before Training V2 is installed.
--
-- Keep this migration before the 20260801 Training V2 migrations so both an
-- existing production database and a clean database follow the same path:
-- create V1, remove only V1-owned objects, then create V2.

DO $$
DECLARE
  training_table RECORD;
BEGIN
  FOR training_table IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE 'training\_%' ESCAPE '\'
    ORDER BY tablename
  LOOP
    EXECUTE format(
      'DROP TABLE %I.%I CASCADE',
      training_table.schemaname,
      training_table.tablename
    );
  END LOOP;
END;
$$;

DO $$
DECLARE
  training_function RECORD;
BEGIN
  FOR training_function IN
    SELECT
      namespace.nspname AS schema_name,
      procedure.proname AS function_name,
      pg_get_function_identity_arguments(procedure.oid) AS identity_arguments
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname LIKE 'training\_%' ESCAPE '\'
    ORDER BY procedure.proname, procedure.oid
  LOOP
    EXECUTE format(
      'DROP FUNCTION %I.%I(%s) CASCADE',
      training_function.schema_name,
      training_function.function_name,
      training_function.identity_arguments
    );
  END LOOP;
END;
$$;

DO $$
DECLARE
  training_enum RECORD;
BEGIN
  FOR training_enum IN
    SELECT namespace.nspname AS schema_name, type.typname AS type_name
    FROM pg_type AS type
    JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'public'
      AND type.typtype = 'e'
      AND type.typname LIKE 'training\_%' ESCAPE '\'
    ORDER BY type.typname
  LOOP
    EXECUTE format(
      'DROP TYPE %I.%I CASCADE',
      training_enum.schema_name,
      training_enum.type_name
    );
  END LOOP;
END;
$$;
