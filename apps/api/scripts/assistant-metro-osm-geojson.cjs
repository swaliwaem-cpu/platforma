#!/usr/bin/env node
'use strict';

// Builds the metro access-point GeoJSON consumed by `assistant:metro:refresh` from OpenStreetMap.
// Access points are subway entrances (railway=subway_entrance) attributed to a station through
// public_transport=stop_area relations; stations without any mapped entrance fall back to the
// station node itself so every station in the directory stays reachable.
//
// Usage:
//   node apps/api/scripts/assistant-metro-osm-geojson.cjs --out <geojson> [--input <overpass.json>]
//     [--bbox south,west,north,east] [--overpass-url <url>] [--raw-out <overpass.json>]

const { readFileSync, writeFileSync } = require('node:fs');

const defaultOverpassUrl = 'https://overpass-api.de/api/interpreter';
// Moscow inside the ring of Moscow Oblast so edge stations (Мякинино, Котельники, Физтех) stay in.
const defaultBbox = [55.35, 36.9, 56.05, 38.1];
const orphanEntranceRadiusMeters = 300;
const stationFallbackRadiusMeters = 400;
const terminalRelationPattern = /^Москва-/u;

async function main() {
  const outPath = readFlag('--out');
  if (!outPath) throw new Error('Usage: --out <geojson> [--input <overpass.json>] [--bbox south,west,north,east]');
  const inputPath = readFlag('--input');
  const rawOutPath = readFlag('--raw-out');
  const bbox = readBbox(readFlag('--bbox'));
  const overpassUrl = readFlag('--overpass-url') || defaultOverpassUrl;

  const raw = inputPath
    ? JSON.parse(readFileSync(inputPath, 'utf8'))
    : await fetchOverpass(overpassUrl, createQuery(bbox));
  if (rawOutPath && !inputPath) writeFileSync(rawOutPath, JSON.stringify(raw));
  const { geojson, summary } = buildAccessPoints(raw);
  writeFileSync(outPath, `${JSON.stringify(geojson)}\n`);
  process.stdout.write(`${JSON.stringify({ status: 'COMPLETED', out: outPath, ...summary })}\n`);
}

function createQuery([south, west, north, east]) {
  const bounds = `(${south},${west},${north},${east})`;
  return [
    '[out:json][timeout:180];',
    `node["railway"="station"]["station"="subway"]${bounds}->.st;`,
    `node["railway"="subway_entrance"]${bounds}->.ent;`,
    'rel(bn.ent)["public_transport"="stop_area"]->.sa;',
    '(.st; .ent; .sa;);',
    'out body;',
  ].join('\n');
}

async function fetchOverpass(url, query) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'user-agent': 'Platforma/0.1 (assistant metro directory build)',
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) throw new Error(`OVERPASS_HTTP_${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.elements)) throw new Error('OVERPASS_RESPONSE_INVALID');
  if (typeof payload.remark === 'string' && /error|timeout|runtime/iu.test(payload.remark)) {
    throw new Error(`OVERPASS_REMARK: ${payload.remark}`);
  }
  return payload;
}

function buildAccessPoints(raw) {
  const snapshot = typeof raw?.osm3s?.timestamp_osm_base === 'string' ? raw.osm3s.timestamp_osm_base : null;
  if (!snapshot) throw new Error('OVERPASS_SNAPSHOT_MISSING');
  const nodes = new Map();
  const relations = [];
  for (const element of raw.elements) {
    if (element.type === 'node' && element.tags) nodes.set(element.id, element);
    else if (element.type === 'relation' && element.tags && Array.isArray(element.members)) relations.push(element);
  }
  const stations = [...nodes.values()].filter((node) => node.tags.railway === 'station' && node.tags.name);
  const entrances = [...nodes.values()].filter((node) => node.tags.railway === 'subway_entrance' && isUsableEntrance(node));
  if (stations.length === 0 || entrances.length === 0) throw new Error('OVERPASS_DATA_EMPTY');

  // Canonical spelling per normalized name: the most common spelling among subway station nodes.
  const spellingVotes = new Map();
  for (const station of stations) {
    const key = normalizeName(station.tags.name);
    const votes = spellingVotes.get(key) ?? new Map();
    votes.set(station.tags.name, (votes.get(station.tags.name) ?? 0) + 1);
    spellingVotes.set(key, votes);
  }
  const canonicalName = (name) => {
    const votes = spellingVotes.get(normalizeName(name));
    if (!votes) return name.trim().replace(/\s+/gu, ' ');
    return [...votes.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ru'))[0][0];
  };

  const stationById = new Map(stations.map((station) => [station.id, station]));
  const entranceCandidates = new Map();
  for (const relation of relations) {
    if (relation.tags.public_transport !== 'stop_area') continue;
    const stationMembers = relation.members
      .filter((member) => member.type === 'node' && stationById.has(member.ref))
      .map((member) => stationById.get(member.ref));
    const relationName = typeof relation.tags.name === 'string' ? relation.tags.name.trim() : '';
    for (const member of relation.members) {
      if (member.type !== 'node') continue;
      const entrance = nodes.get(member.ref);
      if (!entrance || entrance.tags.railway !== 'subway_entrance') continue;
      const candidates = entranceCandidates.get(entrance.id) ?? [];
      if (stationMembers.length > 0) {
        const nearest = stationMembers
          .map((station) => ({ station, distance: distanceMeters(entrance, station) }))
          .sort((left, right) => left.distance - right.distance || left.station.id - right.station.id)[0];
        candidates.push({
          rule: 'stop_area_station',
          name: nearest.station.tags.name,
          stationRef: `node/${nearest.station.id}`,
          network: nearest.station.tags.network ?? null,
          distance: nearest.distance,
          order: 0,
        });
      } else if (relationName && !terminalRelationPattern.test(relationName)) {
        candidates.push({
          rule: 'stop_area_relation',
          name: relationName,
          stationRef: `relation/${relation.id}`,
          network: relation.tags.network ?? null,
          distance: 0,
          order: relation.tags.network === 'МЦК' ? 1 : 2,
        });
      }
      entranceCandidates.set(entrance.id, candidates);
    }
  }

  const features = [];
  const rules = { stop_area_station: 0, stop_area_relation: 0, nearest_station: 0, station_fallback: 0, dropped: 0 };
  for (const entrance of entrances) {
    const candidates = (entranceCandidates.get(entrance.id) ?? [])
      .sort((left, right) => left.order - right.order || left.distance - right.distance || left.name.localeCompare(right.name, 'ru'));
    let match = candidates[0] ?? null;
    if (!match) {
      const nearest = stations
        .map((station) => ({ station, distance: distanceMeters(entrance, station) }))
        .sort((left, right) => left.distance - right.distance || left.station.id - right.station.id)[0];
      if (nearest && nearest.distance <= orphanEntranceRadiusMeters) {
        match = {
          rule: 'nearest_station',
          name: nearest.station.tags.name,
          stationRef: `node/${nearest.station.id}`,
          network: nearest.station.tags.network ?? null,
        };
      }
    }
    if (!match) {
      rules.dropped += 1;
      continue;
    }
    rules[match.rule] += 1;
    features.push(createFeature(entrance, {
      station_name: canonicalName(match.name),
      access_kind: 'entrance',
      station_osm_id: match.stationRef,
      entrance_ref: typeof entrance.tags.ref === 'string' ? entrance.tags.ref : null,
      network: match.network,
      match_rule: match.rule,
    }, snapshot));
  }

  // Stations whose name has no access point nearby are represented by the station node itself.
  for (const station of stations) {
    const name = canonicalName(station.tags.name);
    const covered = features.some((feature) => feature.properties.station_name === name
      && distanceMeters(station, { lat: feature.geometry.coordinates[1], lon: feature.geometry.coordinates[0] }) <= stationFallbackRadiusMeters);
    if (covered) continue;
    rules.station_fallback += 1;
    features.push(createFeature(station, {
      station_name: name,
      access_kind: 'station',
      station_osm_id: `node/${station.id}`,
      entrance_ref: null,
      network: station.tags.network ?? null,
      match_rule: 'station_fallback',
    }, snapshot));
  }

  features.sort((left, right) => left.properties.osm_id.localeCompare(right.properties.osm_id));
  const stationNames = new Set(features.map((feature) => feature.properties.station_name));
  return {
    geojson: { type: 'FeatureCollection', features },
    summary: {
      snapshot,
      stations: stationNames.size,
      accessPoints: features.length,
      rules,
    },
  };
}

function createFeature(node, properties, snapshot) {
  return {
    type: 'Feature',
    id: `node/${node.id}`,
    geometry: { type: 'Point', coordinates: [Number(node.lon.toFixed(6)), Number(node.lat.toFixed(6))] },
    properties: {
      osm_id: `node/${node.id}`,
      ...properties,
      source: 'OpenStreetMap/Overpass',
      source_snapshot: snapshot,
    },
  };
}

function isUsableEntrance(node) {
  const tags = node.tags;
  if (tags.disused === 'yes' || tags['disused:railway'] || tags.access === 'no' || tags.access === 'private') return false;
  if (typeof tags.opening_date === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(tags.opening_date)
    && tags.opening_date.slice(0, 10) > new Date().toISOString().slice(0, 10)) return false;
  return typeof node.lat === 'number' && typeof node.lon === 'number';
}

function normalizeName(value) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

function distanceMeters(left, right) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const dLat = toRadians(right.lat - left.lat);
  const dLon = toRadians(right.lon - left.lon);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(left.lat)) * Math.cos(toRadians(right.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

function readBbox(value) {
  if (!value) return defaultBbox;
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) throw new Error('BBOX_INVALID');
  return parts;
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

module.exports = { buildAccessPoints, createQuery };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'FAILED', message: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
