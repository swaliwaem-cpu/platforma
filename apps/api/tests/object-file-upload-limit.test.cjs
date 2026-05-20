const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const serviceSource = readFileSync(resolve(__dirname, '../src/objects/objects.service.ts'), 'utf8');

test('object PDF upload is capped at ten linked files per object', () => {
  const uploadObjectFileSource = extractFunctionSource(serviceSource, 'async uploadObjectFile');

  assert.match(serviceSource, /const objectPdfUploadLimit = 10;/);
  assert.match(uploadObjectFileSource, /if \(object\.files\.length >= objectPdfUploadLimit\) \{/);
  assert.match(uploadObjectFileSource, /throw new BadRequestException\(`Object cannot have more than \$\{objectPdfUploadLimit\} PDF files`\);/);
  assert.match(uploadObjectFileSource, /const existingFileCount = await tx\.objectFile\.count\(\{/);
  assert.match(uploadObjectFileSource, /if \(existingFileCount >= objectPdfUploadLimit\) \{/);
});

function extractFunctionSource(sourceText, marker) {
  const markerIndex = sourceText.indexOf(marker);

  assert.notEqual(markerIndex, -1, `${marker} should exist`);

  const nextFunctionIndex = sourceText.indexOf('\n  async ', markerIndex + marker.length);

  return sourceText.slice(markerIndex, nextFunctionIndex === -1 ? sourceText.length : nextFunctionIndex);
}
