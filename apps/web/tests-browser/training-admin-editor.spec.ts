import { expect, test, type Page, type Route } from '@playwright/test';

const apiOrigin = 'http://localhost:3000';
const projectId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const mainQuestionId = '33333333-3333-4333-8333-333333333333';
const followUpQuestionId = '44444444-4444-4444-8444-444444444444';
const factId = '55555555-5555-4555-8555-555555555555';
const mainCriterionId = '66666666-6666-4666-8666-666666666666';
const followUpCriterionId = '77777777-7777-4777-8777-777777777777';

test('master-detail keeps drafts mounted and aligns every checkbox with its copy', async ({
  page,
}) => {
  await installEditorApi(page);
  await page.goto(`/admin/training/${projectId}/edit`);
  await expect(page.getByRole('heading', { name: 'Карточка проекта' })).toBeVisible();

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

  await page.getByRole('button', { name: 'Дополнительные вопросы' }).click();
  const firstQuestionPanel = page.locator(
    `[data-editor-panel-id="${followUpQuestionId}"]`,
  );
  const questionTextarea = firstQuestionPanel.getByLabel('Текст вопроса');
  await questionTextarea.fill('Несохранённый текст дополнительного вопроса');
  await page.getByRole('button', { name: /Добавить вопрос/ }).click();
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

  await page.getByRole('button', { name: 'Факты' }).click();
  await expectCheckboxGeometry(
    page.locator('.training-choice-row').filter({
      hasText: 'Главный вопрос',
    }),
  );
  await expectCheckboxGeometry(
    page.locator('.training-approval').filter({
      hasText: 'Факт проверен',
    }),
  );

  await page.getByRole('button', { name: 'Критерии' }).click();
  const master = page.locator('.training-master-pane');
  const detail = page.locator('.training-detail-pane');
  const [masterBox, detailBox] = await Promise.all([
    master.boundingBox(),
    detail.boundingBox(),
  ]);
  expect(masterBox).not.toBeNull();
  expect(detailBox).not.toBeNull();
  expect(detailBox!.width).toBeGreaterThan(masterBox!.width * 1.5);
  await expect(
    page.locator('[data-editor-panel-id]:visible'),
  ).toHaveCount(1);
  await expect(
    page.locator(`[data-editor-item-id="${mainCriterionId}"]`),
  ).toHaveAttribute('aria-current', 'true');
});

test('mobile editor replaces the rail with a selector and does not overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installEditorApi(page);
  await page.goto(`/admin/training/${projectId}/edit`);

  await expect(page.locator('.training-master-pane')).toBeHidden();
  await expect(page.locator('.training-master-mobile select')).toBeVisible();

  await page.getByRole('button', { name: 'Дополнительные вопросы' }).click();
  await expect(
    page.locator('.training-master-mobile').getByRole('button', {
      name: 'Добавить вопрос',
    }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Факты' }).click();
  await expect(
    page.locator('.training-master-mobile').getByRole('button', {
      name: 'Добавить факт',
    }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Критерии' }).click();
  await expect(
    page.locator('.training-master-mobile').getByRole('button', {
      name: 'Добавить критерий',
    }),
  ).toHaveCount(2);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('read-only version keeps master navigation available while fields stay disabled', async ({
  page,
}) => {
  await installEditorApi(page, 'PUBLISHED');
  await page.goto(`/admin/training/${projectId}/edit`);

  const availabilityButton = page.getByRole('button', { name: /Доступность/ });
  await expect(availabilityButton).toBeEnabled();
  await availabilityButton.click();
  await expect(availabilityButton).toHaveAttribute('aria-current', 'true');
  await expect(page.getByLabel('Доступен с')).toBeDisabled();
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
) {
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
      await fulfillJson(route, { project: editorProject(versionStatus) });
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
