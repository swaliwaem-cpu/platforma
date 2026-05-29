const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const controllerSource = readFileSync(resolve(__dirname, '../src/objects/objects.controller.ts'), 'utf8');
const serviceSource = readFileSync(resolve(__dirname, '../src/objects/objects.service.ts'), 'utf8');
const filesServiceSource = readFileSync(resolve(__dirname, '../src/files/files.service.ts'), 'utf8');
const storageSource = readFileSync(resolve(__dirname, '../src/files/s3-storage.service.ts'), 'utf8');
const variantsSource = readFileSync(resolve(__dirname, '../src/files/image-variants.ts'), 'utf8');

test('objects controller exposes raw stream gallery upload endpoint', () => {
  assert.match(controllerSource, /@Post\(':id\/gallery\/stream'\)[\s\S]*?@RequirePermissions\('objects:update', 'files:upload'\)[\s\S]*?async uploadGalleryImageStream\(/);
  assert.match(controllerSource, /@Req\(\) request: RequestWithAuth & NodeJS\.ReadableStream/);
  assert.match(controllerSource, /return this\.objectsService\.uploadGalleryImageStream\(id,\s*request,\s*actor,\s*request\);/);
});

test('objects service stages one streamed gallery file without mutating object images', () => {
  const uploadStreamSource = extractFunctionSource(serviceSource, 'async uploadGalleryImageStream');

  assert.match(uploadStreamSource, /const uploadedFile = await this\.filesService\.uploadFileStream\(/);
  assert.doesNotMatch(uploadStreamSource, /objectImage\.create\(/);
  assert.doesNotMatch(uploadStreamSource, /maxSortOrder/);
  assert.match(uploadStreamSource, /object:\s*this\.serializeObjectDetail\(object\)/);
  assert.match(uploadStreamSource, /file:\s*uploadedFile\.file/);
  assert.match(uploadStreamSource, /await this\.filesService\.deleteUnlinkedFile\(uploadedFile\.file\.id\);/);
});

test('files service persists stream uploads through a temp file without buffering a multipart batch', () => {
  assert.match(filesServiceSource, /import \{ createWriteStream \} from 'node:fs';/);
  assert.match(filesServiceSource, /import \{ mkdir,\s*rm \} from 'node:fs\/promises';/);
  assert.match(filesServiceSource, /import \{ pipeline \} from 'node:stream\/promises';/);
  assert.match(filesServiceSource, /export type UploadedFileStream = \{[\s\S]*?stream: NodeJS\.ReadableStream;[\s\S]*?originalname: string;[\s\S]*?mimetype: string;[\s\S]*?size\?: number;[\s\S]*?\};/);
  assert.match(filesServiceSource, /async uploadFileStream\(file: UploadedFileStream,\s*actor: AuthenticatedUser,\s*kind: UploadFileKind\)/);
  assert.match(filesServiceSource, /const persistedFile = await this\.persistUploadedFileStream\(validatedFile\);/);
  assert.match(filesServiceSource, /generateImageVariantsFromFile\(persistedFile\.path,\s*key\)/);
  assert.match(filesServiceSource, /this\.storage\.putObjectFromFile\(\{[\s\S]*?filePath:\s*persistedFile\.path[\s\S]*?checksum:\s*persistedFile\.checksum[\s\S]*?contentLength:\s*persistedFile\.size/);
});

test('image variants and MinIO upload support file-backed streaming', () => {
  assert.match(variantsSource, /export async function generateImageVariantsFromFile\(filePath: string,\s*originalKey: string\)/);
  assert.match(variantsSource, /return generateImageVariantsFromSharp\(sharp\(filePath\),\s*originalKey\);/);

  assert.match(storageSource, /import \{ createReadStream \} from 'node:fs';/);
  assert.match(storageSource, /async putObjectFromFile\(params: \{ key: string; filePath: string; contentType: string; checksum: string; contentLength: number \}\)/);
  assert.match(storageSource, /body:\s*createReadStream\(params\.filePath\)/);
  assert.match(storageSource, /payloadHash:\s*params\.checksum/);
  assert.match(storageSource, /contentLength:\s*params\.contentLength/);
  assert.match(storageSource, /duplex:\s*'half'/);
});

function extractFunctionSource(sourceText, marker) {
  const markerIndex = sourceText.indexOf(marker);

  assert.notEqual(markerIndex, -1, `${marker} should exist`);

  const nextFunctionIndex = sourceText.indexOf('\n  async ', markerIndex + marker.length);

  return sourceText.slice(markerIndex, nextFunctionIndex === -1 ? sourceText.length : nextFunctionIndex);
}
