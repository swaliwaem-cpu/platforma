FROM pgvector/pgvector:0.8.6-pg16-bookworm AS pgvector

FROM postgis/postgis:16-3.5

COPY --from=pgvector /usr/lib/postgresql/16/lib/vector.so /usr/lib/postgresql/16/lib/vector.so
COPY --from=pgvector /usr/share/postgresql/16/extension/vector* /usr/share/postgresql/16/extension/
