import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/admin/ObjectsAdminPage.tsx'), 'utf8');

test('object editor uses one comma-separated coordinates field', () => {
  assert.match(source, /coordinates:\s*string;/);
  assert.match(source, /<FieldLabel htmlFor="object-coordinates">Координаты<\/FieldLabel>/);
  assert.match(source, /id="object-coordinates"/);
  assert.match(source, /placeholder="55\.713384, 37\.651074"/);
  assert.match(source, /value=\{props\.form\.coordinates\}/);
  assert.match(source, /coordinates: event\.target\.value/);

  assert.doesNotMatch(source, /htmlFor="object-latitude"/);
  assert.doesNotMatch(source, /htmlFor="object-longitude"/);
  assert.doesNotMatch(source, /value=\{props\.form\.latitude\}/);
  assert.doesNotMatch(source, /value=\{props\.form\.longitude\}/);
});

test('object form converts coordinates between UI text and API latitude longitude', () => {
  assert.match(source, /coordinates:\s*formatCoordinatePair\(object\.latitude\?\.toString\(\) \?\? '',\s*object\.longitude\?\.toString\(\) \?\? ''\)/);
  assert.match(source, /const coordinates = parseCoordinatePair\(form\.coordinates\);/);
  assert.match(source, /latitude:\s*coordinates\.latitude/);
  assert.match(source, /longitude:\s*coordinates\.longitude/);
  assert.match(source, /const coordinateParse = parseCoordinatePair\(form\.coordinates\);/);
  assert.match(source, /if \(coordinateParse\.error\) \{/);
  assert.match(source, /return coordinateParse\.error;/);
  assert.match(source, /function parseCoordinatePair\(value: string\)/);
  assert.match(source, /latitudeNumber < -90 \|\| latitudeNumber > 90/);
  assert.match(source, /longitudeNumber < -180 \|\| longitudeNumber > 180/);
});
