import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/admin/ObjectsAdminPage.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

test('object editor uses searchable fields instead of long location and metro multi-selects', () => {
  assert.match(source, /import \{[\s\S]*matchesQuickEditSearch[\s\S]*\} from '\.\/objectQuickEditTransforms';/);
  assert.match(source, /function SearchableSelect/);
  assert.match(source, /const searchableMultiSelectResultLimit = 24;/);
  assert.match(source, /matchesQuickEditSearch\(query,/);

  assert.match(source, /id="object-primary-location"[\s\S]*?options=\{props\.districtLocations\}[\s\S]*?placeholder="Поиск основного района"/);
  assert.match(source, /id="object-districts"[\s\S]*?options=\{props\.districtLocations\}[\s\S]*?placeholder="Поиск районов"/);
  assert.match(source, /id="object-areas"[\s\S]*?options=\{props\.areaLocations\}[\s\S]*?placeholder="Поиск окружения"/);
  assert.match(source, /id="object-metro"[\s\S]*?options=\{props\.metroStations\}[\s\S]*?placeholder="Поиск метро"/);

  assert.doesNotMatch(source, /<select[\s\S]{0,120}id="object-primary-location"/);
  assert.doesNotMatch(source, /<select[\s\S]{0,120}id="object-districts"[\s\S]{0,80}multiple/);
  assert.doesNotMatch(source, /<select[\s\S]{0,120}id="object-areas"[\s\S]{0,80}multiple/);
  assert.doesNotMatch(source, /<select[\s\S]{0,120}id="object-metro"[\s\S]{0,80}multiple/);
});

test('object editor searchable multi-selects have compact dropdown and selected chips styles', () => {
  assert.match(styles, /\.searchable-multi-select\s*\{/);
  assert.match(styles, /\.searchable-multi-select-control\s*\{/);
  assert.match(styles, /\.searchable-multi-select-chip\s*\{/);
  assert.match(styles, /\.searchable-multi-select-menu\s*\{[\s\S]*?max-height:\s*260px;[\s\S]*?overflow:\s*auto;/);
  assert.match(styles, /\.searchable-multi-select-option\s*\{/);
});
