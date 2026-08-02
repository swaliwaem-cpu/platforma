import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';

const baseUrl = process.env.TRAINING_WEB_TEST_URL;
if (!baseUrl) throw new Error('TRAINING_WEB_TEST_URL is required');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const projectId = '61111111-1111-4111-8111-111111111111';
const questionId = '62222222-2222-4222-8222-222222222222';
const objectId = '67777777-7777-4777-8777-777777777777';
const materials = [];
let listFailuresRemaining = 2;
let listDelaysRemaining = 0;
let appliedPayload = null;
let confirmedUrlPayload = null;
let objectImported = false;
const objectImportPayloads = [];
const objectSearchQueries = [];

try {
  await page.route('http://localhost:3000/**', async (route) => {
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
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      await json(route, { items: materials });
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
      await json(route, {
        object: {
          id: objectId,
          title: 'ЖК Северный',
          status: 'PUBLISHED',
          developerName: 'Тестовый девелопер',
          pdfCount: 1,
        },
        objectSnapshotMaterialId: materials[0].id,
        importedPdfCount: 1,
        failedPdfTitles: [],
        mainQuestion: generatedMainQuestion(),
        followUpQuestions: generatedFollowUpQuestions(),
        questionGenerationModel: 'training-question-fake-v1',
        questionGenerationSourceChars: 250,
      }, 201);
      return;
    }

    if (path === `/training/admin/projects/${projectId}/materials` && request.method() === 'POST') {
      const payload = request.postDataJSON();
      const type = {
        MANUAL_TEXT: 'manual',
        OFFICIAL_URL: 'url',
        OBJECT_SNAPSHOT: 'object-snapshot',
      }[payload.type];
      const title = payload.title;
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

  await page.goto(`${baseUrl}/admin/training/projects/${projectId}`);
  await page.getByRole('heading', { name: 'Stage 4 browser project' }).waitFor();
  await page.getByRole('tab', { name: 'Материалы' }).click();
  await page.getByText('MATERIAL_LIST_FIXTURE_ERROR').waitFor();

  listDelaysRemaining = 2;
  await page.reload();
  await page.getByRole('heading', { name: 'Stage 4 browser project' }).waitFor();
  await page.getByRole('tab', { name: 'Материалы' }).click();
  assert.equal(await page.locator('.training-materials-skeleton').count(), 1);
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
  await page.getByRole('button', { name: 'Загрузить данные и создать вопросы' }).click();
  assert.equal((await importResponsePromise).status(), 201);
  await page.getByText(/Созданы 1 главный и 10 дополнительных черновиков вопросов/u).waitFor();
  assert.ok(objectSearchQueries.includes('ctdth'));
  assert.deepEqual(objectImportPayloads.map((payload) => payload.replaceExistingQuestions), [false, true]);

  await page.getByRole('tab', { name: 'Контент и оценивание' }).click();
  await page.getByLabel('Текст главного вопроса').waitFor();
  assert.equal(await page.getByLabel('Текст главного вопроса').inputValue(), generatedMainQuestion());
  assert.equal(await page.getByLabel('Дополнительный вопрос 10').inputValue(), generatedFollowUpQuestions()[9]);
  await page.getByRole('tab', { name: 'Материалы' }).click();

  await createManual();
  await createOfficialUrl();
  await createObjectSnapshot();
  await createPdf();
  assert.equal(await page.locator('.training-material-card').count(), 6);

  await page.locator('.training-material-card').filter({ hasText: 'URL source' }).getByRole('button', { name: 'Открыть' }).click();
  await page.getByText('https://official.test/final', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Новая revision' }).click();
  await page.getByText('Revision 2', { exact: true }).waitFor();
  await page.getByText('Добавленные segments').waitFor();
  await page.getByRole('button', { name: /#1 READY/u }).click();
  await page.getByText('Revision 1', { exact: true }).waitFor();
  await page.getByRole('button', { name: /#2 READY/u }).click();

  await page.getByRole('button', { name: 'Сгенерировать' }).click();
  await page.getByText('Предложенный факт из URL.').waitFor();
  const suggestion = page.locator('.training-suggestion-editor');
  await suggestion.getByText('Выбрать suggestion').click();
  await suggestion.getByLabel('Факт').fill('Отредактированный подтверждённый факт.');
  const applyResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/apply-suggestions') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Применить выбранные (1)' }).click();
  assert.equal((await applyResponsePromise).status(), 201);
  assert.equal(appliedPayload.suggestions[0].statement, 'Отредактированный подтверждённый факт.');
  assert.equal(confirmedUrlPayload.officialConfirmed, true);

  await page.getByRole('tab', { name: 'Контент и оценивание' }).click();
  await page.getByText('PDF · Страница 1').first().waitFor();
  await page.getByText(/PDF проекта · «Высота потолков/u).first().waitFor();

  await page.goto(`${baseUrl}/training`);
  await page.getByRole('heading', { name: 'Учебные проекты' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Материалы' }).count(), 0);
  assert.equal(await page.getByText('Официальный URL').count(), 0);
} finally {
  await browser.close();
}

async function createManual() {
  await page.getByLabel('Тип источника').selectOption('MANUAL_TEXT');
  await page.locator('#training-material-title').fill('Manual source');
  await page.getByLabel('Plain text').fill('Ручной текст для immutable revision.');
  await page.getByRole('button', { name: 'Создать материал' }).click();
  await page.getByText('Manual source', { exact: true }).first().waitFor();
}

async function createOfficialUrl() {
  await page.getByLabel('Тип источника').selectOption('OFFICIAL_URL');
  await page.locator('#training-material-title').fill('URL source');
  await page.getByLabel('Одна официальная HTTPS-страница').fill('https://official.test/source');
  await page.getByText('Подтверждаю, что это официальный источник проекта').click();
  await page.getByRole('button', { name: 'Создать материал' }).click();
  await page.getByText('URL source', { exact: true }).first().waitFor();
}

async function createObjectSnapshot() {
  await page.getByLabel('Тип источника').selectOption('OBJECT_SNAPSHOT');
  await page.locator('#training-material-title').fill('Object source');
  await page.getByRole('button', { name: 'Создать материал' }).click();
  await page.getByText('Object source', { exact: true }).first().waitFor();
}

async function createPdf() {
  await page.getByLabel('Тип источника').selectOption('PDF');
  await page.locator('#training-material-title').fill('PDF source');
  await page.getByLabel('PDF с текстовым слоем').setInputFiles({
    name: 'fixture.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 synthetic browser fixture'),
  });
  await page.getByRole('button', { name: 'Создать материал' }).click();
  await page.getByText('PDF source', { exact: true }).first().waitFor();
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
