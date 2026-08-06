require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const PDFDocument = require('pdfkit');

const {
  createTrainingMaterialDiff,
  isExactSegmentExcerpt,
  normalizeTrainingMaterialText,
  TrainingMaterialExtractionService,
} = require('../dist/training/training-material-extraction.js');
const {
  DeterministicFakeTrainingMaterialSuggester,
  canonicalTrainingFact,
  prepareQuestionSourceSegments,
  prepareTrainingQuestionKnowledge,
  TRAINING_QUESTION_COMPILER_VERSION,
  validateQuestionDraftGeneration,
} = require('../dist/training/training-material-suggester.js');
const { TrainingMaterialService } = require('../dist/training/training-material.service.js');
const { TrainingOpenAIError } = require('../dist/training/training-openai-client.js');
const {
  isPublicIpAddress,
  TrainingUrlExtractor,
  validateTrainingOfficialUrl,
} = require('../dist/training/training-url-extractor.js');
const { parseTrainingProjectSnapshot } = require('../dist/training/training-snapshot.js');

test('manual extraction normalizes paragraphs and deterministic diff keeps old revision identity', () => {
  const extraction = new TrainingMaterialExtractionService();
  const first = extraction.extractManual('  Первый\r\n\r\n  Второй  текст ');
  const second = extraction.extractManual('Первый\n\nТретий текст');
  const diff = createTrainingMaterialDiff('revision-1', first.segments, second.segments);

  assert.equal(first.text, 'Первый\n\nВторой текст');
  assert.deepEqual(first.segments.map((item) => item.locator), ['paragraph:1', 'paragraph:2']);
  assert.equal(diff.previousRevisionId, 'revision-1');
  assert.equal(diff.changed, true);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.unchangedCount, 1);
  assert.equal(isExactSegmentExcerpt(first.segments, 'paragraph:2', 'Второй  текст'), true);
});

test('synthetic PDF extracts page text with page locators and rejects empty text layer', async () => {
  const extraction = new TrainingMaterialExtractionService();
  const pdf = await makePdf(['First page text', 'Second page text']);
  const parsed = await extraction.extractPdf(pdf);

  assert.equal(parsed.metadata.pageCount, 2);
  assert.deepEqual(parsed.segments.map((item) => item.locator), ['page:1', 'page:2']);
  assert.deepEqual(parsed.segments.map((item) => item.label), ['Страница 1', 'Страница 2']);
  assert.match(parsed.text, /First page text/);

  const blank = await makePdf(['']);
  await assert.rejects(() => extraction.extractPdf(blank), /PDF_TEXT_LAYER_MISSING/);
  await assert.rejects(() => extraction.extractPdf(Buffer.from('not a pdf')), /PDF_INVALID/);

  const protectedPdf = await makePdf(['Protected'], { userPassword: 'secret' });
  await assert.rejects(() => extraction.extractPdf(protectedPdf), /PDF_PASSWORD_PROTECTED/);

  const previousTimeout = process.env.TRAINING_MATERIAL_EXTRACTION_TIMEOUT_MS;
  process.env.TRAINING_MATERIAL_EXTRACTION_TIMEOUT_MS = '1000';
  const originalExtractor = extraction.extractPdfWithinDeadline;
  extraction.extractPdfWithinDeadline = () => new Promise(() => undefined);
  await assert.rejects(() => extraction.extractPdf(pdf), /PDF_EXTRACTION_TIMEOUT/);
  extraction.extractPdfWithinDeadline = originalExtractor;
  if (previousTimeout === undefined) delete process.env.TRAINING_MATERIAL_EXTRACTION_TIMEOUT_MS;
  else process.env.TRAINING_MATERIAL_EXTRACTION_TIMEOUT_MS = previousTimeout;
});

test('official URL rejects SSRF shapes and extracts bounded semantic HTML through injected local fixture', async () => {
  const resolvePublic = async () => ['93.184.216.34'];
  await assert.rejects(() => validateTrainingOfficialUrl('http://example.com', resolvePublic), /URL_NOT_ALLOWED/);
  await assert.rejects(() => validateTrainingOfficialUrl('https://user@example.com', resolvePublic), /URL_NOT_ALLOWED/);
  await assert.rejects(() => validateTrainingOfficialUrl('https://example.com:444/', resolvePublic), /URL_NOT_ALLOWED/);
  await assert.rejects(() => validateTrainingOfficialUrl('https://127.0.0.1/', async () => ['127.0.0.1']), /URL_HOST_NOT_PUBLIC/);
  assert.equal(isPublicIpAddress('93.184.216.34'), true);
  assert.equal(isPublicIpAddress('169.254.169.254'), false);

  const extractor = new TrainingUrlExtractor(new TrainingMaterialExtractionService());
  const result = await extractor.extract('https://example.com/source', {
    resolveHost: resolvePublic,
    fetchImpl: async () => new Response(
      '<main><h1>Официальный проект</h1><p>Стабильное описание жилого комплекса для обучения сотрудников.</p><ul><li>Рядом метро</li></ul></main>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
  });
  assert.equal(result.metadata.method, 'HTTP');
  assert.equal(result.finalUrl, 'https://example.com/source');
  assert.match(result.text, /Стабильное описание/);
});

test('browser fallback stays disabled by default until explicitly enabled', async () => {
  const extractor = new TrainingUrlExtractor(new TrainingMaterialExtractionService());
  const dependencies = {
    resolveHost: async () => ['93.184.216.34'],
    fetchImpl: async () => new Response('<html><script>render()</script><body></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  };
  const previous = process.env.TRAINING_MATERIAL_BROWSER_FALLBACK_ENABLED;
  process.env.TRAINING_MATERIAL_BROWSER_FALLBACK_ENABLED = 'false';
  await assert.rejects(() => extractor.extract('https://example.com/js', dependencies), /BROWSER_FALLBACK_REQUIRED/);
  if (previous === undefined) delete process.env.TRAINING_MATERIAL_BROWSER_FALLBACK_ENABLED;
  else process.env.TRAINING_MATERIAL_BROWSER_FALLBACK_ENABLED = previous;
});

test('fake suggestions stay cited, deterministic and canonical duplicates ignore punctuation', async () => {
  const suggester = new DeterministicFakeTrainingMaterialSuggester();
  const input = {
    projectId: 'project',
    revisionId: 'revision',
    questions: [{ id: 'question', text: 'Что важно?' }],
    segments: [{ locator: 'page:1', label: 'Страница 1', text: 'Высота потолков составляет три метра. Другой текст.' }],
  };
  const first = await suggester.suggest(input);
  const second = await suggester.suggest(input);
  assert.deepEqual(first.suggestions, second.suggestions);
  assert.equal(first.model, second.model);
  assert.equal(first.suggestions[0].sourceLocator, 'page:1');
  assert.equal(first.suggestions[0].sourceExcerpt, 'Высота потолков составляет три метра.');
  assert.equal(canonicalTrainingFact('ЖК «Север»!'), canonicalTrainingFact('жк север'));
});

test('object materials generate one main and ten grounded draft questions without approving them', async () => {
  const suggester = new DeterministicFakeTrainingMaterialSuggester();
  const sourceSegments = [
    { locator: 'object-field:title', label: 'Название', text: 'Жилой комплекс Север.' },
    { locator: 'object-field:architecture', label: 'Архитектура', text: 'Фасады выполнены из клинкерного кирпича.' },
  ];
  const input = {
    projectId: 'project',
    objectId: 'object',
    objectTitle: 'Север',
    sources: [{
      materialId: 'material',
      revisionId: 'revision',
      materialTitle: 'Карточка Platforma · Север',
      materialType: 'OBJECT_SNAPSHOT',
      contentHash: questionContentHash(sourceSegments),
      segments: sourceSegments,
    }],
  };
  const first = await suggester.generateQuestionDrafts(input);
  const second = await suggester.generateQuestionDrafts(input);
  const segments = prepareQuestionSourceSegments(input.sources);

  assert.equal(first.followUps.length, 10);
  assert.equal(new Set([first.main.text, ...first.followUps.map((question) => question.text)]).size, 11);
  assert.deepEqual(
    { main: first.main, followUps: first.followUps },
    { main: second.main, followUps: second.followUps },
  );
  for (const question of [first.main, ...first.followUps]) {
    assert.ok(question.facts.length >= 1 && question.facts.length <= 3);
    assert.equal(question.facts.some((fact) => fact.isRequired), true);
    for (const fact of question.facts) {
      const factSource = segments.find((segment) => segment.locator === fact.sourceLocator);
      assert.ok(factSource.text.includes(fact.sourceExcerpt));
    }
  }

  assert.throws(() => validateQuestionDraftGeneration({
    main: { ...first.main, facts: [] },
    followUps: first.followUps,
  }, segments), /OBJECT_QUESTION_DRAFTS_INVALID/);
  assert.throws(() => validateQuestionDraftGeneration({
    main: {
      ...first.main,
      facts: Array.from({ length: 4 }, (_, index) => ({
        ...first.main.facts[0],
        statement: `Уникальный проверяемый факт ${index + 1}`,
      })),
    },
    followUps: first.followUps,
  }, segments), /OBJECT_QUESTION_DRAFTS_INVALID/);
  assert.doesNotThrow(() => validateQuestionDraftGeneration({
    main: {
      ...first.main,
      facts: [{
        ...first.main.facts[0],
        aliases: [Array.from({ length: 15 }, (_, index) => String(index + 1)).join(' ')],
      }],
    },
    followUps: first.followUps,
  }, segments));
  assert.throws(() => validateQuestionDraftGeneration({
    main: {
      ...first.main,
      facts: [{
        ...first.main.facts[0],
        aliases: [Array.from({ length: 16 }, (_, index) => String(index + 1)).join(' ')],
      }],
    },
    followUps: first.followUps,
  }, segments), /OBJECT_QUESTION_DRAFTS_INVALID/);
  assert.throws(() => validateQuestionDraftGeneration({
    main: {
      ...first.main,
      facts: [{ ...first.main.facts[0], sourceExcerpt: 'Нет такой цитаты в источнике.' }],
    },
    followUps: first.followUps,
  }, segments), /OBJECT_QUESTION_DRAFTS_INVALID/);
});

test('question generation provider failures use a safe API error', async () => {
  const service = new TrainingMaterialService(
    null,
    null,
    null,
    null,
    {
      generateQuestionDrafts: async () => {
        throw new TrainingOpenAIError('OBJECT_QUESTION_DRAFTS_INVALID', false);
      },
    },
    {
      compile: async () => {
        throw new TrainingOpenAIError('OBJECT_QUESTION_DRAFTS_INVALID', false);
      },
    },
  );

  await assert.rejects(
    () => service.generateQuestionDrafts({
      projectId: 'project',
      objectId: 'object',
      objectTitle: 'Север',
      sources: [],
    }),
    (error) => {
      assert.equal(error.getStatus(), 502);
      assert.equal(error.message, 'QUESTION_DRAFT_GENERATION_FAILED');
      return true;
    },
  );
});

test('large object question context stays bounded while representing every imported material', () => {
  const sources = Array.from({ length: 3 }, (_, index) => {
    const segments = [{
      locator: index === 0 ? 'object-field:description' : 'page:1',
      label: index === 0 ? 'Описание' : 'Страница 1',
      text: String(index).repeat(50_000),
    }];
    return {
      materialId: `material-${index}`,
      revisionId: `revision-${index}`,
      materialTitle: `Источник ${index}`,
      materialType: index === 0 ? 'OBJECT_SNAPSHOT' : 'PDF',
      contentHash: questionContentHash(segments),
      segments,
    };
  });
  const segments = prepareQuestionSourceSegments(sources);
  const prepared = prepareTrainingQuestionKnowledge({
    projectId: 'project', objectId: 'object', objectTitle: 'Object', sources,
  });

  assert.ok(segments.reduce((total, segment) => total + segment.text.length, 0) <= 30_000);
  assert.deepEqual(
    new Set([...prepared.references.values()].map((reference) => reference.sourceRevisionId)),
    new Set(['revision-0', 'revision-1', 'revision-2']),
  );
});

test('question knowledge deduplicates exact content with stable hash and fresh provenance', () => {
  const source = ({ materialId, revisionId, title, type = 'PDF', segments }) => ({
    materialId,
    revisionId,
    materialTitle: title,
    materialType: type,
    contentHash: questionContentHash(segments),
    segments,
  });
  const prepare = (sources) => prepareTrainingQuestionKnowledge({
    projectId: 'project',
    objectId: 'object',
    objectTitle: 'Север',
    sources,
  });
  const canonical = source({
    materialId: 'material-a',
    revisionId: 'revision-a',
    title: 'Первое имя.pdf',
    segments: [
      { locator: 'page:1', label: 'Страница 1', text: 'Первый проверяемый факт.' },
      { locator: 'page:2', label: 'Страница 2', text: 'Второй проверяемый факт.' },
    ],
  });
  const duplicate = source({
    materialId: 'material-z',
    revisionId: 'revision-z',
    title: 'Другое имя и metadata',
    type: 'OFFICIAL_URL',
    segments: [{
      locator: 'url:body',
      label: 'Другой заголовок',
      text: 'Первый проверяемый факт.\n\nВторой проверяемый факт.',
    }],
  });
  const distinct = source({
    materialId: 'material-b',
    revisionId: 'revision-b',
    title: 'Другой документ.pdf',
    segments: [{ locator: 'page:1', label: 'Страница 1', text: 'Совсем другой факт.' }],
  });

  assert.equal(canonical.contentHash, duplicate.contentHash);
  assert.notEqual(canonical.contentHash, distinct.contentHash);

  const single = prepare([canonical]);
  const withDuplicate = prepare([canonical, duplicate]);
  const reordered = prepare([duplicate, canonical]);
  const withDistinct = prepare([canonical, distinct]);
  const withDistinctReordered = prepare([distinct, canonical]);
  const afterCanonicalArchive = prepare([duplicate]);

  assert.equal(TRAINING_QUESTION_COMPILER_VERSION, 'training-question-compiler-v3');
  assert.equal(withDuplicate.sourceManifest.length, 1);
  assert.equal(withDistinct.sourceManifest.length, 2);
  assert.equal(withDuplicate.sourceHash, single.sourceHash);
  assert.equal(reordered.sourceHash, single.sourceHash);
  assert.deepEqual(reordered.segments, single.segments);
  assert.notEqual(withDistinct.sourceHash, single.sourceHash);
  assert.equal(withDistinctReordered.sourceHash, withDistinct.sourceHash);
  assert.deepEqual(withDistinctReordered.segments, withDistinct.segments);
  assert.equal(afterCanonicalArchive.sourceHash, single.sourceHash);
  assert.deepEqual(afterCanonicalArchive.segments, single.segments);
  assert.deepEqual(
    new Set([...withDuplicate.references.values()].map((reference) => reference.sourceRevisionId)),
    new Set(['revision-a']),
  );
  assert.deepEqual(
    new Set([...afterCanonicalArchive.references.values()].map((reference) => reference.sourceRevisionId)),
    new Set(['revision-z']),
  );
  assert.deepEqual(
    new Set([...afterCanonicalArchive.references.values()].map((reference) => reference.sourceLocator)),
    new Set(['url:body']),
  );

  const rawChars = [canonical, duplicate].reduce(
    (total, item) => total + questionSourceText(item.segments).length,
    0,
  );
  assert.equal(rawChars, single.fullSourceChars * 2);
  assert.equal(withDuplicate.fullSourceChars, single.fullSourceChars);

  const previousBudget = process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS;
  try {
    process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS = '30000';
    const thirtyThousand = prepare([canonical]);
    process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS = '20000';
    const twentyThousand = prepare([canonical]);
    assert.notEqual(thirtyThousand.sourceHash, twentyThousand.sourceHash);
  } finally {
    if (previousBudget === undefined) {
      delete process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS;
    } else {
      process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS = previousBudget;
    }
  }
});

function questionSourceText(segments) {
  return segments.map((segment) => normalizeTrainingMaterialText(segment.text)).join('\n\n');
}

function questionContentHash(segments) {
  return createHash('sha256').update(questionSourceText(segments)).digest('hex');
}

test('snapshot v3 freezes bounded citation while v1 and v2 remain readable', () => {
  const base = makeSnapshot(2);
  assert.equal(parseTrainingProjectSnapshot(base).schemaVersion, 2);
  const v3 = {
    ...base,
    schemaVersion: 3,
    questions: base.questions.map((question, index) => ({
      ...question,
      facts: question.facts.map((fact) => ({
        ...fact,
        sourceType: index === 0 ? 'MATERIAL' : 'MANUAL',
        sourceLabel: index === 0 ? 'PDF проекта' : 'Добавлено вручную',
        sourceLocator: index === 0 ? 'page:1' : null,
        sourceExcerpt: index === 0 ? 'Факт 0' : null,
        sourceRevisionId: index === 0 ? 'revision-id' : null,
        sourceMaterialType: index === 0 ? 'PDF' : null,
        sourceUrl: null,
      })),
    })),
  };
  const parsed = parseTrainingProjectSnapshot(v3);
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.questions[0].facts[0].sourceRevisionId, 'revision-id');
  assert.equal(parseTrainingProjectSnapshot({
    schemaVersion: 1,
    projectTitle: base.projectTitle,
    settings: base.settings,
    questions: base.questions.map(({ facts: _facts, ...question }) => question),
  }).schemaVersion, 1);
  assert.throws(() => parseTrainingProjectSnapshot({
    ...v3,
    questions: v3.questions.map((question, index) => index === 0
      ? { ...question, facts: [{ ...question.facts[0], sourceExcerpt: null }] }
      : question),
  }), /Invalid training snapshot fact source|Invalid/);
});

function makePdf(pages, options = {}) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ autoFirstPage: false, ...options });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    for (const text of pages) {
      document.addPage();
      if (text) document.fontSize(16).text(text);
    }
    document.end();
  });
}

function makeSnapshot(schemaVersion) {
  return {
    schemaVersion,
    projectTitle: 'Stage 4',
    relatedObjectTitle: 'ЖК Север',
    settings: { attemptLimit: 3, timeLimitSeconds: 420, passScore: 75, allowRetakeAfterPass: false },
    scoringVersion: 'training-v2-scoring-v1',
    evaluationSchemaVersion: 'training-v2-evaluation-v1',
    criteria: {
      main: [{ id: 'criterion-main', code: 'main', title: 'Main', guidance: '', maxPoints: 55, position: 1 }],
      followUp: [{ id: 'criterion-follow', code: 'follow', title: 'Follow', guidance: '', maxPoints: 15, position: 1 }],
    },
    questions: Array.from({ length: 11 }, (_, index) => ({
      sourceQuestionId: `question-${index}`,
      type: index === 0 ? 'MAIN' : 'FOLLOW_UP',
      text: `Вопрос ${index}`,
      position: index === 0 ? 1 : index,
      facts: [{ id: `fact-${index}`, statement: `Факт ${index}`, aliases: [], required: true, position: 1 }],
    })),
  };
}
