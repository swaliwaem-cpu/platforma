import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';
import { fulfillTrainingConfig } from './training-v2-browser-config-fixture.mjs';

const baseUrl = process.env.TRAINING_WEB_TEST_URL;
if (!baseUrl) throw new Error('TRAINING_WEB_TEST_URL is required');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
const consoleIssues = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    consoleIssues.push(`${message.type()}: ${message.text()}`);
  }
});
page.on('pageerror', (error) => consoleIssues.push(`pageerror: ${error.message}`));
const projectId = '61111111-1111-4111-8111-111111111111';
const questionId = '62222222-2222-4222-8222-222222222222';
const objectId = '67777777-7777-4777-8777-777777777777';
const objectImportOperationId = '68888888-8888-4888-8888-888888888888';
const materials = [];
let listFailuresRemaining = 1;
let listDelaysRemaining = 0;
let listDelayGate = null;
let resolveListDelayStarted = null;
let appliedPayload = null;
let confirmedUrlPayload = null;
let objectImported = false;
const objectImportPayloads = [];
const objectSearchQueries = [];

try {
  await page.route('http://localhost:3000/**', async (route) => {
    if (await fulfillTrainingConfig(route, true)) return;

    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/auth/refresh') {
      await json(route, {
        accessToken: 'stage4-browser-access-token',
        user: {
          id: '63333333-3333-4333-8333-333333333333',
          email: 'stage4-admin@training.test',
          name: 'Stage 4 Admin',
          brokerPhone: null,
          brokerEmail: null,
          status: 'ACTIVE',
          role: { id: '64444444-4444-4444-8444-444444444444', name: 'admin' },
          profilePhotoFile: null,
          permissions: ['admin:access', 'training:participate', 'training:projects:manage'],
        },
      });
      return;
    }

    if (path === `/training/admin/projects/${projectId}`) {
      await json(route, projectFixture());
      return;
    }

    if (path === `/training/admin/projects/${projectId}/materials` && request.method() === 'GET') {
      if (listFailuresRemaining > 0) {
        listFailuresRemaining -= 1;
        await json(route, { message: 'MATERIAL_LIST_FIXTURE_ERROR' }, 500);
        return;
      }
      if (listDelaysRemaining > 0) {
        listDelaysRemaining -= 1;
        resolveListDelayStarted?.();
        resolveListDelayStarted = null;
        await listDelayGate;
      }
      await json(route, { items: materials });
      return;
    }

    if (path === `/training/admin/projects/${projectId}/material-operations` && request.method() === 'GET') {
      await json(route, {
        items: objectImported ? [objectImportOperation('READY')] : [],
      });
      return;
    }

    if (path === `/training/admin/projects/${projectId}/object-options` && request.method() === 'GET') {
      objectSearchQueries.push(url.searchParams.get('search') ?? '');
      const option = {
        id: objectId,
        title: 'ЖК Северный',
        status: 'PUBLISHED',
        developerName: 'Тестовый девелопер',
        pdfCount: 1,
      };
      await json(route, {
        items: url.searchParams.has('search') ? [option] : [option],
        selected: objectImported ? option : null,
      });
      return;
    }

    if (path === `/training/admin/projects/${projectId}/import-object` && request.method() === 'POST') {
      const payload = request.postDataJSON();
      objectImportPayloads.push(payload);
      if (!payload.replaceExistingQuestions) {
        await json(route, { message: 'PROJECT_QUESTIONS_REPLACE_CONFIRMATION_REQUIRED' }, 409);
        return;
      }
      objectImported = true;
      materials.unshift(makeMaterial('pdf', 'Презентация ЖК', materials.length + 1));
      materials.unshift(makeMaterial('object-snapshot', 'Карточка Platforma · ЖК Северный', materials.length + 1));
      await json(route, objectImportOperation('QUEUED'), 202);
      return;
    }

    if (path === `/training/admin/projects/${projectId}/materials` && request.method() === 'POST') {
      const payload = request.postDataJSON();
      const type = {
        MANUAL_TEXT: 'manual',
        OFFICIAL_URL: 'url',
      }[payload.type];
      const title = payload.title;
      if (type === 'url' && title === 'Broken URL') {
        await json(route, { message: 'QUESTION_DRAFT_GENERATION_FAILED' }, 502);
        return;
      }
      if (type === 'url') confirmedUrlPayload = payload;
      const material = makeMaterial(type, title, materials.length + 1);
      materials.unshift(material);
      await json(route, material, 201);
      return;
    }

    if (path === `/training/admin/projects/${projectId}/materials/pdf` && request.method() === 'POST') {
      const material = makeMaterial('pdf', 'PDF source', materials.length + 1);
      materials.unshift(material);
      await json(route, material, 201);
      return;
    }

    const materialMatch = path.match(/^\/training\/admin\/materials\/([^/]+)$/u);
    if (materialMatch && request.method() === 'GET') {
      const material = materials.find((item) => item.id === materialMatch[1]);
      await json(route, material ?? { message: 'not found' }, material ? 200 : 404);
      return;
    }

    const refreshMatch = path.match(/^\/training\/admin\/materials\/([^/]+)\/revisions$/u);
    if (refreshMatch && request.method() === 'POST') {
      const material = materials.find((item) => item.id === refreshMatch[1]);
      const previous = material.revisions[0];
      const next = makeRevision({
        id: `7${material.revisions.length}0000000-0000-4000-8000-000000000001`,
        number: previous.revisionNumber + 1,
        previousId: previous.id,
        type: material.type,
        text: `${previous.extractedText} Обновлённый фрагмент.`,
      });
      material.revisions.unshift(next);
      material.latestRevision = next;
      await json(route, material, 201);
      return;
    }

    const suggestionMatch = path.match(/^\/training\/admin\/material-revisions\/([^/]+)\/suggestions$/u);
    if (suggestionMatch && request.method() === 'POST') {
      const material = materials.find((item) => item.revisions.some((revision) => revision.id === suggestionMatch[1]));
      const revision = material.revisions.find((item) => item.id === suggestionMatch[1]);
      revision.suggestionStatus = 'READY';
      revision.suggestionModel = 'training-material-fake-v1';
      revision.suggestions = [{
        id: 'suggestion-1',
        targetQuestionId: questionId,
        statement: 'Предложенный факт из URL.',
        aliases: ['факт URL'],
        isRequired: true,
        sourceLocator: revision.segments[0].locator,
        sourceExcerpt: revision.segments[0].text.slice(0, 80),
      }];
      await json(route, material, 201);
      return;
    }

    const applyMatch = path.match(/^\/training\/admin\/material-revisions\/([^/]+)\/apply-suggestions$/u);
    if (applyMatch && request.method() === 'POST') {
      appliedPayload = request.postDataJSON();
      await json(route, { createdFactIds: ['fact-created'], duplicates: [] }, 201);
      return;
    }

    if (path === '/training/projects') {
      await json(route, { items: [] });
      return;
    }
    if (path === '/training/attempts') {
      await json(route, { items: [] });
      return;
    }
    if (path === '/training/telegram/account') {
      await json(route, { linked: false, username: null, linkedAt: null });
      return;
    }

    await json(route, { message: 'not found' }, 404);
  });

  await page.goto(`${baseUrl}/admin/training/projects/${projectId}?theme=c`);
  await page.getByRole('heading', { name: 'Stage 4 browser project' }).waitFor();
  assert.equal(await page.title(), 'Platforma');
  assert.match(page.url(), new RegExp(`/admin/training/projects/${projectId}\\?theme=c$`, 'u'));
  assert.equal(await page.locator('html').getAttribute('data-app-theme'), 'dark-premium');
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  const deleteProjectButton = page.getByRole('button', { name: 'Удалить проект' });
  assert.equal(await deleteProjectButton.getAttribute('data-variant'), 'destructive');
  assert.notEqual(await deleteProjectButton.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  await deleteProjectButton.click();
  await page.getByRole('heading', { name: /Безвозвратно удалить проект/u }).waitFor();
  if (process.env.TRAINING_DELETE_SCREENSHOT) {
    await page.screenshot({ path: process.env.TRAINING_DELETE_SCREENSHOT });
  }
  await page.getByRole('button', { name: 'Отмена' }).click();
  await page.getByRole('heading', { name: /Безвозвратно удалить проект/u }).waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Материалы' }).click();
  await page.getByText('MATERIAL_LIST_FIXTURE_ERROR').waitFor();

  listDelaysRemaining = 1;
  let releaseListDelay;
  listDelayGate = new Promise((resolve) => { releaseListDelay = resolve; });
  const delayedListStarted = new Promise((resolve) => { resolveListDelayStarted = resolve; });
  await page.reload();
  await delayedListStarted;
  await page.getByRole('heading', { name: 'Stage 4 browser project' }).waitFor();
  await page.getByRole('tab', { name: 'Материалы' }).click();
  await page.locator('.training-materials-skeleton').waitFor();
  assert.equal(await page.locator('.training-materials-skeleton').count(), 1);
  releaseListDelay();
  listDelayGate = null;
  await page.getByText('Источников пока нет').waitFor();

  const search = page.getByRole('combobox', { name: 'Поиск ЖК' });
  const objectSearchResponsePromise = page.waitForResponse((response) => {
    const responseUrl = new URL(response.url());
    return responseUrl.pathname.endsWith('/object-options') && responseUrl.searchParams.get('search') === 'ctdth';
  });
  await search.fill('ctdth');
  assert.equal((await objectSearchResponsePromise).status(), 200);
  await page.getByRole('option', { name: /ЖК Северный/u }).waitFor();
  await page.getByRole('option', { name: /ЖК Северный/u }).click();
  page.once('dialog', (dialog) => dialog.accept());
  const importResponsePromise = page.waitForResponse((response) => {
    if (!response.url().endsWith('/import-object') || response.request().method() !== 'POST') return false;
    return response.request().postDataJSON()?.replaceExistingQuestions === true;
  });
  await page.getByRole('button', { name: 'Создать вопросы и ответы из данных ЖК' }).click();
  assert.equal((await importResponsePromise).status(), 202);
  await page.getByText(/Созданы 1 главный и 10 дополнительных вопросов с активными эталонными ответами/u).waitFor();
  assert.ok(await contrastRatio(page.locator('.admin-alert--notice').last()) >= 4.5);
  if (process.env.TRAINING_NOTICE_SCREENSHOT) {
    await page.screenshot({ path: process.env.TRAINING_NOTICE_SCREENSHOT });
  }
  assert.ok(objectSearchQueries.includes('ctdth'));
  assert.deepEqual(objectImportPayloads.map((payload) => payload.replaceExistingQuestions), [false, true]);

  await page.getByRole('tab', { name: 'Вопросы' }).click();
  await page.getByLabel('Текст главного вопроса').waitFor();
  assert.equal(await page.getByLabel('Текст главного вопроса').inputValue(), generatedMainQuestion());
  assert.equal(await page.getByLabel('Дополнительный вопрос 10').inputValue(), generatedFollowUpQuestions()[9]);
  await page.getByRole('tab', { name: 'Материалы' }).click();

  await createManual();
  await createOfficialUrl();
  await createPdf();
  assert.equal(await page.locator('.training-material-row').count(), 5);

  await page.locator('.training-material-row').filter({ hasText: 'URL source' }).getByRole('button', { name: 'Открыть URL source' }).click();
  await page.getByText('https://official.test/final', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Новая версия' }).click();
  const inspector = page.getByLabel('Инспектор выбранного материала');
  await inspector.getByText('Версия 2', { exact: true }).waitFor();
  await page.getByText('Добавленные фрагменты').waitFor();
  await page.getByRole('button', { name: /#1 Готово/u }).click();
  await inspector.getByText('Версия 1', { exact: true }).waitFor();
  await page.getByRole('button', { name: /#2 Готово/u }).click();

  await page.getByRole('button', { name: 'Сгенерировать' }).click();
  await page.getByText('Предложенный факт из URL.').waitFor();
  const suggestion = page.locator('.training-suggestion-editor');
  await suggestion.getByText('Выбрать предложенный факт').click();
  await suggestion.getByRole('textbox', { name: 'Факт', exact: true }).fill('Отредактированный подтверждённый факт.');
  const applyResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/apply-suggestions') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Применить выбранные (1)' }).click();
  assert.equal((await applyResponsePromise).status(), 201);
  assert.equal(appliedPayload.suggestions[0].statement, 'Отредактированный подтверждённый факт.');
  assert.equal(confirmedUrlPayload.officialConfirmed, true);

  await page.evaluate(() => window.scrollTo(0, 0));
  await inspector.evaluate((element) => { element.scrollTop = 0; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.TRAINING_DESKTOP_SCREENSHOT) {
    await page.screenshot({ path: process.env.TRAINING_DESKTOP_SCREENSHOT });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.TRAINING_MOBILE_SCREENSHOT) {
    await page.screenshot({ path: process.env.TRAINING_MOBILE_SCREENSHOT });
  }
  await page.setViewportSize({ width: 1536, height: 1024 });

  await page.getByRole('tab', { name: 'Вопросы' }).click();
  await page.getByText('PDF · Страница 1').first().waitFor();
  await page.getByText(/PDF проекта · «Высота потолков/u).first().waitFor();
  const firstFactRow = page.locator('.training-fact-row').first();
  const factCheckboxBox = await firstFactRow.locator('.training-inline-check input[type="checkbox"]').boundingBox();
  const factLabelBox = await firstFactRow.locator('.training-inline-check span').boundingBox();
  const factDeleteBox = await firstFactRow.locator('.training-fact-delete-action').boundingBox();
  assert.ok(factCheckboxBox && factLabelBox && factDeleteBox);
  assert.ok(factLabelBox.x - (factCheckboxBox.x + factCheckboxBox.width) <= 12);
  assert.ok(factDeleteBox.x > factLabelBox.x);
  if (process.env.TRAINING_QUESTIONS_SCREENSHOT) {
    await firstFactRow.screenshot({ path: process.env.TRAINING_QUESTIONS_SCREENSHOT });
  }

  await page.goto(`${baseUrl}/training`);
  await page.getByRole('heading', { name: 'Учебные проекты' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Материалы' }).count(), 0);
  assert.equal(await page.getByText('Официальный URL').count(), 0);
  const unexpectedConsoleIssues = consoleIssues.filter((message) =>
    !/status of (?:500 \(Internal Server Error\)|502 \(Bad Gateway\)|409 \(Conflict\))/u.test(message),
  );
  assert.deepEqual(unexpectedConsoleIssues, []);
} finally {
  await browser.close();
}

function objectImportOperation(status) {
  const ready = status === 'READY';
  return {
    id: objectImportOperationId,
    projectId,
    type: 'IMPORT_OBJECT',
    status,
    baseKnowledgeVersion: 0,
    completedKnowledgeVersion: ready ? 1 : null,
    sourceHash: null,
    progress: { total: 2, completed: ready ? 2 : 0, failed: 0 },
    attempts: ready ? 1 : 0,
    errorCode: null,
    result: ready ? {
      objectTitle: 'ЖК Северный',
      importedPdfCount: 1,
      failedPdfTitles: [],
    } : null,
    items: [],
    startedAt: ready ? '2026-08-08T09:00:00.000Z' : null,
    finishedAt: ready ? '2026-08-08T09:00:01.000Z' : null,
    createdAt: '2026-08-08T09:00:00.000Z',
    updatedAt: ready ? '2026-08-08T09:00:01.000Z' : '2026-08-08T09:00:00.000Z',
  };
}

async function createManual() {
  await page.getByRole('button', { name: 'Добавить источник' }).click();
  await page.getByLabel('Тип источника').selectOption('MANUAL_TEXT');
  await page.locator('#training-material-title').fill('Manual source');
  await page.getByLabel('Текст').fill('Ручной текст для новой версии.');
  await page.getByRole('button', { name: 'Создать материал' }).click();
  await page.getByText('Manual source', { exact: true }).first().waitFor();
}

async function createOfficialUrl() {
  await page.getByRole('button', { name: 'Добавить источник' }).click();
  assert.equal(
    await page.getByLabel('Тип источника').locator('option[value="OBJECT_SNAPSHOT"]').count(),
    0,
  );
  await page.getByLabel('Тип источника').selectOption('OFFICIAL_URL');
  await page.locator('#training-material-title').fill('Broken URL');
  await page.getByLabel('Одна официальная защищённая страница').fill('https://official.test/source');
  const confirmation = page.getByLabel('Подтверждаю, что это официальный источник проекта');
  const confirmationLabel = page.locator('label[for="training-material-official-confirmation"]');
  const checkboxBox = await confirmation.boundingBox();
  const labelBox = await confirmationLabel.boundingBox();
  assert.ok(checkboxBox && labelBox);
  assert.ok(labelBox.x - (checkboxBox.x + checkboxBox.width) <= 16);
  await confirmation.check();
  await page.getByRole('button', { name: 'Создать материал' }).click();
  await page.getByText('Не удалось сформировать вопросы по источнику. Материал не сохранён. Попробуйте ещё раз.').waitFor();
  assert.equal(await page.getByText('Broken URL', { exact: true }).count(), 0);
  await page.locator('#training-material-title').fill('URL source');
  await page.getByRole('button', { name: 'Создать материал' }).click();
  await page.getByText('URL source', { exact: true }).first().waitFor();
}

async function createPdf() {
  await page.getByRole('button', { name: 'Добавить источник' }).click();
  await page.getByLabel('Тип источника').selectOption('PDF');
  await page.locator('#training-material-title').fill('PDF source');
  await page.getByLabel('Документ PDF с текстовым слоем').setInputFiles({
    name: 'fixture.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 synthetic browser fixture'),
  });
  await page.getByRole('button', { name: 'Создать материал' }).click();
  await page.getByText('PDF source', { exact: true }).first().waitFor();
}

async function contrastRatio(locator) {
  return locator.evaluate((element) => {
    const parse = (value) => value.match(/[\d.]+/gu)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (rgb) => rgb
      .map((channel) => channel / 255)
      .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const foreground = luminance(parse(getComputedStyle(element).color));
    const background = luminance(parse(getComputedStyle(element).backgroundColor));
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
}

function makeMaterial(kind, title, index) {
  const type = {
    manual: 'MANUAL_TEXT',
    url: 'OFFICIAL_URL',
    'object-snapshot': 'OBJECT_SNAPSHOT',
    pdf: 'PDF',
  }[kind];
  const id = `65${index}11111-1111-4111-8111-111111111111`;
  const revision = makeRevision({
    id: `66${index}11111-1111-4111-8111-111111111111`,
    number: 1,
    previousId: null,
    type,
    text: type === 'PDF' ? 'Текст первой страницы PDF.' : `${title}: стабильный извлечённый текст источника.`,
  });
  return {
    id,
    projectId,
    type,
    title,
    status: 'ACTIVE',
    sourceUrl: type === 'OFFICIAL_URL' ? 'https://official.test/source' : null,
    officialConfirmedAt: type === 'OFFICIAL_URL' ? '2026-08-02T10:00:00.000Z' : null,
    latestRevision: revision,
    revisions: [revision],
    createdAt: '2026-08-02T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
  };
}

function makeRevision({ id, number, previousId, type, text }) {
  const locator = type === 'PDF' ? 'page:1' : type === 'OBJECT_SNAPSHOT' ? 'object-field:title' : 'paragraph:1';
  const label = type === 'PDF' ? 'Страница 1' : type === 'OBJECT_SNAPSHOT' ? 'Название' : 'Абзац 1';
  return {
    id,
    revisionNumber: number,
    previousRevisionId: previousId,
    status: 'READY',
    requestedUrl: type === 'OFFICIAL_URL' ? 'https://official.test/source' : null,
    finalUrl: type === 'OFFICIAL_URL' ? 'https://official.test/final' : null,
    fetchedAt: type === 'OFFICIAL_URL' ? '2026-08-02T10:00:00.000Z' : null,
    extractedText: text,
    segments: [{ locator, label, text }],
    contentHash: 'a'.repeat(64),
    extractionMetadata: type === 'OBJECT_SNAPSHOT'
      ? { method: 'OBJECT_SNAPSHOT', objectId: '11111111-1111-4111-8111-111111111111', objectTitle: 'Тестовый объект', fieldCodes: ['title'], fieldValues: { title: 'Тестовый объект' } }
      : { method: type === 'OFFICIAL_URL' ? 'HTTP' : type },
    diff: {
      previousRevisionId: previousId,
      added: [`${label}: ${text}`],
      removed: previousId ? ['Абзац 1: предыдущий текст'] : [],
      unchangedCount: 0,
      changed: true,
    },
    isChanged: true,
    suggestionStatus: 'NOT_GENERATED',
    suggestions: null,
    suggestionModel: null,
    suggestionErrorCode: null,
    createdAt: `2026-08-02T10:0${number}:00.000Z`,
  };
}

function projectFixture() {
  return {
    id: projectId,
    realEstateObjectId: objectImported ? objectId : null,
    title: 'Stage 4 browser project',
    description: 'Stage 4 browser fixture',
    status: 'DRAFT',
    isOpen: false,
    sortOrder: 0,
    attemptLimit: 3,
    timeLimitSeconds: 420,
    passScore: 75,
    allowRetakeAfterPass: true,
    contentSchemaVersion: 3,
    mainQuestion: objectImported ? generatedMainQuestion() : 'Главный вопрос',
    followUpQuestions: objectImported
      ? generatedFollowUpQuestions()
      : Array.from({ length: 10 }, (_, index) => `Дополнительный вопрос ${index + 1}`),
    facts: Array.from({ length: 11 }, (_, index) => ({
      id: index === 0 ? '68888888-8888-4888-8888-888888888888' : `69${index}11111-1111-4111-8111-111111111111`,
      questionType: index === 0 ? 'MAIN' : 'FOLLOW_UP',
      questionPosition: index === 0 ? 1 : index,
      statement: index === 0 ? 'Высота потолков составляет три метра.' : `Ручной факт ${index + 1}`,
      aliases: [],
      isRequired: true,
      position: 1,
      sourceType: index === 0 ? 'MATERIAL' : 'MANUAL',
      sourceRevisionId: index === 0 ? '60000000-0000-4000-8000-000000000001' : null,
      sourceLabel: index === 0 ? 'PDF проекта' : 'Добавлено вручную',
      sourceLocator: index === 0 ? 'page:1' : null,
      sourceExcerpt: index === 0 ? 'Высота потолков' : null,
      sourceMaterialType: index === 0 ? 'PDF' : null,
      sourceUrl: null,
    })),
    criteria: [
      { id: '60000000-0000-4000-8000-000000000011', questionType: 'MAIN', code: 'main', title: 'Main', guidance: '', maxPoints: 55, position: 1 },
      { id: '60000000-0000-4000-8000-000000000012', questionType: 'FOLLOW_UP', code: 'follow', title: 'Follow', guidance: '', maxPoints: 15, position: 1 },
    ],
    publicationErrors: [],
    createdAt: '2026-08-02T09:00:00.000Z',
    updatedAt: '2026-08-02T09:00:00.000Z',
  };
}

function generatedMainQuestion() {
  return 'Расскажите о ключевых особенностях ЖК Северный.';
}

function generatedFollowUpQuestions() {
  return Array.from({ length: 10 }, (_, index) => `Черновик дополнительного вопроса ${index + 1} о ЖК Северный?`);
}

async function json(route, body, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
