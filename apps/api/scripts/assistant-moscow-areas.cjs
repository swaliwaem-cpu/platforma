// Rebuilds apps/api/src/assistant/assistant-moscow-areas.data.ts: the outlines of Moscow, its
// okrugs and districts and the areas inside the Garden Ring, the TTK and the MKAD, which the
// assistant searches by. Free: OpenStreetMap through the Overpass API; PostGIS of the local
// database assembles and simplifies the outlines in a read-only transaction.
//
//   pnpm assistant:areas
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const { PrismaClient } = require('@prisma/client');

const overpassUrl = 'https://overpass-api.de/api/interpreter';
const moscowRelationId = 102269;
// Route relations of the ring roads; the area of a ring is everything its road encloses.
const rings = [
  { osmId: 2094267, name: 'Садовое кольцо' },
  { osmId: 2094286, name: 'ТТК' },
  { osmId: 2094222, name: 'МКАД' },
];
const kindByAdminLevel = { 4: 'city', 5: 'okrug', 8: 'district' };
// About 10–15 m in Moscow, far below the size of a housing project.
const simplifyDegrees = 0.00015;
const output = resolve(__dirname, '../src/assistant/assistant-moscow-areas.data.ts');

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`assistant areas failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const admin = await overpass(`[out:json][timeout:250];
rel(${moscowRelationId})->.city;
rel(r.city:"subarea")->.okrugs;
rel(r.okrugs:"subarea")->.districts;
(.city; .okrugs; .districts;);
out geom;`);
  const ringRoads = await overpass(`[out:json][timeout:120];
rel(id:${rings.map(({ osmId }) => osmId).join(',')});
out geom;`);

  const sources = [
    ...relations(admin).map((relation) => ({
      osmId: relation.id,
      kind: kindByAdminLevel[relation.tags.admin_level],
      name: relation.tags.name,
      lines: memberLines(relation, ['outer', 'inner']),
    })),
    ...relations(ringRoads).map((relation) => ({
      osmId: relation.id,
      kind: 'ring',
      name: rings.find(({ osmId }) => osmId === relation.id)?.name,
      lines: memberLines(relation, ['']),
    })),
  ];
  const broken = sources.filter((source) => !source.kind || !source.name || source.lines.coordinates.length === 0);
  if (broken.length) throw new Error(`unexpected relations: ${broken.map(({ osmId }) => osmId).join(', ')}`);

  const prisma = new PrismaClient();
  let shapes;
  try {
    shapes = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return tx.$queryRawUnsafe(assembleSql, JSON.stringify(sources.map((source, index) => ({
        index,
        kind: source.kind,
        lines: JSON.stringify(source.lines),
      }))), simplifyDegrees);
    }, { timeout: 180_000 });
  } finally {
    await prisma.$disconnect();
  }

  const entries = shapes.map((shape) => {
    const source = sources[shape.index];
    if (!shape.geometry || !(shape.areaKm2 > 0)) throw new Error(`no outline for ${source.name} (${source.osmId})`);
    return { ...source, geometry: shape.geometry, areaKm2: Number(shape.areaKm2) };
  });
  const counts = Object.fromEntries(['city', 'okrug', 'district', 'ring'].map((kind) => [kind, entries.filter((entry) => entry.kind === kind).length]));
  if (counts.city !== 1 || counts.okrug < 12 || counts.district < 125 || counts.ring !== rings.length) {
    throw new Error(`unexpected area counts: ${JSON.stringify(counts)}`);
  }

  writeFileSync(output, render(entries));
  for (const entry of entries.filter(({ kind }) => kind !== 'district')) {
    process.stdout.write(`${entry.name}: ${entry.areaKm2.toFixed(1)} km²\n`);
  }
  process.stdout.write(`${counts.district} districts written to ${output}\n`);
}

// A ring road is two carriageways plus ramps: its line work is polygonized, the faces merged and
// only the outer outline kept. A boundary relation is closed rings of outer and inner ways.
const assembleSql = `
  WITH source AS (
    SELECT (item->>'index')::int AS index, item->>'kind' AS kind,
           ST_Node(ST_SetSRID(ST_GeomFromGeoJSON(item->>'lines'), 4326)) AS lines
    FROM jsonb_array_elements($1::jsonb) AS item
  ), shape AS (
    SELECT index, CASE WHEN kind = 'ring' THEN (
      SELECT ST_MakePolygon(ST_ExteriorRing(part.geom))
      FROM ST_Dump(ST_Union(ARRAY(SELECT (ST_Dump(ST_Polygonize(ARRAY[lines]))).geom))) AS part
      ORDER BY ST_Area(part.geom) DESC
      LIMIT 1
    ) ELSE ST_MakeValid(ST_BuildArea(lines)) END AS geom
    FROM source
  )
  SELECT index,
         ST_AsGeoJSON(ST_Multi(ST_CollectionExtract(ST_SimplifyPreserveTopology(geom, $2::float8), 3)), 5) AS geometry,
         ST_Area(geom::geography) / 1000000 AS "areaKm2"
  FROM shape
  ORDER BY index
`;

function render(entries) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = entries.map((entry) => `  { osmId: ${entry.osmId}, kind: '${entry.kind}', name: ${JSON.stringify(entry.name)}, geometry: ${JSON.stringify(entry.geometry)} },`);
  return `// Generated by apps/api/scripts/assistant-moscow-areas.cjs on ${date} from OpenStreetMap
// (© OpenStreetMap contributors, ODbL 1.0). Do not edit by hand: rerun \`pnpm assistant:areas\`.

export type AssistantMoscowAreaShape = {
  osmId: number;
  kind: 'city' | 'okrug' | 'district' | 'ring';
  name: string;
  /** GeoJSON MultiPolygon, longitude first. */
  geometry: string;
};

export const assistantMoscowAreaShapes: readonly AssistantMoscowAreaShape[] = [
${lines.join('\n')}
];
`;
}

function relations(response) {
  return response.elements.filter((element) => element.type === 'relation');
}

function memberLines(relation, roles) {
  return {
    type: 'MultiLineString',
    coordinates: relation.members
      .filter((member) => member.type === 'way' && roles.includes(member.role ?? '') && member.geometry?.length > 1)
      .map((member) => member.geometry.map(({ lon, lat }) => [lon, lat])),
  };
}

// The public Overpass server answers 504 when it is busy; a few spaced retries get through.
async function overpass(query) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(overpassUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'platforma-assistant-areas/1.0',
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(300_000),
    });
    if (response.ok) return response.json();
    if (attempt >= 5 || ![429, 502, 503, 504].includes(response.status)) {
      throw new Error(`Overpass answered ${response.status}`);
    }
    await new Promise((done) => setTimeout(done, attempt * 15_000));
  }
}
