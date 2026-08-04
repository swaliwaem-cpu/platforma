require('reflect-metadata');

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  escapeTrainingRankingCsvCell,
  serializeTrainingRankingCsv,
} = require('../dist/training/training-ranking.service.js');
const {
  parseTrainingAdminRankingQuery,
} = require('../dist/training/training.validation.js');

test('Stage 5 Part 2 parses bounded ranking filters and tri-state flags', () => {
  assert.deepEqual(parseTrainingAdminRankingQuery({}), {
    page: 1,
    limit: 20,
    search: null,
    project: null,
    accessMode: null,
    currentlyAssigned: null,
    currentlyEligible: null,
  });
  assert.deepEqual(parseTrainingAdminRankingQuery({
    page: '3', limit: '100', search: '  Иван  ', project: '  Башня  ',
    accessMode: 'ASSIGNED_USERS', currentlyAssigned: 'false', currentlyEligible: 'true',
  }), {
    page: 3,
    limit: 100,
    search: 'Иван',
    project: 'Башня',
    accessMode: 'ASSIGNED_USERS',
    currentlyAssigned: false,
    currentlyEligible: true,
  });
  assert.throws(() => parseTrainingAdminRankingQuery({ limit: '101' }), /limit must be at most 100/u);
  assert.throws(() => parseTrainingAdminRankingQuery({ currentlyEligible: 'yes' }), /currentlyEligible must be true or false/u);
});

test('Stage 5 Part 2 CSV quotes every cell and blocks spreadsheet formulas', () => {
  for (const value of ['=1+1', '+SUM(A1:A2)', '-2+3', '@cmd', '  =hidden', '\tformula', '\rformula', '\nformula']) {
    assert.equal(escapeTrainingRankingCsvCell(value).startsWith('"\''), true, value);
  }
  assert.equal(escapeTrainingRankingCsvCell('normal'), '"normal"');
  assert.equal(escapeTrainingRankingCsvCell('a,"b"'), '"a,""b"""');
  assert.equal(serializeTrainingRankingCsv(['Иван', null, 42]), '"Иван","","42"');
});

test('Stage 5 Part 2 ranking service keeps aggregation and pagination in SQL', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/training/training-ranking.service.ts'),
    'utf8',
  );
  assert.match(source, /ROW_NUMBER\(\) OVER/u);
  assert.match(source, /COUNT\(\*\) OVER\(\)/u);
  assert.match(source, /LIMIT \$\{query\.limit\}/u);
  assert.match(source, /OFFSET \$\{offset\}/u);
  assert.match(source, /AVG\("finalScore"::numeric\)/u);
  assert.doesNotMatch(source, /findMany\(/u);
});
