import { expect, test, type Page, type Route } from '@playwright/test';

const apiOrigin = 'http://localhost:3000';
const projectId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const mainQuestionId = '33333333-3333-4333-8333-333333333333';
const followUpQuestionId = '44444444-4444-4444-8444-444444444444';
const factId = '55555555-5555-4555-8555-555555555555';
const mainCriterionId = '66666666-6666-4666-8666-666666666666';
const followUpCriterionId = '77777777-7777-4777-8777-777777777777';
const suggestionId = '88888888-8888-4888-8888-888888888888';
const legacyEditorSelectors = [
  '.training-editor-tabs',
  '.training-card-list',
  '.training-criterion-summary',
].join(', ');

test('training CSS visual baseline: desktop master-detail keeps drafts mounted and aligns every checkbox with its copy', async ({
  page,
}) => {
  await installEditorApi(page);
  await page.goto(`/admin/training/${projectId}/edit`);
  await expect(page.getByRole('heading', { name: 'Карточка проекта' })).toBeVisible();
  const suggestionsStepLabel = page
    .locator('.training-wizard-step-copy strong')
    .filter({ hasText: 'Предложенные факты' });
  await expect(suggestionsStepLabel).toBeVisible();
  expect(
    await suggestionsStepLabel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);

  const titleInput = page.getByLabel('Название');
  await titleInput.fill('Несохранённый локальный заголовок');
  await page.getByRole('button', { name: /Доступность/ }).click();
  await expect(titleInput).toBeHidden();
  await page.getByRole('button', { name: /Карточка проекта/ }).click();
  await expect(titleInput).toHaveValue('Несохранённый локальный заголовок');

  await page.getByRole('button', { name: /Настройки попытки/ }).click();
  await expectCheckboxGeometry(
    page.locator('.training-checkbox-row').filter({
      hasText: 'Разрешить повторную попытку',
    }),
  );

  await page
    .locator('.training-wizard-step')
    .filter({ hasText: 'Вопросы' })
    .click();
  const firstQuestionPanel = page.locator(
    `[data-editor-panel-id="${followUpQuestionId}"]`,
  );
  const followUpEditor = page.locator('.training-master-detail').filter({
    has: firstQuestionPanel,
  });
  const questionTextarea = firstQuestionPanel.getByLabel('Текст вопроса');
  await questionTextarea.fill('Несохранённый текст дополнительного вопроса');
  await followUpEditor
    .getByRole('button', { name: 'Добавить дополнительный вопрос' })
    .click();
  await expect(firstQuestionPanel).toBeHidden();
  await page.locator(`[data-editor-item-id="${followUpQuestionId}"]`).click();
  await expect(questionTextarea).toHaveValue(
    'Несохранённый текст дополнительного вопроса',
  );
  await expectCheckboxGeometry(
    firstQuestionPanel.locator('.training-checkbox-row').filter({
      hasText: 'Активен',
    }),
  );
  await expect(
    firstQuestionPanel.getByRole('heading', {
      name: 'Что реально участвует в оценке',
    }),
  ).toBeVisible();

  await page
    .locator('.training-wizard-step')
    .filter({ hasText: 'Предложенные факты' })
    .click();
  const factPanel = page.locator(`[data-editor-panel-id="${factId}"]`);
  await expectCheckboxGeometry(
    factPanel.locator('.training-choice-row').filter({
      hasText: 'Главный вопрос',
    }),
  );
  await expectCheckboxGeometry(
    factPanel.locator('.training-approval').filter({
      hasText: 'Факт проверен',
    }),
  );

  await page
    .locator('.training-wizard-step')
    .filter({ hasText: 'Критерии' })
    .click();
  const activeStep = page.locator('[data-wizard-step="criteria"]');
  const master = activeStep.locator('.training-master-pane');
  const detail = activeStep.locator('.training-detail-pane');
  const [masterBox, detailBox] = await Promise.all([
    master.boundingBox(),
    detail.boundingBox(),
  ]);
  expect(masterBox).not.toBeNull();
  expect(detailBox).not.toBeNull();
  expect(detailBox!.width).toBeGreaterThan(masterBox!.width * 1.5);
  await expect(
    activeStep.locator('[data-editor-panel-id]:visible'),
  ).toHaveCount(1);
  await expect(
    page.locator(`[data-editor-item-id="${mainCriterionId}"]`),
  ).toHaveAttribute('aria-current', 'true');
  await expect(page.locator(legacyEditorSelectors)).toHaveCount(0);
  await expect(page).toHaveScreenshot('training-editor-desktop.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

test('training CSS visual baseline: mobile editor replaces the rail with a selector and does not overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installEditorApi(page);
  await page.goto(`/admin/training/${projectId}/edit`);

  await expect(page.locator('.training-master-pane')).toBeHidden();
  await expect(page.locator('.training-master-mobile select')).toBeVisible();
  const [menuBox, backBox] = await Promise.all([
    page.locator('.sidebar-toggle').boundingBox(),
    page.getByRole('button', { name: 'Назад' }).boundingBox(),
  ]);
  expect(menuBox).not.toBeNull();
  expect(backBox).not.toBeNull();
  expect(
    menuBox!.x < backBox!.x + backBox!.width &&
      menuBox!.x + menuBox!.width > backBox!.x &&
      menuBox!.y < backBox!.y + backBox!.height &&
      menuBox!.y + menuBox!.height > backBox!.y,
  ).toBe(false);

  await page.locator('.training-wizard-mobile select').selectOption('questions');
  await expect(
    page
      .locator('.training-master-mobile-action')
      .filter({ hasText: 'Дополнительные вопросы' })
      .getByRole('button', {
        name: 'Добавить дополнительный вопрос',
      }),
  ).toBeVisible();

  await page.locator('.training-wizard-mobile select').selectOption('suggestions');
  await expect(
    page
      .locator('[data-wizard-step="suggestions"]')
      .locator('.training-master-mobile')
      .getByRole('button', {
      name: 'Добавить факт',
    }),
  ).toBeVisible();

  await page.locator('.training-wizard-mobile select').selectOption('criteria');
  await expect(
    page
      .locator('[data-wizard-step="criteria"]')
      .locator('.training-master-mobile')
      .getByRole('button', {
      name: 'Добавить критерий',
    }),
  ).toHaveCount(2);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.locator(legacyEditorSelectors)).toHaveCount(0);
  await expect(page).toHaveScreenshot('training-editor-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

test('published project automatically opens an editable working revision', async ({
  page,
}) => {
  await installEditorApi(page, 'PUBLISHED');
  await page.goto(`/admin/training/${projectId}/edit`);

  await expect(page.getByText('Рабочая редакция', { exact: true })).toBeVisible();
  const availabilityButton = page.getByRole('button', { name: /Доступность/ });
  await expect(availabilityButton).toBeEnabled();
  await availabilityButton.click();
  await expect(availabilityButton).toHaveAttribute('aria-current', 'true');
  await expect(page.getByLabel('Доступен с')).toBeEnabled();
});

test('saving one card keeps another dirty item and publication blocked', async ({
  page,
}) => {
  await installEditorApi(page);
  await page.goto(`/admin/training/${projectId}/edit`);

  await page.getByLabel('Название').fill('Несохранённое название проекта');
  await page
    .locator('.training-wizard-step')
    .filter({ hasText: 'Вопросы' })
    .click();

  const questionPanel = page.locator(
    `[data-editor-panel-id="${followUpQuestionId}"]`,
  );
  await questionPanel
    .getByLabel('Текст вопроса')
    .fill('Сохранённый текст вопроса');
  await questionPanel.getByRole('button', { name: 'Сохранить' }).click();

  await page
    .locator('.training-wizard-step')
    .filter({ hasText: 'Проверка' })
    .click();
  await expect(
    page.getByText(
      'Есть несохранённые изменения. Сохраните их перед публикацией.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Опубликовать версию' }),
  ).toBeDisabled();
  await expect(page.getByText('Сначала сохраните изменения')).toBeVisible();
});

test('new MAIN and FOLLOW_UP forms have unique ids and cancel clears dirty focusably', async ({
  page,
}) => {
  await installEditorApi(page);
  await page.goto(`/admin/training/${projectId}/edit/questions`);

  await expect(page.locator('#training-add-question-main')).toHaveCount(0);
  await expect(
    page.locator('#training-add-question-main-desktop'),
  ).toHaveCount(1);
  await expect(page.locator('#training-add-question-main-mobile')).toHaveCount(
    1,
  );
  await expect(page.locator('#training-add-question-follow_up')).toHaveCount(0);
  await expect(
    page.locator('#training-add-question-follow_up-desktop'),
  ).toHaveCount(1);
  await expect(
    page.locator('#training-add-question-follow_up-mobile'),
  ).toHaveCount(1);

  await page
    .getByRole('button', { name: 'Добавить главный вопрос' })
    .click();
  await page
    .getByRole('button', { name: 'Добавить дополнительный вопрос' })
    .click();

  await expect(page.locator('#evaluation-context-new-question-main')).toHaveCount(
    1,
  );
  await expect(
    page.locator('#evaluation-context-new-question-follow_up'),
  ).toHaveCount(1);
  await expect(page.locator('#question-text-new-question-main')).toHaveCount(1);
  await expect(
    page.locator('#question-text-new-question-follow_up'),
  ).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        (document.activeElement as HTMLElement | null)?.dataset.editorPanelId,
    ),
  ).toBe('new-question-follow_up');

  const followUpPanel = page.locator(
    '[data-editor-panel-id="new-question-follow_up"]',
  );
  await followUpPanel
    .getByLabel('Текст вопроса')
    .fill('Черновик, который отменяем');
  await followUpPanel.getByRole('button', { name: 'Отмена' }).click();
  await expect(
    page.locator(
      '[data-training-focus-key="training-add-question-follow_up"]:visible',
    ),
  ).toBeFocused();

  const mainPanel = page.locator('[data-editor-panel-id="new-question-main"]');
  await mainPanel.getByRole('button', { name: 'Отмена' }).click();
  await expect(
    page.locator(
      '[data-training-focus-key="training-add-question-main"]:visible',
    ),
  ).toBeFocused();

  await page
    .locator('.training-wizard-step')
    .filter({ hasText: 'Проверка' })
    .click();
  await expect(
    page.getByText(
      'Есть несохранённые изменения. Сохраните их перед публикацией.',
      { exact: true },
    ),
  ).toHaveCount(0);
});

test('dirty editor guards sidebar navigation and restores browser Forward on cancel', async ({
  page,
}) => {
  await installEditorApi(page);
  await page.goto(`/admin/training/${projectId}/edit`);
  await page.getByLabel('Название').fill('Черновик перед переходом');
  await page.getByRole('button', { name: 'Раскрыть меню' }).click();

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Есть несохранённые изменения');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Админка', exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/admin/training/${projectId}/edit/?$`),
  );
  await expect(page.getByLabel('Название')).toHaveValue(
    'Черновик перед переходом',
  );

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Админка', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goBack();
  await expect(page).toHaveURL(
    new RegExp(`/admin/training/${projectId}/edit/?$`),
  );

  await page.getByLabel('Название').fill('Черновик перед Forward');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Есть несохранённые изменения');
    await dialog.dismiss();
  });
  await page.evaluate(() => window.history.forward());
  await expect(page).toHaveURL(
    new RegExp(`/admin/training/${projectId}/edit/?$`),
  );
  await expect(page.getByLabel('Название')).toHaveValue(
    'Черновик перед Forward',
  );

  page.once('dialog', (dialog) => dialog.accept());
  await page.evaluate(() => window.history.forward());
  await expect(page).toHaveURL(/\/admin$/);
});

test('readiness API failure is visible and publication fails closed', async ({
  page,
}) => {
  await installEditorApi(page, 'DRAFT', true);
  await page.goto(`/admin/training/${projectId}/edit/review`);

  const readinessSummary = page.locator('.training-readiness-summary');
  await expect(
    readinessSummary.getByText('Не удалось проверить готовность', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    readinessSummary.getByText('Публикация заблокирована.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Можно публиковать')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Опубликовать версию' }),
  ).toBeDisabled();
});

test('deleted questions are pruned without losing valid dirty links', async ({
  page,
}) => {
  await installEditorApi(page, 'DRAFT', false, true);
  await page.goto(`/admin/training/${projectId}/edit/suggestions`);

  const suggestionPanel = page.locator(
    `[data-editor-panel-id="${suggestionId}"]`,
  );
  const factPanel = page.locator(`[data-editor-panel-id="${factId}"]`);
  for (const panel of [suggestionPanel, factPanel]) {
    await panel
      .locator('.training-choice-row')
      .filter({ hasText: 'Дополнительный вопрос 1' })
      .locator('input[type="checkbox"]')
      .check();
  }
  await suggestionPanel
    .locator('.training-choice-row')
    .filter({ hasText: 'Главный вопрос' })
    .locator('input[type="checkbox"]')
    .check();
  await expect(
    page.getByRole('button', { name: /Сначала обработайте предложения: 1/ }),
  ).toBeDisabled();

  await page
    .locator('.training-wizard-step')
    .filter({ hasText: 'Вопросы' })
    .click();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .locator(`[data-editor-panel-id="${mainQuestionId}"]`)
    .getByRole('button', { name: 'Удалить' })
    .click();
  await expect(
    page.locator(`[data-editor-panel-id="${mainQuestionId}"]`),
  ).toHaveCount(0);

  await page
    .locator('.training-wizard-step')
    .filter({ hasText: 'Предложенные факты' })
    .click();
  for (const panel of [suggestionPanel, factPanel]) {
    await expect(
      panel.getByText('Главный вопрос', { exact: true }),
    ).toHaveCount(0);
    await expect(
      panel
        .locator('.training-choice-row')
        .filter({ hasText: 'Дополнительный вопрос 1' })
        .locator('input[type="checkbox"]'),
    ).toBeChecked();
    await expect(
      panel.getByText('Выбрано 1 из 1', { exact: true }),
    ).toBeVisible();
  }

  await page
    .locator('.training-wizard-step')
    .filter({ hasText: 'Проверка' })
    .click();
  await expect(
    page.getByText(
      'Есть несохранённые изменения. Сохраните их перед публикацией.',
      { exact: true },
    ),
  ).toBeVisible();
});

async function expectCheckboxGeometry(row: ReturnType<Page['locator']>) {
  const checkbox = row.locator('input[type="checkbox"]');
  const copy = row.locator('strong').first();
  const [checkboxBox, copyBox] = await Promise.all([
    checkbox.boundingBox(),
    copy.boundingBox(),
  ]);
  expect(checkboxBox).not.toBeNull();
  expect(copyBox).not.toBeNull();
  expect(checkboxBox!.width).toBeGreaterThanOrEqual(16);
  expect(checkboxBox!.width).toBeLessThanOrEqual(24);
  expect(checkboxBox!.height).toBeGreaterThanOrEqual(16);
  expect(checkboxBox!.height).toBeLessThanOrEqual(24);
  expect(copyBox!.x - (checkboxBox!.x + checkboxBox!.width)).toBeLessThanOrEqual(16);
}

async function installEditorApi(
  page: Page,
  versionStatus: 'DRAFT' | 'PUBLISHED' = 'DRAFT',
  readinessFails = false,
  includePendingSuggestion = false,
) {
  let currentVersionStatus = versionStatus;
  const deletedQuestionIds = new Set<string>();
  await page.route(`${apiOrigin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/refresh') {
      await fulfillJson(route, {
        accessToken: 'training-editor-token',
        user: {
          id: 'admin-1',
          email: 'admin@example.test',
          name: 'Admin',
          brokerPhone: null,
          brokerEmail: null,
          status: 'ACTIVE',
          role: { id: 'role-admin', name: 'admin' },
          profilePhotoFile: null,
          permissions: ['admin:access', 'training:projects:manage'],
        },
      });
      return;
    }
    if (path === `/training/admin/projects/${projectId}`) {
      const project = editorProject(currentVersionStatus);
      const projectVersion = project.versions[0];
      if (projectVersion) {
        projectVersion.questions = projectVersion.questions.filter(
          (question) => !deletedQuestionIds.has(question.id),
        );
      }
      await fulfillJson(route, { project });
      return;
    }
    if (
      path === `/training/admin/projects/${projectId}/assignments` &&
      route.request().method() === 'GET'
    ) {
      await fulfillJson(route, {
        audienceMode: 'ALL_ELIGIBLE',
        audienceRevision: 1,
        items: [],
        total: 0,
        eligibleTotal: 0,
      });
      return;
    }
    if (
      path === `/training/admin/projects/${projectId}/draft-version` &&
      route.request().method() === 'POST'
    ) {
      currentVersionStatus = 'DRAFT';
      await fulfillJson(route, {
        version: editorProject('DRAFT').versions[0],
      });
      return;
    }
    if (path === '/training/admin/real-estate-objects') {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (path === `/training/admin/versions/${versionId}/documents`) {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (
      path === `/training/admin/versions/${versionId}/official-url-sources`
    ) {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (path === `/training/admin/versions/${versionId}/fact-suggestions`) {
      await fulfillJson(route, {
        items: includePendingSuggestion ? [editorSuggestion()] : [],
      });
      return;
    }
    if (
      path ===
      `/training/admin/versions/${versionId}/fact-suggestion-runs/latest`
    ) {
      await fulfillJson(route, { run: null });
      return;
    }
    if (path === `/training/admin/versions/${versionId}/readiness`) {
      if (readinessFails) {
        await fulfillJson(route, { message: 'Readiness unavailable' }, 503);
        return;
      }
      await fulfillJson(route, { readiness: editorReadiness() });
      return;
    }
    if (
      path ===
        `/training/admin/versions/${versionId}/questions/${followUpQuestionId}` &&
      route.request().method() === 'PATCH'
    ) {
      const input = route.request().postDataJSON();
      await fulfillJson(route, {
        question: {
          id: followUpQuestionId,
          type: 'FOLLOW_UP',
          text: input.text,
          position: input.position,
          isActive: input.isActive,
          maxScore: 15,
          topicCodesJson: input.topicCodes,
        },
      });
      return;
    }
    if (
      path ===
        `/training/admin/versions/${versionId}/questions/${mainQuestionId}` &&
      route.request().method() === 'DELETE'
    ) {
      deletedQuestionIds.add(mainQuestionId);
      await fulfillJson(route, { deleted: true });
      return;
    }
    await fulfillJson(route, { message: `Unhandled test API route: ${path}` }, 404);
  });
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function editorProject(versionStatus: 'DRAFT' | 'PUBLISHED' = 'DRAFT') {
  const questions = [
    {
      id: mainQuestionId,
      type: 'MAIN',
      text: 'Какова главная ценность проекта?',
      position: 1,
      isActive: true,
      maxScore: 55,
      topicCodesJson: ['main'],
    },
    {
      id: followUpQuestionId,
      type: 'FOLLOW_UP',
      text: 'Кто является девелопером проекта?',
      position: 1,
      isActive: true,
      maxScore: 15,
      topicCodesJson: ['identity'],
    },
  ];
  return {
    id: projectId,
    slug: 'tate',
    title: 'ЖК TATE',
    description: 'Тестовый проект для визуальной проверки редактора.',
    status: 'DRAFT',
    sortOrder: 0,
    availableFrom: null,
    deadlineAt: null,
    activeVersionId: null,
    realEstateObjectId: null,
    realEstateObject: null,
    versions: [
      {
        id: versionId,
        projectId,
        versionNumber: 1,
        status: versionStatus,
        passScore: 75,
        attemptLimit: 3,
        cooldownMinutes: 60,
        totalTimeLimitSeconds: 420,
        finishGraceSeconds: 15,
        warningSecondsJson: [120, 60, 30],
        allowRetakeAfterPass: false,
        mainMaxScore: 55,
        followUpMaxScore: 15,
        scoringConfigJson: {},
        promptVersion: 'v1',
        schemaVersion: 'v1',
        publishedAt:
          versionStatus === 'PUBLISHED' ? '2026-07-28T10:00:00.000Z' : null,
        questions,
        facts: [
          {
            id: factId,
            code: 'architecture.author',
            topicCode: 'architecture',
            statement: 'Автор архитектуры — международное бюро.',
            acceptedAliasesJson: ['архитектурное бюро'],
            importance: 1,
            sourceDocumentId: null,
            sourceOfficialUrlId: null,
            sourceLocatorJson: null,
            isApproved: true,
            questionLinks: [{ questionId: mainQuestionId }],
          },
        ],
        criteria: [
          {
            id: mainCriterionId,
            questionType: 'MAIN',
            code: 'main.relevance',
            title: 'Клиентская релевантность',
            maxPoints: 55,
            description: 'Ответ раскрывает пользу для клиента.',
            anchorsJson: [],
            sortOrder: 1,
          },
          {
            id: followUpCriterionId,
            questionType: 'FOLLOW_UP',
            code: 'follow.accuracy',
            title: 'Точность',
            maxPoints: 15,
            description: 'Ответ точный и понятный.',
            anchorsJson: [],
            sortOrder: 1,
          },
        ],
      },
    ],
  };
}

function editorReadiness() {
  return {
    readyToPublish: false,
    facts: {
      approved: 1,
      total: 1,
      pendingSuggestions: 0,
      ready: true,
    },
    questions: {
      active: 2,
      required: 11,
      mainReady: true,
      followUpsReady: false,
      positionsReady: false,
      ready: false,
    },
    criteria: {
      mainPoints: 55,
      mainRequired: 55,
      followUpPoints: 15,
      followUpRequired: 15,
      ready: true,
    },
    issues: [
      {
        code: 'FOLLOW_UP_COUNT',
        step: 'questions',
        message: 'Нужно настроить 10 дополнительных вопросов.',
      },
    ],
  };
}

function editorSuggestion() {
  return {
    id: suggestionId,
    runId: '99999999-9999-4999-8999-999999999999',
    status: 'PENDING',
    suggestedCode: 'architecture.style',
    topicCode: 'architecture',
    statement: 'Архитектурная концепция формирует узнаваемый образ проекта.',
    acceptedAliases: [],
    importance: 1,
    sourceKind: 'DOCUMENT',
    sourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sourceLocator: { page: 1 },
    sourceQuote: 'Архитектурная концепция проекта.',
    acceptedFactId: null,
    decisionReason: null,
  };
}
