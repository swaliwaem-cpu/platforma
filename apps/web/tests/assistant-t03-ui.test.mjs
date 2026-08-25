import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const assistantSource = await readFile(new URL('../src/assistant/AssistantChat.tsx', import.meta.url), 'utf8');
const assistantStyles = await readFile(new URL('../src/assistant/assistant.css', import.meta.url), 'utf8');

test('Assistant T03 renders grounded facts and safe direct official lot links', () => {
  assert.match(assistantSource, /message\.answer\?\.kind === 'KNOWLEDGE_RESULTS'/u);
  assert.match(assistantSource, /Подтверждённые факты/u);
  assert.match(assistantSource, /На официальном сайте застройщика/u);
  assert.match(assistantSource, /target="_blank"/u);
  assert.match(assistantSource, /rel="noopener noreferrer"/u);
  assert.doesNotMatch(assistantSource, /sourceRevisionId/u);
});

test('Assistant T03 freshness and lot metadata use a readable text token on light cards', () => {
  const subtitleRule = assistantStyles.match(/\.assistant-result-subtitle\s*\{[^}]+\}/u)?.[0] ?? '';
  const freshnessRule = assistantStyles.match(/\.assistant-result-freshness\s*\{[^}]+\}/u)?.[0] ?? '';

  assert.match(subtitleRule, /var\(--color-muted-foreground, #756a64\)/u);
  assert.match(freshnessRule, /var\(--color-muted-foreground, #756a64\)/u);
});
