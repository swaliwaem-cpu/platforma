import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(currentDir, '../src');
const read = (path) => readFileSync(resolve(srcDir, path), 'utf8');
const dropdownSource = read('components/Dropdown.tsx');
const selectSource = read('components/SelectDropdown.tsx');
const multiSelectSource = read('components/MultiSelectDropdown.tsx');
const autocompleteSource = read('components/AutocompleteInput.tsx');
const styles = read('styles.css');
const fluffyWhite = read('fluffy-white-theme.css');

function listTsxFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) {
      return listTsxFiles(path);
    }

    return path.endsWith('.tsx') ? [path] : [];
  });
}

test('platform renders no native select or datalist popups', () => {
  const offenders = listTsxFiles(srcDir)
    .filter((path) => /<select[\s>]|<datalist[\s>]|\slist=\{|\slist="/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(srcDir, path));

  assert.deepEqual(offenders, []);
});

test('shared dropdown menu is a Radix popover portal with keyboard navigation', () => {
  assert.match(dropdownSource, /import \{ Popover \} from 'radix-ui';/);
  assert.match(dropdownSource, /<Popover\.Portal>/);
  assert.match(dropdownSource, /className=\{joinDropdownClassNames\('multi-select-dropdown-menu', className\)\}/);
  assert.match(dropdownSource, /event\.key === 'ArrowDown'/);
  assert.match(dropdownSource, /event\.key === 'Home' \|\| event\.key === 'End'/);
  assert.match(dropdownSource, /matchesSearchVariants\(query, values\)/);
  assert.match(dropdownSource, /role="option"/);
  assert.match(dropdownSource, /className="multi-select-dropdown-check"/);
});

test('select, multi-select and autocomplete all build on the shared dropdown', () => {
  for (const source of [selectSource, multiSelectSource, autocompleteSource]) {
    assert.match(source, /from '\.\/Dropdown';/);
    assert.match(source, /<DropdownContent/);
    assert.match(source, /<DropdownOption/);
  }

  assert.match(selectSource, /role="combobox"/);
  assert.match(selectSource, /'multi-select-dropdown-button',\s*'select-dropdown'/);
  assert.match(multiSelectSource, /aria-multiselectable=\{true\}/);
});

test('dropdown menu styles follow the rooms filter reference in both themes', () => {
  assert.match(styles, /\.multi-select-dropdown-menu \{[\s\S]*?z-index: 1300;[\s\S]*?min-width: var\(--radix-popover-trigger-width, 180px\);[\s\S]*?max-height: min\(260px, var\(--radix-popover-content-available-height, 260px\)\);/);
  assert.match(styles, /\.multi-select-dropdown-list \{[\s\S]*?overflow: auto;/);
  assert.match(fluffyWhite, /:is\(\s*\.multi-select-dropdown-menu,\s*\.searchable-multi-select-menu,\s*\.catalog-sort-menu,[\s\S]*?\) \{[\s\S]*?border-radius: 18px;[\s\S]*?padding: 10px;/);
  assert.match(fluffyWhite, /body :is\(\.multi-select-dropdown-menu, \.searchable-multi-select-menu, \.catalog-sort-menu\) \{[\s\S]*?font-size: 11px;/);
});
