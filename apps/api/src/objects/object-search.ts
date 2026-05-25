import { createSearchVariants, normalizeSearchText } from '@platforma/shared/search-normalization';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

type ObjectSearchClient = Pick<PrismaService, '$queryRaw'>;

export function normalizeObjectSearchTerm(value: string) {
  return normalizeSearchText(value);
}

export async function findCatalogSearchObjectIds(client: ObjectSearchClient, search: string) {
  const patterns = createSearchVariants(search).map((variant) => `%${escapeLikePattern(variant)}%`);

  if (patterns.length === 0) {
    return [];
  }

  const titleSearch = createLikeSearchCondition(Prisma.sql`replace(lower(coalesce(o.title, '')), '.', '')`, patterns);
  const developerSearch = createLikeSearchCondition(Prisma.sql`replace(lower(coalesce(d.name, '')), '.', '')`, patterns);
  const addressSearch = createLikeSearchCondition(Prisma.sql`replace(lower(coalesce(o.address, '')), '.', '')`, patterns);
  const primaryDistrictSearch = createLikeSearchCondition(
    Prisma.sql`replace(lower(coalesce(pl.name, '')), '.', '')`,
    patterns,
  );
  const linkedDistrictSearch = createLikeSearchCondition(
    Prisma.sql`replace(lower(coalesce(l.name, '')), '.', '')`,
    patterns,
  );
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT o.id::text AS id
    FROM real_estate_objects o
    LEFT JOIN developers d ON d.id = o.developer_id
    WHERE o.deleted_at IS NULL
      AND (
        ${titleSearch}
        OR ${developerSearch}
        OR ${addressSearch}
        OR EXISTS (
          SELECT 1
          FROM locations pl
          WHERE pl.id = o.primary_location_id
            AND pl.type::text = 'district'
            AND ${primaryDistrictSearch}
        )
        OR EXISTS (
          SELECT 1
          FROM object_locations ol
          JOIN locations l ON l.id = ol.location_id
          WHERE ol.object_id = o.id
            AND l.type::text = 'district'
            AND ${linkedDistrictSearch}
        )
      )
  `);

  return rows.map((row) => row.id);
}

function createLikeSearchCondition(field: Prisma.Sql, patterns: string[]) {
  return Prisma.sql`(${Prisma.join(patterns.map((pattern) => Prisma.sql`${field} LIKE ${pattern} ESCAPE '\\'`), ' OR ')})`;
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}
