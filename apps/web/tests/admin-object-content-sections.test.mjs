import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/admin/ObjectsAdminPage.tsx'), 'utf8');
const objectDetailSource = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const objectDetailViewModelSource = readFileSync(resolve(currentDir, '../src/objects/objectDetailViewModel.ts'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

function indexOfRequired(needle) {
  const index = source.indexOf(needle);

  assert.notEqual(index, -1, `${needle} should exist`);

  return index;
}

test('objects admin editor places content section textareas after description and before layouts', () => {
  const descriptionIndex = indexOfRequired('htmlFor="object-description"');
  const architectureIndex = indexOfRequired('htmlFor="object-architecture-description"');
  const infrastructureIndex = indexOfRequired('htmlFor="object-infrastructure-description"');
  const fillingIndex = indexOfRequired('htmlFor="object-filling-description"');
  const layoutsIndex = indexOfRequired('htmlFor="object-layouts-url"');

  assert.ok(descriptionIndex < architectureIndex);
  assert.ok(architectureIndex < infrastructureIndex);
  assert.ok(infrastructureIndex < fillingIndex);
  assert.ok(fillingIndex < layoutsIndex);

  assert.match(source, /<FieldLabel htmlFor="object-architecture-description">Архитектура<\/FieldLabel>/);
  assert.match(source, /<FieldLabel htmlFor="object-infrastructure-description">Инфраструктура<\/FieldLabel>/);
  assert.match(source, /<FieldLabel htmlFor="object-filling-description">Наполнение<\/FieldLabel>/);
});

test('objects admin form persists and validates content section fields', () => {
  assert.match(source, /architectureDescription:\s*string;/);
  assert.match(source, /infrastructureDescription:\s*string;/);
  assert.match(source, /fillingDescription:\s*string;/);

  assert.match(source, /architectureDescription:\s*object\.architectureDescription \?\? ''/);
  assert.match(source, /infrastructureDescription:\s*object\.infrastructureDescription \?\? ''/);
  assert.match(source, /fillingDescription:\s*object\.fillingDescription \?\? ''/);

  assert.match(source, /architectureDescription:\s*emptyToNull\(form\.architectureDescription\)/);
  assert.match(source, /infrastructureDescription:\s*emptyToNull\(form\.infrastructureDescription\)/);
  assert.match(source, /fillingDescription:\s*emptyToNull\(form\.fillingDescription\)/);

  assert.match(source, /\['Архитектура',\s*form\.architectureDescription\]/);
  assert.match(source, /\['Инфраструктура',\s*form\.infrastructureDescription\]/);
  assert.match(source, /\['Наполнение',\s*form\.fillingDescription\]/);
  assert.match(source, /trim\(\)\.length > 10000/);
});

test('public object detail renders files beside parameters and content sections after description', () => {
  assert.match(objectDetailViewModelSource, /function getObjectContentSections|export function getObjectContentSections/);
  assert.match(objectDetailViewModelSource, /label:\s*'Архитектура'/);
  assert.match(objectDetailViewModelSource, /label:\s*'Инфраструктура'/);
  assert.match(objectDetailViewModelSource, /label:\s*'Наполнение'/);
  assert.match(objectDetailViewModelSource, /Не заполнено/);

  const parametersIndex = objectDetailSource.indexOf('id="object-parameters-title"');
  const filesIndex = objectDetailSource.indexOf('id="object-files-title"');
  const mapIndex = objectDetailSource.indexOf('id="object-map-title"');
  const descriptionIndex = objectDetailSource.indexOf('id="object-description-title"');
  const contentIndex = objectDetailSource.indexOf('id="object-content-sections-title"');

  assert.notEqual(parametersIndex, -1, 'parameters section should exist');
  assert.notEqual(filesIndex, -1, 'files section should exist');
  assert.notEqual(mapIndex, -1, 'map section should exist');
  assert.notEqual(descriptionIndex, -1, 'description section should exist');
  assert.notEqual(contentIndex, -1, 'content sections should exist');
  assert.ok(parametersIndex < filesIndex);
  assert.ok(filesIndex < mapIndex);
  assert.ok(mapIndex < descriptionIndex);
  assert.ok(descriptionIndex < contentIndex);

  assert.match(objectDetailSource, /getObjectContentSections\(object\)/);
  assert.match(objectDetailSource, /object-content-sections/);
  assert.match(styles, /\.object-content-sections\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);[\s\S]*?\}/);
  assert.match(styles, /@media\s*\(max-width:\s*1100px\)\s*\{[\s\S]*?\.object-content-sections\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?\}/);
});
