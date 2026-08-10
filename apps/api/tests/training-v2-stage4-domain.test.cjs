require('reflect-metadata');

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const test = require('node:test');
const PDFDocument = require('pdfkit');

const {
  createTrainingMaterialDiff,
  isExactSegmentExcerpt,
  normalizeTrainingEvidenceText,
  normalizeTrainingMaterialText,
  TrainingMaterialExtractionService,
} = require('../dist/training/training-material-extraction.js');
const {
  DeterministicFakeTrainingMaterialSuggester,
  canonicalTrainingFact,
  createTrainingQuestionContextMetrics,
  createTrainingQuestionQualityContext,
  isDeterministicallyGenericFollowUp,
  prepareQuestionAIEvidence,
  prepareQuestionSourceSegments,
  prepareTrainingQuestionKnowledge,
  TRAINING_QUESTION_COMPILER_VERSION,
  validateQuestionDraftGeneration,
} = require('../dist/training/training-material-suggester.js');
const {
  chooseTrainingQuestionContextBudget,
  TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION,
} = require('../dist/training/training-question-context-budget.js');
const {
  readQuestionSourceReuseMetadata,
  TrainingMaterialService,
} = require('../dist/training/training-material.service.js');
const { TrainingOpenAIError } = require('../dist/training/training-openai-client.js');
const {
  createTrainingQuestionGenerationArtifactPayload,
  createTrainingQuestionGenerationPlan,
  hashTrainingQuestionGenerationKey,
  materializeTrainingQuestionGenerationArtifact,
} = require('../dist/training/training-question-generation-artifact.js');
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

test('question quality gate v1 covers min(3, N) canonical sources after deduplication', () => {
  const sources = ['A', 'B', 'C', 'D'].map((label, index) => questionSource({
    materialId: `material-quality-${label}`,
    revisionId: `revision-quality-${label}`,
    title: `Источник ${label}`,
    segments: [{
      locator: `page:${index + 1}`,
      label: `Страница ${index + 1}`,
      text: `Уникальная предметная характеристика ${label} подтверждена документом.`,
    }],
  }));
  const input = {
    projectId: 'project-quality',
    objectId: 'object-quality',
    objectTitle: 'Северный Порт',
    sources,
  };
  const prepared = prepareTrainingQuestionKnowledge(input);
  const quality = createTrainingQuestionQualityContext(prepared, input.objectTitle);
  const locators = prepared.segments.map((segment) => segment.locator);
  const makeDrafts = (coveredLocators, sourcePrepared = prepared) => {
    const question = (index) => {
      const locator = coveredLocators[index % coveredLocators.length];
      const segment = sourcePrepared.segments.find((candidate) => candidate.locator === locator);
      return {
        text: `Какая предметная характеристика подтверждена документом, часть ${index}?`,
        facts: [{
          statement: `Предметный факт ${index}`,
          aliases: [],
          isRequired: true,
          sourceLocator: locator,
          sourceExcerpt: segment.text,
        }],
      };
    };
    return {
      main: question(0),
      followUps: Array.from({ length: 10 }, (_, index) => question(index + 1)),
    };
  };

  assert.equal(quality.canonicalSourceCount, 4);
  assert.throws(
    () => validateQuestionDraftGeneration(
      makeDrafts(locators.slice(0, 2)), prepared.segments, false, quality,
    ),
    /OBJECT_QUESTION_DRAFTS_INVALID/,
  );
  assert.doesNotThrow(() => validateQuestionDraftGeneration(
    makeDrafts(locators.slice(0, 3)), prepared.segments, false, quality,
  ));

  const duplicatePrepared = prepareTrainingQuestionKnowledge({
    ...input,
    sources: [...sources, {
      ...sources[0],
      materialId: 'material-quality-A-copy',
      revisionId: 'revision-quality-A-copy',
    }],
  });
  assert.equal(duplicatePrepared.sourceManifest.length, 4);
  assert.equal(
    createTrainingQuestionQualityContext(duplicatePrepared, input.objectTitle)
      .canonicalSourceCount,
    4,
  );

  const reorderedPrepared = prepareTrainingQuestionKnowledge({
    ...input,
    sources: [...sources].reverse(),
  });
  const reorderedQuality = createTrainingQuestionQualityContext(
    reorderedPrepared,
    input.objectTitle,
  );
  assert.equal(reorderedQuality.canonicalSourceCount, 4);
  assert.deepEqual(
    [...new Set(reorderedQuality.canonicalSourceKeysByLocator.values())].sort(),
    [...new Set(quality.canonicalSourceKeysByLocator.values())].sort(),
  );

  const singlePrepared = prepareTrainingQuestionKnowledge({
    ...input,
    sources: [sources[0]],
  });
  const singleQuality = createTrainingQuestionQualityContext(
    singlePrepared,
    input.objectTitle,
  );
  assert.equal(singleQuality.canonicalSourceCount, 1);
  assert.doesNotThrow(() => validateQuestionDraftGeneration(
    makeDrafts([singlePrepared.segments[0].locator], singlePrepared),
    singlePrepared.segments,
    false,
    singleQuality,
  ));

  const multiLocatorSource = questionSource({
    materialId: 'material-quality-multi',
    revisionId: 'revision-quality-multi',
    title: 'Источник с двумя локаторами',
    segments: [
      {
        locator: 'page:10',
        label: 'Страница 10',
        text: 'Паркинг рассчитан на сто автомобилей.',
      },
      {
        locator: 'page:11',
        label: 'Страница 11',
        text: 'Высота потолков составляет три метра.',
      },
    ],
  });
  const twoSourcePrepared = prepareTrainingQuestionKnowledge({
    ...input,
    sources: [multiLocatorSource, sources[1]],
  });
  const twoSourceQuality = createTrainingQuestionQualityContext(
    twoSourcePrepared,
    input.objectTitle,
  );
  const multiSourceLocators = twoSourcePrepared.segments
    .filter((segment) => twoSourcePrepared.references.get(segment.locator)
      ?.sourceRevisionId === multiLocatorSource.revisionId)
    .map((segment) => segment.locator);
  const secondSourceLocator = twoSourcePrepared.segments.find(
    (segment) => twoSourcePrepared.references.get(segment.locator)
      ?.sourceRevisionId === sources[1].revisionId,
  ).locator;
  assert.equal(twoSourceQuality.canonicalSourceCount, 2);
  assert.equal(multiSourceLocators.length, 2);
  assert.equal(
    new Set(multiSourceLocators.map((locator) =>
      twoSourceQuality.canonicalSourceKeysByLocator.get(locator),
    )).size,
    1,
  );
  assert.throws(() => validateQuestionDraftGeneration(
    makeDrafts(multiSourceLocators, twoSourcePrepared),
    twoSourcePrepared.segments,
    false,
    twoSourceQuality,
  ), /OBJECT_QUESTION_DRAFTS_INVALID/);
  assert.doesNotThrow(() => validateQuestionDraftGeneration(
    makeDrafts([multiSourceLocators[0], secondSourceLocator], twoSourcePrepared),
    twoSourcePrepared.segments,
    false,
    twoSourceQuality,
  ));
});

test('generic FOLLOW_UP gate rejects boilerplate and allows short subject questions', () => {
  const rejected = [
    'Что важно знать о ЖК «Север»?',
    'Расскажите об объекте.',
    'Какие особенности проекта?',
    'Что ещё нужно знать?',
    'Какая информация есть в материалах?',
    'Какие параметры объекта?',
    'Что?',
    '???',
    '123?',
  ];
  const accepted = [
    'Какой класс?',
    'Где метро?',
    'Есть паркинг?',
    'Какая отделка?',
    'Какие фасады?',
    'Какая этажность?',
    'Когда ввод?',
    'Какая высота потолков?',
    'Что с ДДУ?',
    'Применяется 214-ФЗ?',
    'Есть кладовые?',
    'Кто девелопер?',
    'Адрес?',
    'МОП?',
    'Какие параметры паркинга?',
  ];

  for (const question of rejected) {
    assert.equal(isDeterministicallyGenericFollowUp(question, 'Север'), true, question);
  }
  for (const question of accepted) {
    assert.equal(isDeterministicallyGenericFollowUp(question, 'Север'), false, question);
  }
  assert.equal(
    isDeterministicallyGenericFollowUp('Где расположен порт въезда?', 'Северный Порт'),
    false,
  );
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

test('adaptive question context budget is evidence-derived and keeps the 30k production ceiling', () => {
  const choose = (uniqueChars, maximumChars, uniqueFragments = 1, uniqueSources = 1) =>
    chooseTrainingQuestionContextBudget(
      { uniqueChars, uniqueFragments, uniqueSources },
      { maximumChars },
    );

  assert.deepEqual(choose(124, 30_000), {
    chosenBudget: 124,
    policyVersion: TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION,
  });
  assert.equal(choose(18_000, 30_000, 18, 3).chosenBudget, 18_000);
  assert.equal(choose(30_000, 30_000, 30, 3).chosenBudget, 30_000);
  assert.equal(choose(45_000, 30_000, 45, 3).chosenBudget, 30_000);
  assert.equal(choose(200_000, 120_000, 200, 4).chosenBudget, 120_000);
  assert.throws(
    () => chooseTrainingQuestionContextBudget(
      { uniqueChars: 1, uniqueFragments: 1, uniqueSources: 1 },
      { maximumChars: 120_001 },
    ),
    /TRAINING_QUESTION_CONTEXT_MAX_CHARS_INVALID/u,
  );
});

test('question budget benchmark is skipped before reading provider configuration', () => {
  const result = spawnSync(process.execPath, [
    resolve(__dirname, 'training-v2-question-budget-benchmark.cjs'),
  ], {
    cwd: resolve(__dirname, '../../..'),
    env: {
      ...process.env,
      OPENAI_QUESTION_BUDGET_BENCHMARK_ENABLED: 'false',
      OPENAI_API_KEY: 'must-not-be-used',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'skipped',
    reason: 'OPENAI_QUESTION_BUDGET_BENCHMARK_DISABLED',
    required: ['OPENAI_QUESTION_BUDGET_BENCHMARK_ENABLED=true'],
  });
});

test('Luna/Terra benchmark is skipped before reading provider configuration', () => {
  const result = spawnSync(
    process.execPath,
    ['apps/api/tests/training-v2-luna-terra-benchmark.cjs'],
    {
      cwd: resolve(__dirname, '../../..'),
      env: {
        ...process.env,
        OPENAI_LUNA_TERRA_BENCHMARK_ENABLED: 'false',
        OPENAI_API_KEY: '',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'skipped',
    reason: 'OPENAI_LUNA_TERRA_BENCHMARK_DISABLED',
    required: ['OPENAI_LUNA_TERRA_BENCHMARK_ENABLED=true'],
  });
});

test('coverage-first selection represents every unique source under a constrained budget', () => {
  const sourceA = questionSource({
    materialId: 'material-coverage-a',
    revisionId: 'revision-coverage-a',
    title: 'Coverage A',
    segments: Array.from({ length: 4 }, (_, index) => ({
      locator: `page:${index + 1}`,
      label: `Страница ${index + 1}`,
      text: sizedEvidenceText(`Источник A ${index}`, 1_100),
    })),
  });
  const sourceB = questionSource({
    materialId: 'material-coverage-b',
    revisionId: 'revision-coverage-b',
    title: 'Coverage B',
    segments: [{
      locator: 'page:1',
      label: 'Страница 1',
      text: sizedEvidenceText('Источник B 2029', 650),
    }],
  });
  const input = {
    projectId: 'project-coverage',
    objectId: 'object-coverage',
    objectTitle: 'Север',
    sources: [sourceA, sourceB],
  };
  const prepared = prepareTrainingQuestionKnowledge(input, { sourceMaximumChars: 5_000 });
  const reordered = prepareTrainingQuestionKnowledge(
    { ...input, sources: [...input.sources].reverse() },
    { sourceMaximumChars: 5_000 },
  );

  assert.equal(prepared.evidenceMetrics.uniqueChars, 5_050);
  assert.equal(prepared.evidenceMetrics.chosenBudget, 5_000);
  assert.ok(prepared.evidenceMetrics.selectedChars <= 5_000);
  assert.equal(prepared.evidenceMetrics.uniqueSources, 2);
  assert.equal(prepared.evidenceMetrics.representedSources, 2);
  assert.deepEqual(prepared.segments, reordered.segments);
  assert.equal(prepared.sourceHash, reordered.sourceHash);
  assert.equal(
    prepared.segments.some((segment) => segment.text.includes('2029')),
    true,
  );
});

test('coverage selection finds short representatives when a long shared fragment would exhaust the cap', () => {
  const shared = sizedEvidenceText('Общий длинный фрагмент', 1_199);
  const sources = [
    questionSource({
      materialId: 'material-cover-a',
      revisionId: 'revision-cover-a',
      title: 'Cover A',
      segments: [
        { locator: 'page:1', label: 'Страница 1', text: shared },
        { locator: 'page:2', label: 'Страница 2', text: sizedEvidenceText('Короткий A', 100) },
      ],
    }),
    questionSource({
      materialId: 'material-cover-b',
      revisionId: 'revision-cover-b',
      title: 'Cover B',
      segments: [
        { locator: 'page:1', label: 'Страница 1', text: shared },
        { locator: 'page:2', label: 'Страница 2', text: sizedEvidenceText('Короткий B', 100) },
      ],
    }),
    ...['C', 'D', 'E', 'F'].map((suffix) => questionSource({
      materialId: `material-cover-${suffix.toLowerCase()}`,
      revisionId: `revision-cover-${suffix.toLowerCase()}`,
      title: `Cover ${suffix}`,
      segments: [{
        locator: 'page:1',
        label: 'Страница 1',
        text: sizedEvidenceText(`Источник ${suffix}`, 1_200),
      }],
    })),
  ];

  const prepared = prepareTrainingQuestionKnowledge({
    projectId: 'project-cover-feasible',
    objectId: 'object-cover-feasible',
    objectTitle: 'Покрытие',
    sources,
  }, { sourceMaximumChars: 5_000 });

  assert.equal(prepared.evidenceMetrics.uniqueSources, 6);
  assert.equal(prepared.evidenceMetrics.representedSources, 6);
  assert.ok(prepared.evidenceMetrics.selectedChars <= 5_000);
  assert.equal(
    prepared.segments.some((segment) => segment.text.includes('Короткий A')),
    true,
  );
  assert.equal(
    prepared.segments.some((segment) => segment.text.includes('Короткий B')),
    true,
  );
});

test('coverage selection uses one shared representative when individual fragments exceed the cap', () => {
  const shared = sizedEvidenceText('Общий источник для шести документов', 1_000);
  const sources = ['A', 'B', 'C', 'D', 'E', 'F'].map((suffix) => questionSource({
    materialId: `material-shared-cover-${suffix.toLowerCase()}`,
    revisionId: `revision-shared-cover-${suffix.toLowerCase()}`,
    title: `Shared cover ${suffix}`,
    segments: [
      { locator: 'page:1', label: 'Страница 1', text: shared },
      {
        locator: 'page:2',
        label: 'Страница 2',
        text: sizedEvidenceText(`Индивидуальный источник ${suffix}`, 900),
      },
    ],
  }));

  const prepared = prepareTrainingQuestionKnowledge({
    projectId: 'project-shared-cover',
    objectId: 'object-shared-cover',
    objectTitle: 'Общее покрытие',
    sources,
  }, { sourceMaximumChars: 5_000 });

  assert.equal(prepared.evidenceMetrics.uniqueSources, 6);
  assert.equal(prepared.evidenceMetrics.representedSources, 6);
  assert.ok(prepared.evidenceMetrics.selectedChars <= 5_000);
  assert.equal(
    prepared.segments.some((segment) => segment.text === shared),
    true,
  );
});

test('minimum source cover preserves all unique numeric fragments inside the cap', () => {
  const sharedA = sizedEvidenceText('Покрытие источников один два три четыре', 1_200);
  const sharedB = sizedEvidenceText('Покрытие источников один два три', 1_000);
  const sharedC = sizedEvidenceText('Покрытие источников четыре пять шесть', 1_000);
  const numeric = [
    sizedEvidenceText('Уникальный числовой факт 2026', 1_000),
    sizedEvidenceText('Уникальный числовой факт 2027', 1_000),
    sizedEvidenceText('Уникальный числовой факт 2028', 1_000),
  ];
  const sourceSegments = [
    [sharedA, sharedB, numeric[0]],
    [sharedA, sharedB, numeric[1]],
    [sharedA, sharedB, numeric[2]],
    [sharedA, sharedC, sizedEvidenceText('Уникальный текст четыре', 1_000)],
    [sharedC, sizedEvidenceText('Уникальный текст пять', 1_000)],
    [sharedC, sizedEvidenceText('Уникальный текст шесть', 1_000)],
  ];
  const sources = sourceSegments.map((texts, index) => questionSource({
    materialId: `material-numeric-cover-${index + 1}`,
    revisionId: `revision-numeric-cover-${index + 1}`,
    title: `Numeric cover ${index + 1}`,
    segments: texts.map((text, segmentIndex) => ({
      locator: `page:${segmentIndex + 1}`,
      label: `Страница ${segmentIndex + 1}`,
      text,
    })),
  }));

  const prepared = prepareTrainingQuestionKnowledge({
    projectId: 'project-numeric-cover',
    objectId: 'object-numeric-cover',
    objectTitle: 'Числовое покрытие',
    sources,
  }, { sourceMaximumChars: 5_000 });

  assert.equal(prepared.evidenceMetrics.representedSources, 6);
  assert.equal(prepared.evidenceMetrics.selectedChars, 5_000);
  for (const value of ['2026', '2027', '2028']) {
    assert.equal(
      prepared.segments.some((segment) => segment.text.includes(value)),
      true,
    );
  }
});

test('numeric fragment can replace a shorter representative to preserve its fact inside the cap', () => {
  const numeric = sizedEvidenceText('Уникальный числовой факт 2029', 1_000);
  const sources = [
    questionSource({
      materialId: 'material-numeric-representative-1',
      revisionId: 'revision-numeric-representative-1',
      title: 'Numeric representative 1',
      segments: [
        {
          locator: 'page:1',
          label: 'Страница 1',
          text: sizedEvidenceText('Короткий текст без числа', 100),
        },
        { locator: 'page:2', label: 'Страница 2', text: numeric },
      ],
    }),
    ...['два', 'три', 'четыре', 'пять'].map((suffix, index) => questionSource({
      materialId: `material-numeric-representative-${index + 2}`,
      revisionId: `revision-numeric-representative-${index + 2}`,
      title: `Numeric representative ${index + 2}`,
      segments: [{
        locator: 'page:1',
        label: 'Страница 1',
        text: sizedEvidenceText(`Обязательный источник ${suffix}`, 1_000),
      }],
    })),
  ];

  const prepared = prepareTrainingQuestionKnowledge({
    projectId: 'project-numeric-representative',
    objectId: 'object-numeric-representative',
    objectTitle: 'Числовой представитель',
    sources,
  }, { sourceMaximumChars: 5_000 });

  assert.equal(prepared.evidenceMetrics.representedSources, 5);
  assert.equal(prepared.evidenceMetrics.selectedChars, 5_000);
  assert.equal(
    prepared.segments.some((segment) => segment.text === numeric),
    true,
  );
});

test('fully fitting overlap graph bypasses exact coverage search', () => {
  const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const pairText = new Map();
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = left + 1; right < labels.length; right += 1) {
      pairText.set(`${left}:${right}`, `Связь ${labels[left]}-${labels[right]}.`);
    }
  }
  const sources = labels.map((label, sourceIndex) => questionSource({
    materialId: `material-overlap-${label.toLowerCase()}`,
    revisionId: `revision-overlap-${label.toLowerCase()}`,
    title: `Overlap ${label}`,
    segments: labels.flatMap((_, otherIndex) => {
      if (sourceIndex === otherIndex) return [];
      const key = sourceIndex < otherIndex
        ? `${sourceIndex}:${otherIndex}`
        : `${otherIndex}:${sourceIndex}`;
      return [{
        locator: `pair:${key}`,
        label: `Связь ${key}`,
        text: pairText.get(key),
      }];
    }),
  }));

  const started = process.hrtime.bigint();
  const prepared = prepareTrainingQuestionKnowledge({
    projectId: 'project-overlap-fast-path',
    objectId: 'object-overlap-fast-path',
    objectTitle: 'Граф связей',
    sources,
  }, { sourceMaximumChars: 5_000 });
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;

  assert.equal(prepared.evidenceMetrics.uniqueSources, 26);
  assert.equal(prepared.evidenceMetrics.uniqueFragments, 325);
  assert.equal(
    prepared.evidenceMetrics.selectedFragments,
    prepared.evidenceMetrics.uniqueFragments,
  );
  assert.ok(durationMs < 1_000, `overlap fast path took ${durationMs.toFixed(1)} ms`);
});

test('30k and 24k plans use actual chosen budgets and distinct source hashes', () => {
  const sources = [questionSource({
    materialId: 'material-ab',
    revisionId: 'revision-ab',
    title: 'A/B evidence',
    segments: Array.from({ length: 30 }, (_, index) => ({
      locator: `page:${index + 1}`,
      label: `Страница ${index + 1}`,
      text: sizedEvidenceText(`Уникальный факт ${index}`, 1_000),
    })),
  })];
  const input = {
    projectId: 'project-ab',
    objectId: 'object-ab',
    objectTitle: 'Север',
    sources,
  };
  const thirty = prepareTrainingQuestionKnowledge(input, { sourceMaximumChars: 30_000 });
  const twentyFour = prepareTrainingQuestionKnowledge(input, { sourceMaximumChars: 24_000 });

  assert.equal(thirty.evidenceMetrics.uniqueChars, 30_000);
  assert.equal(thirty.evidenceMetrics.chosenBudget, 30_000);
  assert.equal(twentyFour.evidenceMetrics.chosenBudget, 24_000);
  assert.equal(thirty.evidenceMetrics.selectedChars, 30_000);
  assert.equal(twentyFour.evidenceMetrics.selectedChars, 24_000);
  assert.equal(thirty.evidenceMetrics.policyVersion, twentyFour.evidenceMetrics.policyVersion);
  assert.notEqual(thirty.sourceHash, twentyFour.sourceHash);
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

  assert.equal(TRAINING_QUESTION_COMPILER_VERSION, 'training-question-compiler-v7');
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
    assert.equal(thirtyThousand.evidenceMetrics.chosenBudget, single.evidenceMetrics.uniqueChars);
    assert.equal(twentyThousand.evidenceMetrics.chosenBudget, single.evidenceMetrics.uniqueChars);
    assert.equal(thirtyThousand.sourceHash, twentyThousand.sourceHash);
  } finally {
    if (previousBudget === undefined) {
      delete process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS;
    } else {
      process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS = previousBudget;
    }
  }
});

test('question evidence exact dedup keeps shared and source-specific facts with safe metrics', () => {
  const shared = 'Во дворе предусмотрена тихая зона отдыха.';
  const uniqueA = 'В первом корпусе предусмотрен коворкинг.';
  const uniqueB = 'Во втором корпусе предусмотрена колясочная.';
  const sourceA = questionSource({
    materialId: 'material-evidence-a',
    revisionId: 'revision-evidence-a',
    title: 'Источник A',
    segments: [
      { locator: 'page:1', label: 'Страница 1', text: shared },
      { locator: 'page:2', label: 'Страница 2', text: uniqueA },
    ],
  });
  const sourceB = questionSource({
    materialId: 'material-evidence-b',
    revisionId: 'revision-evidence-b',
    title: 'Источник B',
    type: 'OFFICIAL_URL',
    segments: [
      { locator: 'url:paragraph:1', label: 'Абзац 1', text: shared },
      { locator: 'url:paragraph:2', label: 'Абзац 2', text: uniqueB },
    ],
  });
  const duplicateUnion = questionSource({
    materialId: 'material-evidence-union',
    revisionId: 'revision-evidence-union',
    title: 'Источник без нового evidence',
    segments: [
      { locator: 'paragraph:3', label: 'Абзац 3', text: uniqueB },
      { locator: 'paragraph:2', label: 'Абзац 2', text: uniqueA },
      { locator: 'paragraph:1', label: 'Абзац 1', text: shared },
    ],
  });
  const prepare = (sources) => prepareTrainingQuestionKnowledge({
    projectId: 'project', objectId: 'object', objectTitle: 'Север', sources,
  });
  const prepared = prepare([sourceA, sourceB]);
  const reordered = prepare([sourceB, sourceA]);
  const withDuplicateUnion = prepare([duplicateUnion, sourceB, sourceA]);
  const normalizedRaw = [shared, uniqueA, shared, uniqueB].map(normalizeTrainingEvidenceText);
  const normalizedUnique = [...new Set(normalizedRaw)];

  assert.deepEqual(prepared.segments, reordered.segments);
  assert.deepEqual(prepared.segments, withDuplicateUnion.segments);
  assert.equal(prepared.sourceHash, reordered.sourceHash);
  assert.equal(prepared.sourceHash, withDuplicateUnion.sourceHash);
  assert.equal(
    prepared.evidenceMetrics.chosenBudget,
    withDuplicateUnion.evidenceMetrics.chosenBudget,
  );
  assert.deepEqual(prepared.evidenceMetrics, {
    rawFragments: 4,
    uniqueFragments: 3,
    selectedFragments: 3,
    rawChars: normalizedRaw.reduce((total, text) => total + text.length, 0),
    uniqueChars: normalizedUnique.reduce((total, text) => total + text.length, 0),
    selectedChars: normalizedUnique.reduce((total, text) => total + text.length, 0),
    chosenBudget: normalizedUnique.reduce((total, text) => total + text.length, 0),
    configuredMaximumChars: 30_000,
    uniqueSources: 2,
    representedSources: 2,
    policyVersion: TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION,
  });
  assert.equal(prepared.segments.filter((segment) => segment.text === shared).length, 1);
  assert.equal(prepared.segments.some((segment) => segment.text === uniqueA), true);
  assert.equal(prepared.segments.some((segment) => segment.text === uniqueB), true);

  const sharedSegment = prepared.segments.find((segment) => segment.text === shared);
  assert.ok(sharedSegment);
  const sharedReference = prepared.references.get(sharedSegment.locator);
  const canonical = [sourceA, sourceB].sort((left, right) =>
    left.contentHash.localeCompare(right.contentHash),
  )[0];
  assert.deepEqual(sharedReference, {
    evidenceHash: createHash('sha256').update(normalizeTrainingEvidenceText(shared)).digest('hex'),
    canonicalSourceKey: canonical.contentHash.substring(0, 24),
    sourceRevisionId: canonical.revisionId,
    sourceLabel: canonical.materialTitle,
    sourceLocator: canonical.segments[0].locator,
    sourceExcerpt: shared,
  });
  assert.equal(prepared.references.size, prepared.segments.length);
  for (const segment of prepared.segments) {
    const reference = prepared.references.get(segment.locator);
    const source = [sourceA, sourceB].find((item) => item.revisionId === reference?.sourceRevisionId);
    assert.ok(reference);
    assert.ok(source);
    assert.equal(
      isExactSegmentExcerpt(source.segments, reference.sourceLocator, segment.text),
      true,
    );
  }
});

test('question context structured metrics contain counts and validation only', () => {
  const secretMarker = 'private-person-name-and-document-text';
  const prepared = prepareTrainingQuestionKnowledge({
    projectId: 'sensitive-project-id',
    objectId: 'sensitive-object-id',
    objectTitle: 'Sensitive title',
    sources: [questionSource({
      materialId: 'sensitive-material-id',
      revisionId: 'sensitive-revision-id',
      title: 'Sensitive source title',
      segments: [{ locator: 'page:1', label: 'Sensitive label', text: secretMarker }],
    })],
  });
  const metrics = createTrainingQuestionContextMetrics(prepared, 'valid');
  const serialized = JSON.stringify(metrics);

  assert.deepEqual(Object.keys(metrics).sort(), [
    'chosenBudget',
    'configuredMaximumChars',
    'event',
    'operation',
    'policyVersion',
    'rawChars',
    'rawFragments',
    'representedSources',
    'selectedChars',
    'selectedFragments',
    'uniqueChars',
    'uniqueFragments',
    'uniqueSources',
    'validationResult',
  ]);
  assert.equal(metrics.validationResult, 'valid');
  assert.doesNotMatch(
    serialized,
    /private-person|sensitive-|source_locator|source_excerpt|api[_-]?key/iu,
  );
});

test('question evidence chunking stays stable when source count crosses the old threshold', () => {
  const texts = ['А', 'Б', 'В', 'Г'].map((character) => `${character.repeat(1_099)}.`);
  const sources = texts.map((text, index) => questionSource({
    materialId: `material-threshold-${index}`,
    revisionId: `revision-threshold-${index}`,
    title: `Порог ${index}`,
    segments: [{ locator: 'page:1', label: 'Страница 1', text }],
  }));
  const duplicateUnion = questionSource({
    materialId: 'material-threshold-union',
    revisionId: 'revision-threshold-union',
    title: 'Порог без нового evidence',
    segments: [
      { locator: 'page:2', label: 'Страница 2', text: texts[1] },
      { locator: 'page:1', label: 'Страница 1', text: texts[0] },
    ],
  });
  const prepare = (items) => prepareTrainingQuestionKnowledge({
    projectId: 'project', objectId: 'object', objectTitle: 'Север', sources: items,
  });
  const previousBudget = process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS;

  try {
    process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS = '5000';
    const base = prepare(sources);
    const withDuplicate = prepare([...sources, duplicateUnion]);

    assert.deepEqual(withDuplicate.segments, base.segments);
    assert.equal(withDuplicate.sourceHash, base.sourceHash);
    assert.deepEqual(base.evidenceMetrics, {
      rawFragments: 4,
      uniqueFragments: 4,
      selectedFragments: 4,
      rawChars: 4_400,
      uniqueChars: 4_400,
      selectedChars: 4_400,
      chosenBudget: 4_400,
      configuredMaximumChars: 5_000,
      uniqueSources: 4,
      representedSources: 4,
      policyVersion: TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION,
    });
    assert.deepEqual(withDuplicate.evidenceMetrics, {
      rawFragments: 6,
      uniqueFragments: 4,
      selectedFragments: 4,
      rawChars: 6_600,
      uniqueChars: 4_400,
      selectedChars: 4_400,
      chosenBudget: 4_400,
      configuredMaximumChars: 5_000,
      uniqueSources: 5,
      representedSources: 5,
      policyVersion: TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION,
    });
  } finally {
    if (previousBudget === undefined) {
      delete process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS;
    } else {
      process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS = previousBudget;
    }
  }
});

test('question evidence exact key preserves numeric differences', () => {
  const firstText = 'Срок сдачи — 2027 год, площадь 45 м², цена ≤ 12 млн ₽.';
  const secondText = 'Срок сдачи — 2028 год, площадь 46 м², цена ≤ 13 млн ₽.';
  const comparatorText = 'Срок сдачи — 2027 год, площадь 45 м², цена < 12 млн ₽.';
  const prepared = prepareTrainingQuestionKnowledge({
    projectId: 'project',
    objectId: 'object',
    objectTitle: 'Север',
    sources: [
      questionSource({
        materialId: 'material-numeric-a',
        revisionId: 'revision-numeric-a',
        title: 'Числа A',
        segments: [{ locator: 'page:1', label: 'Страница 1', text: firstText }],
      }),
      questionSource({
        materialId: 'material-numeric-b',
        revisionId: 'revision-numeric-b',
        title: 'Числа B',
        segments: [{ locator: 'page:1', label: 'Страница 1', text: secondText }],
      }),
      questionSource({
        materialId: 'material-numeric-c',
        revisionId: 'revision-numeric-c',
        title: 'Условие C',
        segments: [{ locator: 'page:1', label: 'Страница 1', text: comparatorText }],
      }),
    ],
  });
  const totalChars = firstText.length + secondText.length + comparatorText.length;

  assert.deepEqual(prepared.evidenceMetrics, {
    rawFragments: 3,
    uniqueFragments: 3,
    selectedFragments: 3,
    rawChars: totalChars,
    uniqueChars: totalChars,
    selectedChars: totalChars,
    chosenBudget: totalChars,
    configuredMaximumChars: 30_000,
    uniqueSources: 3,
    representedSources: 3,
    policyVersion: TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION,
  });
  assert.deepEqual(
    new Set(prepared.segments.map((segment) => segment.text)),
    new Set([firstText, secondText, comparatorText]),
  );
});

test('question evidence Unicode and whitespace duplicates reuse hash and remap provenance', () => {
  const sourceA = questionSource({
    materialId: 'material-unicode-a',
    revisionId: 'revision-unicode-a',
    title: 'Unicode A',
    segments: [{
      locator: 'page:7',
      label: 'Страница 7',
      text: 'Café предлагает тихую\tзону.',
    }],
  });
  const sourceB = questionSource({
    materialId: 'material-unicode-b',
    revisionId: 'revision-unicode-b',
    title: 'Unicode B',
    type: 'OFFICIAL_URL',
    segments: [{
      locator: 'url:paragraph:4',
      label: 'Абзац 4',
      text: 'Cafe\u0301 предлагает тихую\nзону.',
    }],
  });
  const prepare = (sources) => prepareTrainingQuestionKnowledge({
    projectId: 'project', objectId: 'object', objectTitle: 'Север', sources,
  });
  assert.notEqual(sourceA.contentHash, sourceB.contentHash);

  const single = prepare([sourceA]);
  const withDuplicate = prepare([sourceA, sourceB]);
  const reordered = prepare([sourceB, sourceA]);
  const afterCanonicalArchive = prepare([sourceB]);
  const canonical = [sourceA, sourceB].sort((left, right) =>
    left.contentHash.localeCompare(right.contentHash),
  )[0];
  const sharedLocator = withDuplicate.segments[0].locator;

  assert.deepEqual(withDuplicate.segments, single.segments);
  assert.deepEqual(reordered.segments, single.segments);
  assert.deepEqual(afterCanonicalArchive.segments, single.segments);
  assert.equal(withDuplicate.sourceHash, single.sourceHash);
  assert.equal(reordered.sourceHash, single.sourceHash);
  assert.equal(afterCanonicalArchive.sourceHash, single.sourceHash);
  assert.deepEqual(single.evidenceMetrics, {
    rawFragments: 1,
    uniqueFragments: 1,
    selectedFragments: 1,
    rawChars: single.segments[0].text.length,
    uniqueChars: single.segments[0].text.length,
    selectedChars: single.segments[0].text.length,
    chosenBudget: single.segments[0].text.length,
    configuredMaximumChars: 30_000,
    uniqueSources: 1,
    representedSources: 1,
    policyVersion: TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION,
  });
  assert.deepEqual(withDuplicate.evidenceMetrics, {
    rawFragments: 2,
    uniqueFragments: 1,
    selectedFragments: 1,
    rawChars: single.segments[0].text.length * 2,
    uniqueChars: single.segments[0].text.length,
    selectedChars: single.segments[0].text.length,
    chosenBudget: single.segments[0].text.length,
    configuredMaximumChars: 30_000,
    uniqueSources: 2,
    representedSources: 2,
    policyVersion: TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION,
  });
  assert.deepEqual(withDuplicate.references.get(sharedLocator), {
    evidenceHash: createHash('sha256')
      .update(normalizeTrainingEvidenceText(withDuplicate.segments[0].text))
      .digest('hex'),
    canonicalSourceKey: canonical.contentHash.substring(0, 24),
    sourceRevisionId: canonical.revisionId,
    sourceLabel: canonical.materialTitle,
    sourceLocator: canonical.segments[0].locator,
    sourceExcerpt: withDuplicate.segments[0].text,
  });
  assert.deepEqual(afterCanonicalArchive.references.get(sharedLocator), {
    evidenceHash: createHash('sha256')
      .update(normalizeTrainingEvidenceText(afterCanonicalArchive.segments[0].text))
      .digest('hex'),
    canonicalSourceKey: sourceB.contentHash.substring(0, 24),
    sourceRevisionId: sourceB.revisionId,
    sourceLabel: sourceB.materialTitle,
    sourceLocator: sourceB.segments[0].locator,
    sourceExcerpt: afterCanonicalArchive.segments[0].text,
  });
});

test('question AI evidence uses deterministic compact IDs and keeps full provenance server-side', () => {
  const sources = [
    questionSource({
      materialId: 'material-ai-a',
      revisionId: 'revision-ai-a-uuid',
      title: 'Очень длинное название PDF для обучения брокеров',
      segments: [
        { locator: 'page:section:architecture:1', label: 'Архитектура', text: 'Фасады выполнены из клинкерного кирпича.' },
        { locator: 'page:section:yard:2', label: 'Двор', text: 'Во дворе предусмотрена тихая зона отдыха.' },
      ],
    }),
    questionSource({
      materialId: 'material-ai-b',
      revisionId: 'revision-ai-b-uuid',
      title: 'Очень длинное название официальной страницы проекта',
      type: 'OFFICIAL_URL',
      segments: [
        { locator: 'url:section:transport:paragraph:7', label: 'Транспорт', text: 'До станции метро можно дойти пешком.' },
      ],
    }),
  ];
  const prepare = (items, projectId = 'project-original') => prepareTrainingQuestionKnowledge({
    projectId,
    objectId: `${projectId}-object`,
    objectTitle: 'Север',
    sources: items,
  });
  const prepared = prepare(sources);
  const reordered = prepare([...sources].reverse());
  const refreshed = prepare(sources.map((source, index) => ({
    ...source,
    revisionId: `replacement-revision-${index}`,
  })), 'different-project');
  const aiEvidence = prepareQuestionAIEvidence(prepared);
  const reorderedAI = prepareQuestionAIEvidence(reordered);
  const refreshedAI = prepareQuestionAIEvidence(refreshed);
  const compactIds = [...aiEvidence.references.keys()];

  assert.deepEqual(aiEvidence.segments, reorderedAI.segments);
  assert.deepEqual(aiEvidence.segments, refreshedAI.segments);
  assert.equal(prepared.sourceHash, reordered.sourceHash);
  assert.equal(prepared.sourceHash, refreshed.sourceHash);
  assert.equal(new Set(compactIds).size, prepared.segments.length);
  assert.deepEqual(
    compactIds.map((id) => Number(id.slice(1))).sort((left, right) => left - right),
    Array.from({ length: compactIds.length }, (_, index) => index + 1),
  );
  assert.equal(compactIds.every((id) => /^e[1-9]\d*$/u.test(id) && id.length <= 4), true);
  assert.equal(aiEvidence.segments.every((segment) =>
    Object.keys(segment).sort().join(',') === 'locator,text'), true);

  const aiPayload = JSON.stringify(aiEvidence.segments);
  assert.doesNotMatch(aiPayload, /revision-ai-|material-ai-|Очень длинное|page:section|url:section/u);
  for (const [compactId, canonicalSegment] of aiEvidence.references) {
    const reference = prepared.references.get(canonicalSegment.locator);
    assert.ok(reference);
    assert.equal(reference.sourceExcerpt, canonicalSegment.text);
    assert.equal(reference.sourceRevisionId.startsWith('revision-ai-'), true);
    assert.equal(/^e[1-9]\d*$/u.test(reference.sourceLocator), false);
    assert.equal(aiEvidence.segments.some((segment) => segment.locator === compactId), true);
  }
});

test('question sourceHash includes compact locator contract and compiler version', () => {
  const previousModel = process.env.OPENAI_QUESTION_GENERATION_MODEL;
  const previousLunaModel = process.env.OPENAI_QUESTION_GENERATION_LUNA_MODEL;
  const previousStrategy = process.env.OPENAI_QUESTION_GENERATION_STRATEGY;
  const previousReasoning = process.env.OPENAI_QUESTION_GENERATION_REASONING;
  const previousBudget = process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS;
  process.env.OPENAI_QUESTION_GENERATION_MODEL = 'gpt-5.6-terra';
  process.env.OPENAI_QUESTION_GENERATION_LUNA_MODEL = 'gpt-5.6-luna';
  process.env.OPENAI_QUESTION_GENERATION_STRATEGY = 'terra_only';
  process.env.OPENAI_QUESTION_GENERATION_REASONING = 'low';
  process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS = '30000';

  try {
    const prepared = prepareTrainingQuestionKnowledge({
      projectId: 'project-hash',
      objectId: 'object-hash',
      objectTitle: 'Север',
      sources: [questionSource({
        materialId: 'material-hash',
        revisionId: 'revision-hash',
        title: 'Источник hash',
        segments: [{ locator: 'page:1', label: 'Страница 1', text: 'Проверяемый факт для sourceHash.' }],
      })],
    });
    const hashInput = {
      compilerVersion: 'training-question-compiler-v7',
      promptVersion: 'training-question-prompt-v3',
      routing: {
        strategy: 'terra_only',
        routingVersion: 'luna-terra-router-v1',
        primaryModel: 'gpt-5.6-terra',
        fallbackModel: null,
        validatorVersion: 'training-question-validator-v1',
      },
      reasoning: 'low',
      chosenBudget: prepared.evidenceMetrics.chosenBudget,
      budgetPolicyVersion: TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION,
      selectionAlgorithm: 'source-coverage-numeric-priority-v1',
      evidenceDedupAlgorithm: 'normalized-evidence-sha256-v1',
      locatorContract: 'compact-evidence-id-v1',
      objectTitle: 'Север',
      evidence: prepared.segments.map((segment) =>
        prepared.references.get(segment.locator).evidenceHash,
      ),
    };
    const currentHash = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex');
    const previousCompilerHash = createHash('sha256').update(JSON.stringify({
      ...hashInput,
      compilerVersion: 'training-question-compiler-v6',
    })).digest('hex');
    const previousPolicyHash = createHash('sha256').update(JSON.stringify({
      ...hashInput,
      budgetPolicyVersion: 'training-question-context-budget-v0',
    })).digest('hex');
    const previousLocatorHash = createHash('sha256').update(JSON.stringify({
      ...hashInput,
      locatorContract: 'canonical-evidence-locator-v1',
    })).digest('hex');
    const previousStrategyHash = createHash('sha256').update(JSON.stringify({
      ...hashInput,
      routing: { ...hashInput.routing, strategy: 'luna_then_terra' },
    })).digest('hex');
    const previousValidatorHash = createHash('sha256').update(JSON.stringify({
      ...hashInput,
      routing: { ...hashInput.routing, validatorVersion: 'training-question-validator-v0' },
    })).digest('hex');

    assert.equal(prepared.sourceHash, currentHash);
    assert.notEqual(prepared.sourceHash, previousCompilerHash);
    assert.notEqual(prepared.sourceHash, previousPolicyHash);
    assert.notEqual(prepared.sourceHash, previousLocatorHash);
    assert.notEqual(prepared.sourceHash, previousStrategyHash);
    assert.notEqual(prepared.sourceHash, previousValidatorHash);
  } finally {
    restoreEnv('OPENAI_QUESTION_GENERATION_MODEL', previousModel);
    restoreEnv('OPENAI_QUESTION_GENERATION_LUNA_MODEL', previousLunaModel);
    restoreEnv('OPENAI_QUESTION_GENERATION_STRATEGY', previousStrategy);
    restoreEnv('OPENAI_QUESTION_GENERATION_REASONING', previousReasoning);
    restoreEnv('OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS', previousBudget);
  }
});

test('question strategy changes sourceHash and shared generation artifact key', () => {
  const previousStrategy = process.env.OPENAI_QUESTION_GENERATION_STRATEGY;
  const previousModel = process.env.OPENAI_QUESTION_GENERATION_MODEL;
  const previousLunaModel = process.env.OPENAI_QUESTION_GENERATION_LUNA_MODEL;
  const objectId = '19191919-1919-4919-8919-191919191919';
  const input = {
    projectId: 'project-routing-hash',
    objectId,
    objectTitle: 'Север',
    sources: [questionSource({
      materialId: 'material-routing-hash',
      revisionId: 'revision-routing-hash',
      title: 'Источник routing hash',
      type: 'OBJECT_SNAPSHOT',
      reuseMetadata: { kind: 'PLATFORMA_OBJECT_SNAPSHOT', realEstateObjectId: objectId },
      segments: [{
        locator: 'object-field:architecture',
        label: 'Архитектура',
        text: 'Фасады выполнены из клинкерного кирпича.',
      }],
    })],
  };

  process.env.OPENAI_QUESTION_GENERATION_MODEL = 'gpt-5.6-terra';
  process.env.OPENAI_QUESTION_GENERATION_LUNA_MODEL = 'gpt-5.6-luna';
  try {
    process.env.OPENAI_QUESTION_GENERATION_STRATEGY = 'terra_only';
    const terraPrepared = prepareTrainingQuestionKnowledge(input);
    const terraPlan = createTrainingQuestionGenerationPlan(input, terraPrepared, objectId);
    process.env.OPENAI_QUESTION_GENERATION_STRATEGY = 'luna_then_terra';
    const lunaPrepared = prepareTrainingQuestionKnowledge(input);
    const lunaPlan = createTrainingQuestionGenerationPlan(input, lunaPrepared, objectId);

    assert.ok(terraPlan);
    assert.ok(lunaPlan);
    assert.notEqual(terraPrepared.sourceHash, lunaPrepared.sourceHash);
    assert.notEqual(terraPlan.generationKeyHash, lunaPlan.generationKeyHash);
    assert.equal(terraPlan.generationKey.strategy, 'terra_only');
    assert.equal(terraPlan.generationKey.fallbackModel, null);
    assert.equal(lunaPlan.generationKey.strategy, 'luna_then_terra');
    assert.equal(lunaPlan.generationKey.primaryModel, 'gpt-5.6-luna');
    assert.equal(lunaPlan.generationKey.fallbackModel, 'gpt-5.6-terra');
    assert.equal(lunaPlan.generationKey.validatorVersion, 'training-question-validator-v1');
  } finally {
    restoreEnv('OPENAI_QUESTION_GENERATION_STRATEGY', previousStrategy);
    restoreEnv('OPENAI_QUESTION_GENERATION_MODEL', previousModel);
    restoreEnv('OPENAI_QUESTION_GENERATION_LUNA_MODEL', previousLunaModel);
  }
});

test('shared artifact eligibility accepts object snapshots and metadata-confirmed object PDFs only', () => {
  const objectId = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(readQuestionSourceReuseMetadata('OBJECT_SNAPSHOT', {
    objectId,
    fieldCodes: ['title'],
  }), {
    kind: 'PLATFORMA_OBJECT_SNAPSHOT',
    realEstateObjectId: objectId,
  });
  assert.deepEqual(readQuestionSourceReuseMetadata('PDF', {
    importKind: 'PLATFORMA_OBJECT',
    objectId,
    sourceObjectFileId: 'object-file',
    sourceFileId: 'file',
  }), {
    kind: 'PLATFORMA_OBJECT_PDF',
    realEstateObjectId: objectId,
  });
  assert.equal(readQuestionSourceReuseMetadata('PDF', {
    objectId,
    method: 'PDF',
  }), undefined);
  assert.equal(readQuestionSourceReuseMetadata('PDF', {
    importKind: 'PLATFORMA_OBJECT',
    objectId,
    sourceObjectFileId: 'object-file',
  }), undefined);
  assert.equal(readQuestionSourceReuseMetadata('MANUAL_TEXT', { objectId }), undefined);
  assert.equal(readQuestionSourceReuseMetadata('OFFICIAL_URL', { objectId }), undefined);
});

test('shared generation key is complete and neutral artifact rebinds fresh provenance', async () => {
  const objectId = '22222222-2222-4222-8222-222222222222';
  const snapshotText = 'В жилом комплексе предусмотрен закрытый двор.';
  const pdfText = 'Высота потолков составляет три метра.';
  const makeInput = (projectId, revisionSuffix, locatorSuffix) => ({
    projectId,
    objectId,
    objectTitle: 'Север',
    sources: [
      questionSource({
        materialId: `snapshot-${projectId}`,
        revisionId: `snapshot-revision-${revisionSuffix}`,
        title: `Snapshot ${projectId}`,
        type: 'OBJECT_SNAPSHOT',
        segments: [{
          locator: `object-field:description:${locatorSuffix}`,
          label: 'Описание',
          text: snapshotText,
        }],
        reuseMetadata: {
          kind: 'PLATFORMA_OBJECT_SNAPSHOT',
          realEstateObjectId: objectId,
        },
      }),
      questionSource({
        materialId: `pdf-${projectId}`,
        revisionId: `pdf-revision-${revisionSuffix}`,
        title: `PDF ${projectId}`,
        type: 'PDF',
        segments: [{ locator: `page:${locatorSuffix}`, label: 'Страница', text: pdfText }],
        reuseMetadata: {
          kind: 'PLATFORMA_OBJECT_PDF',
          realEstateObjectId: objectId,
        },
      }),
    ],
  });
  const firstInput = makeInput('project-first', 'first', '1');
  const secondInput = makeInput('project-second', 'second', '9');
  const firstPrepared = prepareTrainingQuestionKnowledge(firstInput);
  const secondPrepared = prepareTrainingQuestionKnowledge(secondInput);
  const firstPlan = createTrainingQuestionGenerationPlan(
    firstInput,
    firstPrepared,
    objectId,
  );
  const secondPlan = createTrainingQuestionGenerationPlan(
    secondInput,
    secondPrepared,
    objectId,
  );
  assert.ok(firstPlan);
  assert.ok(secondPlan);
  assert.equal(firstPlan.generationKeyHash, secondPlan.generationKeyHash);
  assert.equal(firstPlan.sourceFingerprint, secondPlan.sourceFingerprint);

  const fake = new DeterministicFakeTrainingMaterialSuggester();
  const generated = await fake.generateQuestionDrafts(firstInput, {
    preparedSource: firstPrepared,
  });
  const artifact = createTrainingQuestionGenerationArtifactPayload(
    generated,
    firstPrepared,
  );
  const serialized = JSON.stringify(artifact);
  assert.doesNotMatch(
    serialized,
    /project-first|snapshot-revision-first|pdf-revision-first|criteria|sourceExcerpt/iu,
  );
  const rebound = materializeTrainingQuestionGenerationArtifact(artifact, secondPrepared);
  const reboundReferences = [rebound.main, ...rebound.followUps]
    .flatMap((question) => question.facts)
    .map((fact) => secondPrepared.references.get(fact.sourceLocator));
  assert.equal(reboundReferences.every((reference) =>
    reference.sourceRevisionId.endsWith('-second') &&
    (reference.sourceLocator.endsWith(':9') || reference.sourceLocator.includes(':9'))
  ), true);

  const keyFields = [
    'realEstateObjectId',
    'sourceFingerprint',
    'contentHashes',
    'selectedEvidenceHashes',
    'objectTitleHash',
    'providerMode',
    'routingStrategy',
    'strategy',
    'routingVersion',
    'validatorVersion',
    'primaryModel',
    'fallbackModel',
    'generationModel',
    'generationReasoning',
    'compilerVersion',
    'promptVersion',
    'chosenBudget',
    'budgetPolicyVersion',
    'selectionAlgorithm',
    'evidenceDedupAlgorithm',
    'locatorContract',
    'maxOutputTokens',
    'artifactSchemaVersion',
    'keyVersion',
  ];
  for (const field of keyFields) {
    const current = firstPlan.generationKey[field];
    const changed = Array.isArray(current)
      ? [...current, 'changed']
      : typeof current === 'number'
        ? current + 1
        : `${current}-changed`;
    assert.notEqual(
      hashTrainingQuestionGenerationKey({ ...firstPlan.generationKey, [field]: changed }),
      firstPlan.generationKeyHash,
      field,
    );
  }

  const userPdfInput = {
    ...firstInput,
    sources: [{ ...firstInput.sources[1], reuseMetadata: undefined }],
  };
  assert.equal(createTrainingQuestionGenerationPlan(
    userPdfInput,
    prepareTrainingQuestionKnowledge(userPdfInput),
    objectId,
  ), null);
});

test('generated question persistence stores original provenance and never compact AI IDs', async () => {
  const source = questionSource({
    materialId: 'material-persisted',
    revisionId: 'revision-persisted',
    title: 'Исходный материал',
    segments: [{
      locator: 'page:original:7',
      label: 'Страница 7',
      text: 'Подтверждённый сервером фрагмент для сохранения.',
    }],
  });
  const prepared = prepareTrainingQuestionKnowledge({
    projectId: 'project-persisted',
    objectId: 'object-persisted',
    objectTitle: 'Север',
    sources: [source],
  });
  const aiEvidence = prepareQuestionAIEvidence(prepared);
  const compactId = aiEvidence.segments[0].locator;
  const canonicalSegment = aiEvidence.references.get(compactId);
  const reference = prepared.references.get(canonicalSegment.locator);
  const persistedFacts = [];
  let questionPosition = 0;
  const transaction = {
    $queryRaw: async () => [{ id: 'project-persisted' }],
    trainingProject: {
      findUnique: async () => ({
        id: 'project-persisted',
        isOpen: false,
        knowledgeSourceHash: null,
        knowledgeVersion: 4,
      }),
      update: async () => undefined,
    },
    trainingQuestion: {
      count: async () => 0,
      upsert: async () => ({ id: `question-${questionPosition += 1}` }),
    },
    trainingFact: {
      deleteMany: async () => undefined,
      createMany: async ({ data }) => {
        persistedFacts.push(...data);
        return { count: data.length };
      },
    },
  };
  const prisma = {
    $transaction: async (callback) => callback(transaction),
  };
  const service = new TrainingMaterialService(prisma, null, null, null, null, null);
  const makeDraft = (index) => ({
    text: `Вопрос ${index}`,
    facts: [{
      statement: `Факт ${index}`,
      aliases: [],
      isRequired: true,
      sourceLocator: canonicalSegment.locator,
      sourceExcerpt: reference.sourceExcerpt,
    }],
  });

  await service.applyGeneratedQuestionDrafts(
    'project-persisted',
    null,
    {
      generated: {
        main: makeDraft(0),
        followUps: Array.from({ length: 10 }, (_, index) => makeDraft(index + 1)),
      },
      sourceHash: prepared.sourceHash,
      baseProjectKnowledgeVersion: 4,
      references: prepared.references,
    },
    true,
  );

  assert.match(compactId, /^e[1-9]\d*$/u);
  assert.equal(persistedFacts.length, 11);
  assert.equal(JSON.stringify(persistedFacts).includes(compactId), false);
  assert.equal(persistedFacts.every((fact) =>
    fact.sourceRevisionId === source.revisionId &&
    fact.sourceLabel === source.materialTitle &&
    fact.sourceLocator === source.segments[0].locator &&
    fact.sourceExcerpt === reference.sourceExcerpt), true);
});

function questionSourceText(segments) {
  return segments.map((segment) => normalizeTrainingMaterialText(segment.text)).join('\n\n');
}

function questionContentHash(segments) {
  return createHash('sha256').update(questionSourceText(segments)).digest('hex');
}

function questionSource({
  materialId,
  revisionId,
  title,
  type = 'PDF',
  segments,
  reuseMetadata,
}) {
  return {
    materialId,
    revisionId,
    materialTitle: title,
    materialType: type,
    contentHash: questionContentHash(segments),
    segments,
    ...(reuseMetadata ? { reuseMetadata } : {}),
  };
}

function sizedEvidenceText(prefix, length) {
  assert.ok(prefix.length + 2 <= length);
  return `${prefix} ${'я'.repeat(length - prefix.length - 2)}.`;
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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
