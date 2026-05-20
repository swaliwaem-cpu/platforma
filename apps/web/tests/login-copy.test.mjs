import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const authProviderSource = readFileSync(resolve(currentDir, '../src/auth/AuthProvider.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

test('login screen shows broker platform and FluffyWhite titles', () => {
  assert.match(appSource, /<p className="eyebrow">Платформа брокеров<\/p>/);
  assert.match(appSource, /<h1 id="login-title">FluffyWhite<\/h1>/);
});

test('login screen exposes entry points for password login and email registration', () => {
  assert.match(appSource, /type LoginMode = 'login' \| 'register'/);
  assert.match(appSource, />\s*Вход\s*<\/button>/);
  assert.match(appSource, />\s*Регистрация\s*<\/button>/);
  assert.match(appSource, /Введите ваш email/);
  assert.match(appSource, /Введите код из письма/);
  assert.match(appSource, /Придумайте пароль/);
  assert.match(appSource, /registration-password-confirmation/);
  assert.match(appSource, /Пароль должен быть от 8 символов/);
  assert.match(appSource, /auth_token/);
  assert.match(styles, /\.login-mode-toggle\s*\{/);
  assert.match(styles, /\.registration-password-grid\s*\{/);
});

test('auth provider calls email registration endpoints and applies verified sessions', () => {
  assert.match(authProviderSource, /requestEmailRegistration: \(email: string\) => Promise<void>/);
  assert.match(authProviderSource, /verifyEmailRegistration: \(input: EmailRegistrationVerifyInput\) => Promise<void>/);
  assert.match(authProviderSource, /\/auth\/register\/request/);
  assert.match(authProviderSource, /\/auth\/register\/verify/);
  assert.match(authProviderSource, /applyAuthResponse\(\(await response\.json\(\)\) as AuthResponse\)/);
});
