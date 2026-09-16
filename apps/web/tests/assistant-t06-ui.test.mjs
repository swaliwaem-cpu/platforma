import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, auditSource, chatSource, apiSource, assistantStyles, appStyles, sharedSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/admin/AssistantAuditAdminPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/assistant/AssistantChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/assistant/assistantApi.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/assistant/assistant.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../../../packages/shared/src/assistant.ts', import.meta.url), 'utf8'),
]);

test('Assistant T06 user feedback is bounded, accessible and persists only through the feedback endpoint', () => {
  assert.match(apiSource, /\/assistant\/messages\/\$\{encodeURIComponent\(messageId\)\}\/feedback/u);
  assert.match(chatSource, /aria-pressed=\{rating === 'LIKE'\}/u);
  assert.match(chatSource, /aria-pressed=\{rating === 'DISLIKE'\}/u);
  assert.match(chatSource, /maxLength=\{500\}/u);
  assert.match(chatSource, /Спасибо, оценка попадёт на проверку/u);
  assert.match(sharedSource, /feedback: AssistantFeedback \| null/u);
  assert.match(assistantStyles, /\.assistant-feedback-rating:focus-visible/u);
  assert.match(assistantStyles, /\.assistant-feedback-rating[\s\S]*width: 44px/u);
});

test('Assistant T06 user contract does not render evidence or provider telemetry', () => {
  assert.doesNotMatch(chatSource, /auditJson|evidenceJson|telemetryJson|rawPayload|requestId|responseId/u);
  assert.doesNotMatch(sharedSource.match(/export type AssistantMessage = \{[\s\S]*?\n\};/u)?.[0] ?? '', /evidence|telemetry|audit/u);
});

test('Assistant T06 admin audit is lazy, additive-permission gated and covers evidence plus operations', () => {
  assert.match(appSource, /import\('\.\/admin\/AssistantAuditAdminPage'\)/u);
  assert.match(appSource, /hasPermission\('assistant:audit:read'\)/u);
  for (const endpoint of [
    '/assistant/audit/runs',
    '/assistant/audit/sources',
    '/assistant/audit/geo/operations',
    '/assistant/audit/geo/aliases',
    '/assistant/audit/metrics',
  ]) {
    assert.equal(auditSource.includes(endpoint), true, `missing ${endpoint}`);
  }
  assert.match(auditSource, /candidateSet/u);
  assert.match(auditSource, /rankingDecisions/u);
  assert.match(auditSource, /evidenceRevisions/u);
  assert.match(auditSource, /Страница \{page\} из \{totalPages\}/u);
  assert.match(auditSource, /Запуск не удалось открыть/u);
  assert.match(auditSource, /page: String\(page\)/u);
  assert.match(auditSource, /Provider attempts/u);
  assert.match(auditSource, /Idempotency-Key/u);
  assert.match(auditSource, /sourceRefreshKeys = useRef\(new Map/u);
  assert.match(auditSource, /sourceRefreshKeys\.current\.delete\(operationKey\)/u);
  assert.match(auditSource, /response\.page > lastPage/u);
  assert.match(auditSource, /expectedFeedbackUpdatedAt: runDetail\.feedback\.updatedAt/u);
  assert.match(auditSource, /\/assistant\/geo\/aliases/u);
});

test('Assistant T06 audit styles use app theme tokens and responsive overflow boundaries', () => {
  const auditStyles = appStyles.slice(appStyles.indexOf('.assistant-audit-page'));
  assert.match(auditStyles, /--app-theme-ink-700/u);
  assert.match(auditStyles, /--app-theme-surface/u);
  assert.doesNotMatch(auditStyles, /--color-muted/u);
  assert.match(auditStyles, /overflow-x: auto/u);
  assert.match(auditStyles, /@media \(max-width: 560px\)/u);
});
