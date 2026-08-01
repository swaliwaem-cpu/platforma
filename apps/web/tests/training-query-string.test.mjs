import assert from 'node:assert/strict';
import test from 'node:test';

import { withTrainingQuery } from '../src/training/trainingQueryString.mjs';

test('training query serializer preserves omission and primitive coercion rules', () => {
  assert.equal(withTrainingQuery('/training/attempts', {}), '/training/attempts');
  assert.equal(
    withTrainingQuery('/training/attempts', {
      missing: undefined,
      empty: '',
    }),
    '/training/attempts',
  );
  assert.equal(
    withTrainingQuery('/training/attempts', {
      nil: null,
      off: false,
      zero: 0,
      list: ['a', 'б'],
      text: 'ЖК\u00a0TATE & =',
    }),
    '/training/attempts?nil=null&off=false&zero=0&list=a%2C%D0%B1&text=%D0%96%D0%9A%C2%A0TATE+%26+%3D',
  );
});

test('training query serializer preserves endpoint defaults and insertion order', () => {
  assert.equal(
    withTrainingQuery('/training/admin/projects', { page: 1, limit: 50 }),
    '/training/admin/projects?page=1&limit=50',
  );
  assert.equal(
    withTrainingQuery('/training/admin/real-estate-objects', {
      hasPdf: false,
      page: 1,
      limit: 20,
    }),
    '/training/admin/real-estate-objects?hasPdf=false&page=1&limit=20',
  );
  assert.equal(
    withTrainingQuery('/training/admin/assignees', { page: 1, limit: 20 }),
    '/training/admin/assignees?page=1&limit=20',
  );
  assert.equal(
    withTrainingQuery('/training/attempts', { pageSize: 100 }),
    '/training/attempts?pageSize=100',
  );
  assert.equal(
    withTrainingQuery('/training/admin/results', { page: 1, pageSize: 25 }),
    '/training/admin/results?page=1&pageSize=25',
  );
  assert.equal(
    withTrainingQuery('/training/admin/ranking', { page: 1, pageSize: 1 }),
    '/training/admin/ranking?page=1&pageSize=1',
  );
});
