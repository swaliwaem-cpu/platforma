const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const controllerSource = readFileSync(resolve(__dirname, '../src/objects/objects.controller.ts'), 'utf8');
const serviceSource = readFileSync(resolve(__dirname, '../src/objects/objects.service.ts'), 'utf8');

test('objects controller keeps multipart gallery batch endpoint for layout and compatibility', () => {
  assert.match(controllerSource, /import \{ FileInterceptor,\s*FilesInterceptor \} from '@nestjs\/platform-express';/);
  assert.match(controllerSource, /@Patch\(':id\/gallery\/batch'\)[\s\S]*?@RequirePermissions\('objects:update'\)[\s\S]*?@UseInterceptors\(FilesInterceptor\('files', objectGalleryBatchFileLimit, \{ limits: \{ fileSize: IMAGE_MAX_SIZE_BYTES, files: objectGalleryBatchFileLimit \} \}\)\)[\s\S]*?async replaceGallery\(/);
  assert.match(controllerSource, /return this\.objectsService\.replaceGallery\(id,\s*body,\s*files,\s*actor,\s*request\);/);
});

test('objects service replaces gallery in one transaction after uploads are prepared', () => {
  const replaceGallerySource = extractFunctionSource(serviceSource, 'async replaceGallery');

  assert.match(replaceGallerySource, /const uploadedFiles: Awaited<ReturnType<FilesService\['uploadFile'\]>>\[\] = \[\];/);
  assert.match(replaceGallerySource, /for \(const file of normalizedFiles\) \{[\s\S]*?uploadedFiles\.push\(await this\.filesService\.uploadFile\(file,\s*actor,\s*'image'\)\);[\s\S]*?\}/);
  assert.match(replaceGallerySource, /const updatedObject = await this\.prisma\.\$transaction\(async \(tx\) => \{/);
  assert.match(replaceGallerySource, /await tx\.objectImage\.deleteMany\(\{[\s\S]*?id:\s*\{[\s\S]*?in:\s*deletedImageIds[\s\S]*?\}/);
  assert.match(replaceGallerySource, /tx\.objectImage\.create\(\{[\s\S]*?objectId:\s*object\.id[\s\S]*?fileId:\s*uploadedFile\.file\.id[\s\S]*?sortOrder:\s*index[\s\S]*?isCover:\s*index === layout\.coverIndex[\s\S]*?section:\s*item\.section/);
  assert.match(replaceGallerySource, /tx\.objectImage\.update\(\{[\s\S]*?sortOrder:\s*index[\s\S]*?isCover:\s*index === layout\.coverIndex[\s\S]*?section:\s*item\.section/);
  assert.match(replaceGallerySource, /for \(const uploadedFile of uploadedFiles\) \{[\s\S]*?await this\.filesService\.deleteUnlinkedFile\(uploadedFile\.file\.id\);[\s\S]*?\}/);
});

test('objects service validates batch permissions dynamically', () => {
  const replaceGallerySource = extractFunctionSource(serviceSource, 'async replaceGallery');

  assert.match(replaceGallerySource, /if \(layout\.items\.some\(\(item\) => item\.kind === 'new'\) && !actor\.permissions\.includes\('files:upload'\)\) \{/);
  assert.match(replaceGallerySource, /throw new ForbiddenException\('Insufficient permissions'\);/);
  assert.match(replaceGallerySource, /if \(deletedImageIds\.length > 0 && !actor\.permissions\.includes\('files:delete'\)\) \{/);
});

function extractFunctionSource(sourceText, marker) {
  const markerIndex = sourceText.indexOf(marker);

  assert.notEqual(markerIndex, -1, `${marker} should exist`);

  const nextFunctionIndex = sourceText.indexOf('\n  async ', markerIndex + marker.length);

  return sourceText.slice(markerIndex, nextFunctionIndex === -1 ? sourceText.length : nextFunctionIndex);
}
