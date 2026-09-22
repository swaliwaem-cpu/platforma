import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');
const fluffyWhiteStyles = readFileSync(resolve(currentDir, '../src/fluffy-white-theme.css'), 'utf8');

test('profile page follows the reference layout: profile card next to the password card', () => {
  assert.match(appSource, /<header className="page-header cabinet-header">[\s\S]*?<h2>Профиль<\/h2>[\s\S]*?status-pill status-pill--\$\{user\.status\.toLowerCase\(\)\}/);
  assert.match(
    appSource,
    /<div className="cabinet-grid">[\s\S]*?<section className="content-panel cabinet-profile-card"[\s\S]*?<section className="content-panel cabinet-security-card"/,
  );
  assert.match(appSource, /<div className="cabinet-profile-intro">[\s\S]*?<ProfileAvatar[\s\S]*?<span className="role-pill">\{formatRoleName\(user\.role\.name\)\}<\/span>/);
  assert.match(appSource, /<div className="cabinet-security-head">[\s\S]*?<LockIcon \/>[\s\S]*?<h3 id="cabinet-password-title">Смена пароля<\/h3>/);
  assert.match(appSource, /className="secondary-button secondary-button--fit" disabled=\{isPasswordSubmitting\} type="submit"/);
  assert.match(styles, /\.cabinet-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 396px;[\s\S]*?\}/);
  assert.match(styles, /\.profile-form\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?gap:\s*14px;[\s\S]*?\}/);
  assert.match(
    fluffyWhiteStyles,
    /:root\[data-app-theme\] body :is\(\.cabinet-profile-card, \.cabinet-security-card\)\s*\{[\s\S]*?border-radius:\s*26px;[\s\S]*?padding:\s*24px;[\s\S]*?\}/,
  );
});

test('profile page drops the role sections block and its model', () => {
  for (const gone of [
    'cabinetSections',
    'CabinetSection',
    'getAvailableCabinetSections',
    'canAccessCabinetSection',
    'getCabinetSectionPath',
    'areSectionsVisible',
    'Разделы для роли',
    'cabinet-section-list',
    'cabinet-badges',
  ]) {
    assert.doesNotMatch(appSource, new RegExp(gone));
  }

  assert.doesNotMatch(styles, /\.cabinet-section-list|\.cabinet-section-main|\.cabinet-badges/);
});
