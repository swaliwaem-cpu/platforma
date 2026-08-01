const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PDFDocument = require('pdfkit');

const {
  TrainingDocumentExtractorRegistry,
} = require('../dist/training/training-document-extractor.js');
const {
  TrainingDocumentsService,
} = require('../dist/training/training-documents.service.js');
const config = require('../dist/training/training-document.config.js');

const rootDir = path.resolve(__dirname, '../../..');
const trainingControllerDir = path.join(rootDir, 'apps/api/src/training');
const controllerSource = readdirSync(trainingControllerDir)
  .filter(
    (name) =>
      name.startsWith('training-admin') && name.endsWith('.controller.ts'),
  )
  .map((name) => readFileSync(path.join(trainingControllerDir, name), 'utf8'))
  .join('\n');
const linkedObjectControllerSource = readFileSync(
  path.join(
    rootDir,
    'apps/api/src/training/training-linked-object-sources.controller.ts',
  ),
  'utf8',
);
const trainingModuleSource = readFileSync(
  path.join(rootDir, 'apps/api/src/training/training.module.ts'),
  'utf8',
);
const documentServiceSource = readFileSync(
  path.join(rootDir, 'apps/api/src/training/training-documents.service.ts'),
  'utf8',
);
const workerSource = readFileSync(
  path.join(rootDir, 'apps/api/src/training/training-document-worker.service.ts'),
  'utf8',
);
const extractorSource = readFileSync(
  path.join(rootDir, 'apps/api/src/training/training-document-extractor.ts'),
  'utf8',
);
const prismaSchema = readFileSync(
  path.join(rootDir, 'apps/api/prisma/schema.prisma'),
  'utf8',
);

function createVersionContentLockQuery(versionId, projectId) {
  let queryIndex = 0;
  return async () => {
    queryIndex += 1;
    if (queryIndex === 1) return [{ projectId }];
    if (queryIndex === 2) return [{ id: projectId, status: 'DRAFT' }];
    if (queryIndex === 3) {
      return [{ id: versionId, projectId, status: 'DRAFT' }];
    }
    return [];
  };
}

test('training document endpoints stay behind the training admin controller guard', () => {
  assert.match(controllerSource, /@Controller\('training\/admin'\)/);
  assert.match(controllerSource, /@RequirePermissions\('training:projects:manage'\)/);
  assert.match(
    controllerSource,
    /@Post\('versions\/:versionId\/documents'\)[\s\S]*FileInterceptor\('file'/,
  );
  assert.match(
    controllerSource,
    /@Get\('versions\/:versionId\/documents\/:documentId\/text'\)/,
  );
  assert.match(
    controllerSource,
    /@Get\('versions\/:versionId\/documents\/:documentId\/content'\)/,
  );
  assert.match(controllerSource, /Cache-Control', 'private, no-store'/);
  assert.match(
    linkedObjectControllerSource,
    /@RequirePermissions\('training:projects:manage'\)/,
  );
  assert.match(
    linkedObjectControllerSource,
    /@Post\('versions\/:versionId\/documents\/from-linked-object'\)/,
  );
  assert.match(
    trainingModuleSource,
    /controllers:\s*\[[\s\S]*TrainingLinkedObjectSourcesController/u,
  );
});

test('document upload is draft-only, private and never promotes extracted text to facts', () => {
  assert.match(documentServiceSource, /requireDraftVersion\(versionIdInput\)/);
  assert.match(documentServiceSource, /uploadPrivateTrainingDocument/);
  assert.match(documentServiceSource, /scoringEligible:\s*false/);
  assert.doesNotMatch(documentServiceSource, /trainingFact\.(create|createMany)/);
  assert.match(documentServiceSource, /Only PDF, DOCX, PPTX and XLSX documents are allowed/);
  assert.match(documentServiceSource, /PDF signature is invalid/);
  assert.match(documentServiceSource, /OOXML ZIP signature is invalid/);
});

test('document worker claims only extraction jobs and persists terminal statuses', () => {
  assert.match(workerSource, /kind:\s*TrainingJobKind\.EXTRACT_SOURCE_DOCUMENT/);
  assert.match(workerSource, /status:\s*TrainingJobStatus\.RUNNING/);
  assert.match(workerSource, /TrainingSourceExtractionStatus\.NEEDS_MANUAL_TEXT/);
  assert.match(workerSource, /TrainingSourceExtractionStatus\.FAILED/);
  assert.match(workerSource, /TrainingJobStatus\.SUCCEEDED/);
  assert.match(workerSource, /TrainingJobStatus\.DEAD/);
  assert.match(
    workerSource,
    /createHash\('sha256'\)[\s\S]*document\.checksum/u,
  );
  assert.doesNotMatch(workerSource, /TELEGRAM|TRANSCRIBE|EVALUATE_ANSWER/);
});

test('document extraction limits are bounded and OOXML parsing disables entities', () => {
  assert.equal(config.TRAINING_MAX_DOCUMENT_BYTES, 50 * 1024 * 1024);
  assert.equal(config.TRAINING_MAX_DOCUMENT_UNCOMPRESSED_BYTES, 200 * 1024 * 1024);
  assert.equal(config.TRAINING_MAX_DOCUMENT_ZIP_ENTRIES, 5000);
  assert.equal(config.TRAINING_MAX_EXTRACTED_CHARACTERS, 1_000_000);
  assert.equal(config.TRAINING_DOCUMENT_EXTRACTION_TIMEOUT_MS, 30_000);
  assert.match(extractorSource, /processEntities:\s*false/);
  assert.match(extractorSource, /Encrypted documents are not supported/);
  assert.match(extractorSource, /External document relationships are not allowed/);
  assert.match(extractorSource, /Macros, embedded objects and external links are not allowed/);
  assert.match(extractorSource, /hasFormula[\s\S]*continue/);
});

test('document service creates a private file, source row, extraction job and audit entry', async () => {
  const versionId = '11111111-1111-4111-8111-111111111111';
  const documentId = '22222222-2222-4222-8222-222222222222';
  const fileId = '33333333-3333-4333-8333-333333333333';
  const projectId = '55555555-5555-4555-8555-555555555555';
  const calls = { jobs: [], audits: [] };
  const storedFile = {
    id: fileId,
    storage: 'MINIO',
    bucket: 'platforma-training-private',
    key: 'training-documents/example.docx',
    url: null,
    originalName: 'facts.docx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sizeBytes: 4n,
    checksum: 'checksum',
    wpAttachmentId: null,
    uploadedById: '44444444-4444-4444-8444-444444444444',
    createdAt: new Date('2026-07-25T10:00:00.000Z'),
    updatedAt: new Date('2026-07-25T10:00:00.000Z'),
  };
  const documentRecord = {
    id: documentId,
    projectVersionId: versionId,
    fileId,
    documentType: 'DOCX',
    checksum: 'checksum',
    extractionStatus: 'PENDING',
    extractedText: null,
    extractionMetadataJson: {},
    errorMessage: null,
    createdAt: new Date('2026-07-25T10:00:00.000Z'),
    updatedAt: new Date('2026-07-25T10:00:00.000Z'),
    file: storedFile,
    _count: { facts: 0 },
  };
  const tx = {
    $queryRaw: createVersionContentLockQuery(versionId, projectId),
    trainingSourceDocument: {
      create: async () => ({ id: documentId }),
    },
    trainingJob: {
      create: async (input) => calls.jobs.push(input),
    },
    auditLog: {
      create: async (input) => calls.audits.push(input),
    },
  };
  const prisma = {
    trainingProjectVersion: {
      findUnique: async () => ({ id: versionId, status: 'DRAFT' }),
    },
    trainingSourceDocument: {
      findFirst: async () => documentRecord,
    },
    $transaction: async (callback) => callback(tx),
  };
  const files = {
    uploadPrivateTrainingDocument: async (_file, _actor, extension) => {
      assert.equal(extension, '.docx');
      return storedFile;
    },
  };
  const service = new TrainingDocumentsService(prisma, files);
  const response = await service.uploadDocument(
    versionId,
    {
      fieldname: 'file',
      originalname: '../facts.docx',
      encoding: '7bit',
      mimetype:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 4,
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    },
    {
      id: storedFile.uploadedById,
      email: 'admin@example.com',
      permissions: ['training:projects:manage'],
    },
    { headers: { 'user-agent': 'test' }, ip: '127.0.0.1' },
  );

  assert.equal(response.document.id, documentId);
  assert.equal(calls.jobs[0].data.kind, 'EXTRACT_SOURCE_DOCUMENT');
  assert.deepEqual(calls.jobs[0].data.payloadJson, { sourceDocumentId: documentId });
  assert.equal(calls.audits[0].data.action, 'training.source-document.upload');
});

test('document deletion preserves fact-suggestion history', async () => {
  const versionId = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';
  const documentId = '33333333-3333-4333-8333-333333333333';
  const fileId = '44444444-4444-4444-8444-444444444444';
  let documentDeletes = 0;
  let fileDeletes = 0;
  const tx = {
    $queryRaw: createVersionContentLockQuery(versionId, projectId),
    trainingSourceDocument: {
      findFirst: async () => ({
        id: documentId,
        projectVersionId: versionId,
        fileId,
        extractionStatus: 'READY',
        file: {
          id: fileId,
          originalName: 'source.pdf',
        },
        _count: { facts: 0 },
      }),
      delete: async () => {
        documentDeletes += 1;
      },
    },
    trainingFactSuggestionRun: {
      count: async () => 0,
    },
    trainingFactSuggestionProviderRun: {
      count: async () => 1,
    },
  };
  const service = new TrainingDocumentsService(
    {
      trainingProjectVersion: {
        findUnique: async () => ({ id: versionId, status: 'DRAFT' }),
      },
      $transaction: async (callback) => callback(tx),
    },
    {
      deleteUnlinkedFile: async () => {
        fileDeletes += 1;
      },
    },
  );

  await assert.rejects(
    () =>
      service.deleteDocument(
        versionId,
        documentId,
        { id: '55555555-5555-4555-8555-555555555555' },
        { headers: {} },
      ),
    (error) =>
      error?.status === 409 && /история решений/u.test(error.message),
  );
  assert.equal(documentDeletes, 0);
  assert.equal(fileDeletes, 0);
});

test('fact-suggestion provider history prevents direct source deletion', () => {
  assert.match(
    prismaSchema,
    /sourceDocument\s+TrainingSourceDocument\?\s+@relation\([\s\S]*?onDelete:\s*NoAction\)/u,
  );
  assert.match(
    prismaSchema,
    /sourceOfficialUrl\s+TrainingOfficialUrlSource\?\s+@relation\([\s\S]*?onDelete:\s*NoAction\)/u,
  );
});

test('document service rejects extension and MIME mismatches before storage', async () => {
  let uploads = 0;
  const service = new TrainingDocumentsService(
    {
      trainingProjectVersion: {
        findUnique: async () => ({
          id: '11111111-1111-4111-8111-111111111111',
          status: 'DRAFT',
        }),
      },
    },
    {
      uploadPrivateTrainingDocument: async () => {
        uploads += 1;
      },
    },
  );

  await assert.rejects(
    () =>
      service.uploadDocument(
        '11111111-1111-4111-8111-111111111111',
        {
          fieldname: 'file',
          originalname: 'fake.docx',
          encoding: '7bit',
          mimetype: 'application/pdf',
          size: 4,
          buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        },
        { id: '44444444-4444-4444-8444-444444444444' },
        { headers: {} },
      ),
    /MIME type does not match/u,
  );
  assert.equal(uploads, 0);
});

test('PDF adapter extracts page text with page locators', async () => {
  const registry = new TrainingDocumentExtractorRegistry();
  const pdf = await createPdf('Platforma training PDF');
  const result = await registry.extract('PDF', pdf);

  assert.match(result.text, /Platforma training PDF/);
  assert.deepEqual(result.segments[0].locator, { page: 1 });
  assert.equal(result.needsManualText, false);
});

test('DOCX adapter extracts paragraphs with section locators', async () => {
  const registry = new TrainingDocumentExtractorRegistry();
  const documentXml = Buffer.from(
    '<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Расположение</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Пять минут до метро</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  );
  const result = await registry.extract(
    'DOCX',
    createStoredZip([{ name: 'word/document.xml', data: documentXml }]),
  );

  assert.match(result.text, /Пять минут до метро/u);
  assert.deepEqual(result.segments[1].locator, {
    section: 'Расположение',
    paragraph: 2,
  });
});

test('PPTX adapter extracts slide text with slide locators', async () => {
  const registry = new TrainingDocumentExtractorRegistry();
  const slideXml = Buffer.from(
    '<?xml version="1.0"?><p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld>' +
      '<a:p><a:r><a:t>Архитектура проекта</a:t></a:r></a:p>' +
      '</p:cSld></p:sld>',
  );
  const result = await registry.extract(
    'PPTX',
    createStoredZip([{ name: 'ppt/slides/slide1.xml', data: slideXml }]),
  );

  assert.match(result.text, /Архитектура проекта/u);
  assert.deepEqual(result.segments[0].locator, { slide: 1 });
});

test('XLSX adapter extracts cells, resolves sheet names and skips formulas', async () => {
  const registry = new TrainingDocumentExtractorRegistry();
  const entries = [
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        '<?xml version="1.0"?><workbook xmlns:r="urn:r"><sheets>' +
          '<sheet name="Факты" r:id="rId1"/></sheets></workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from(
        '<?xml version="1.0"?><worksheet><sheetData><row>' +
          '<c r="A1" t="inlineStr"><is><t>Класс жилья</t></is></c>' +
          '<c r="B1"><f>1+1</f><v>2</v></c>' +
          '</row></sheetData></worksheet>',
      ),
    },
  ];
  const result = await registry.extract('XLSX', createStoredZip(entries));

  assert.equal(result.text, 'Класс жилья');
  assert.deepEqual(result.segments[0].locator, { sheet: 'Факты', cell: 'A1' });
});

test('OOXML adapter rejects unsafe paths and excessive ZIP entry counts', async () => {
  const registry = new TrainingDocumentExtractorRegistry();

  await assert.rejects(
    () =>
      registry.extract(
        'DOCX',
        createStoredZip([
          { name: '../word/document.xml', data: Buffer.from('<document/>') },
        ]),
      ),
    /unsafe path/u,
  );

  const entries = Array.from(
    { length: config.TRAINING_MAX_DOCUMENT_ZIP_ENTRIES + 1 },
    (_, index) => ({ name: `safe/${index}.xml`, data: Buffer.alloc(0) }),
  );
  await assert.rejects(
    () => registry.extract('DOCX', createStoredZip(entries)),
    /entry limit/u,
  );
});

function createPdf(text) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ autoFirstPage: false, compress: false });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.addPage();
    document.fontSize(18).text(text);
    document.end();
  });
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
