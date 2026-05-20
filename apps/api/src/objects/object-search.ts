import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

type ObjectSearchClient = Pick<PrismaService, '$queryRaw'>;

export function normalizeObjectSearchTerm(value: string) {
  return value.replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function findCatalogSearchObjectIds(client: ObjectSearchClient, search: string) {
  const normalizedSearch = normalizeObjectSearchTerm(search);

  if (!normalizedSearch) {
    return [];
  }

  const pattern = `%${escapeLikePattern(normalizedSearch)}%`;
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT o.id::text AS id
    FROM real_estate_objects o
    LEFT JOIN developers d ON d.id = o.developer_id
    WHERE o.deleted_at IS NULL
      AND (
        replace(lower(coalesce(o.title, '')), '.', '') LIKE ${pattern} ESCAPE '\\'
        OR replace(lower(coalesce(d.name, '')), '.', '') LIKE ${pattern} ESCAPE '\\'
        OR replace(lower(coalesce(o.address, '')), '.', '') LIKE ${pattern} ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM locations pl
          WHERE pl.id = o.primary_location_id
            AND pl.type::text = 'district'
            AND replace(lower(coalesce(pl.name, '')), '.', '') LIKE ${pattern} ESCAPE '\\'
        )
        OR EXISTS (
          SELECT 1
          FROM object_locations ol
          JOIN locations l ON l.id = ol.location_id
          WHERE ol.object_id = o.id
            AND l.type::text = 'district'
            AND replace(lower(coalesce(l.name, '')), '.', '') LIKE ${pattern} ESCAPE '\\'
        )
      )
  `);

  return rows.map((row) => row.id);
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}
