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

test('Assistant T03 fact cards expose their canonical official source and verification time', () => {
  assert.match(assistantSource, /fact\.sourceUrl/u);
  assert.match(assistantSource, /fact\.sourceLabel/u);
  assert.match(assistantSource, /dateTime=\{fact\.verifiedAt\}/u);
  assert.match(assistantSource, /rel="noopener noreferrer"/u);
  const sourceLinkRule = assistantStyles.match(/\.assistant-knowledge-source a\s*\{[^}]+\}/u)?.[0] ?? '';
  assert.match(sourceLinkRule, /min-height:\s*44px/u);
});

test('Assistant T03 renders two labelled comparison groups and stacks them on mobile', () => {
  assert.match(assistantSource, /message\.answer\?\.kind === 'COMPARISON_RESULTS'/u);
  assert.match(assistantSource, /answer\.groups\.map/u);
  assert.match(assistantSource, /Данных по точным критериям нет/u);
  const comparisonRule = assistantStyles.match(/\.assistant-comparison-grid\s*\{[^}]+\}/u)?.[0] ?? '';
  assert.match(comparisonRule, /repeat\(2, minmax\(0, 1fr\)\)/u);
  const mobileStyles = assistantStyles.match(/@media \(max-width: 760px\)\s*\{[\s\S]+?\n\}/u)?.[0] ?? '';
  assert.match(mobileStyles, /\.assistant-comparison-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/u);
  const comparisonGroup = assistantSource.match(/function AssistantComparisonGroup[\s\S]+?\n\}\n\nfunction AssistantSearchResults/u)?.[0] ?? '';
  assert.match(comparisonGroup, /firstAdditionalResultRef/u);
  assert.match(comparisonGroup, /aria-controls=\{resultsId\}/u);
  assert.match(comparisonGroup, /titleRef=\{index === group\.exactResults\.length/u);
  assert.match(comparisonGroup, /aria-live="polite"/u);
});
