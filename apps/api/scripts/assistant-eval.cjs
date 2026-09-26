// Runs the assistant eval set against the live model and the local database, then writes
// a markdown report to docs/helpr2/eval/<date>-<commit>.md. Paid: every case calls the model.
//
//   pnpm assistant:eval                      whole set, web tools off
//   pnpm assistant:eval -- --only class-01   selected cases
//   pnpm assistant:eval -- --dist <dir>      another build of apps/api (for a baseline run)
//   pnpm assistant:eval -- --web             let the model search and open sites
require('reflect-metadata');

const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const repositoryRoot = resolve(__dirname, '../../..');
const defaultFixture = resolve(__dirname, '../tests/fixtures/assistant-eval/phase1.json');

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`assistant eval failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main(argv) {
  const options = readOptions(argv);
  const dist = resolve(options.dist ?? resolve(__dirname, '../dist'));
  const { runAssistantAgent } = require(resolve(dist, 'assistant/assistant-agent.js'));
  const { AssistantCatalogTools } = require(resolve(dist, 'assistant/assistant-catalog.tools.js'));
  const { AssistantLlmClient } = require(resolve(dist, 'assistant/assistant-llm.client.js'));
  const { AssistantWebTools } = require(resolve(dist, 'assistant/assistant-web.tools.js'));
  const { PrismaService } = require(resolve(dist, 'prisma/prisma.service.js'));
  const { estimateTrainingAiCost } = require(resolve(dist, 'training/training-ai-pricing.js'));

  const fixture = JSON.parse(readFileSync(options.fixture ?? defaultFixture, 'utf8'));
  const cases = options.only.length
    ? fixture.cases.filter((item) => options.only.includes(item.id))
    : fixture.cases;
  const llm = new AssistantLlmClient();
  if (!llm.isConfigured()) throw new Error('ALIBABA_API_KEY is not set');
  const model = process.env.ASSISTANT_MODEL?.trim() || 'deepseek-v4.1-flash';
  const prisma = new PrismaService();
  await prisma.$connect();
  const catalog = new AssistantCatalogTools(prisma);
  const web = options.web ? new AssistantWebTools() : disabledWeb();

  // Taken before the run: the checkout may move on while a long paid run is going.
  const commit = readCommit();
  const results = [];
  try {
    for (const item of cases) {
      process.stderr.write(`${item.id} … `);
      const result = await runCase({ runAssistantAgent, llm, catalog, web }, item);
      results.push(result);
      process.stderr.write(`${result.checks.every((check) => check.passed) ? 'ok' : 'FAIL'} (${result.durationMs} ms)\n`);
    }
  } finally {
    await prisma.$disconnect();
  }

  const date = new Date().toISOString().slice(0, 10);
  const report = renderReport({ fixture, results, model, commit, date, dist, web: options.web, estimateTrainingAiCost });
  const out = resolve(options.out ?? resolve(repositoryRoot, `docs/helpr2/eval/${date}-${commit}.md`));
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, report);
  const passed = results.filter((result) => result.checks.every((check) => check.passed)).length;
  process.stderr.write(`${passed}/${results.length} passed, report: ${out}\n`);
}

async function runCase({ runAssistantAgent, llm, catalog, web }, item) {
  const calls = [];
  const usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, modelCalls: 0 };
  const recordingLlm = {
    isConfigured: () => llm.isConfigured(),
    async complete(request) {
      const response = await llm.complete(request);
      usage.modelCalls += 1;
      usage.inputTokens += response.usage.inputTokens;
      usage.cachedTokens += response.usage.cachedTokens ?? 0;
      usage.outputTokens += response.usage.outputTokens;
      for (const call of response.toolCalls) calls.push({ name: call.name, args: parseJson(call.arguments) });
      return response;
    },
  };
  const history = [...(item.history ?? []), { role: 'user', content: item.question }];
  const startedAt = Date.now();
  let answer = null;
  let error = null;
  try {
    ({ answer } = await runAssistantAgent(
      { llm: recordingLlm, catalog, web },
      { history, pageProject: null, now: new Date() },
    ));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    item,
    answer,
    error,
    calls,
    usage,
    durationMs: Date.now() - startedAt,
    checks: error ? [{ label: `ошибка: ${error}`, passed: false }] : checkCase(item.expect ?? {}, { answer, calls }),
  };
}

// Pure: compares one answer and the tool calls the model made with the case expectations.
function checkCase(expect, { answer, calls }) {
  const checks = [];
  for (const expected of expect.tools ?? []) {
    const passed = calls.some((call) => call.name === expected.name && matchesArgs(expected.args ?? {}, call.args));
    checks.push({ label: `вызов ${expected.name}${expected.args ? ` ${JSON.stringify(expected.args)}` : ''}`, passed });
  }
  for (const name of expect.notTools ?? []) {
    checks.push({ label: `без ${name}`, passed: !calls.some((call) => call.name === name) });
  }
  const text = normalize(answer?.text ?? '');
  const mentioned = [
    ...(answer?.lots ?? []).map((lot) => lot.projectTitle),
    ...(answer?.sources ?? []).map((source) => source.title),
    answer?.text ?? '',
  ].map(normalize);
  for (const project of expect.projectsInclude ?? []) {
    checks.push({ label: `ЖК «${project}» в ответе`, passed: mentioned.some((value) => value.includes(normalize(project))) });
  }
  for (const project of expect.projectsExclude ?? []) {
    checks.push({ label: `ЖК «${project}» не в ответе`, passed: !mentioned.some((value) => value.includes(normalize(project))) });
  }
  for (const rule of expect.textIncludes ?? []) {
    const variants = Array.isArray(rule) ? rule : [rule];
    checks.push({ label: `есть «${variants.join(' | ')}»`, passed: variants.some((variant) => text.includes(normalize(variant))) });
  }
  for (const word of expect.textExcludes ?? []) {
    checks.push({ label: `нет «${word}»`, passed: !text.includes(normalize(word)) });
  }
  return checks;
}

function matchesArgs(expected, actual) {
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => matchesValue(value, actual[key]));
}

function matchesValue(expected, actual) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((item) => actual.some((candidate) => matchesValue(item, candidate)));
  }
  if (typeof expected === 'number') return Number(actual) === expected;
  if (typeof expected === 'boolean') return actual === expected;
  if (typeof expected === 'string') return typeof actual === 'string' && normalize(actual).includes(normalize(expected));
  if (expected && typeof expected === 'object') return matchesArgs(expected, actual);
  return expected === actual;
}

function normalize(value) {
  return String(value).toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
}

function renderReport({ fixture, results, model, commit, date, dist, web, estimateTrainingAiCost }) {
  const passedCases = results.filter((result) => result.checks.every((check) => check.passed));
  const totals = results.reduce((sum, result) => ({
    inputTokens: sum.inputTokens + result.usage.inputTokens,
    cachedTokens: sum.cachedTokens + result.usage.cachedTokens,
    outputTokens: sum.outputTokens + result.usage.outputTokens,
    durationMs: sum.durationMs + result.durationMs,
  }), { inputTokens: 0, cachedTokens: 0, outputTokens: 0, durationMs: 0 });
  const cost = estimateTrainingAiCost(model, {
    inputTokens: totals.inputTokens,
    cachedTokens: totals.cachedTokens,
    cacheWriteTokens: 0,
    outputTokens: totals.outputTokens,
    reasoningTokens: 0,
    totalTokens: totals.inputTokens + totals.outputTokens,
  });
  const groups = [...new Set(results.map((result) => result.item.group))];
  const lines = [
    `# Замер помощника ${date} (${commit})`,
    '',
    `- Набор: ${fixture.version}, вопросов: ${results.length}`,
    `- Модель: ${model}, веб: ${web ? 'включён' : 'выключен'}, сборка: \`${dist}\``,
    `- Прошло целиком: **${passedCases.length}/${results.length}**`,
    `- Токены: вход ${totals.inputTokens} (из кэша ${totals.cachedTokens}), выход ${totals.outputTokens}; оценка $${cost.estimatedCostUsd ?? '—'}`,
    `- Среднее время ответа: ${results.length ? Math.round(totals.durationMs / results.length) : 0} мс`,
    '',
    '| Группа | Прошло |',
    '|---|---|',
    ...groups.map((group) => {
      const inGroup = results.filter((result) => result.item.group === group);
      return `| ${group} | ${inGroup.filter((result) => result.checks.every((check) => check.passed)).length}/${inGroup.length} |`;
    }),
    '',
    '| # | Вопрос | Ответ | Проверки | Токены | Время |',
    '|---|---|---|---|---|---|',
    ...results.map((result) => {
      const answer = result.answer
        ? [result.answer.text, ...result.answer.lots.map((lot) => `[${lot.projectTitle}]`)].join(' ')
        : `ошибка: ${result.error}`;
      const checks = result.checks.map((check) => `${check.passed ? '✅' : '❌'} ${check.label}`).join('<br>');
      const tools = result.calls.map((call) => call.name).join(', ') || '—';
      return [
        result.item.id,
        cell(result.item.question),
        cell(answer, 400),
        `${cell(checks, 2000)}<br>инструменты: ${cell(tools)}`,
        `${result.usage.inputTokens}/${result.usage.outputTokens}`,
        `${(result.durationMs / 1000).toFixed(1)} с`,
      ].join(' | ').replace(/^/u, '| ').concat(' |');
    }),
    '',
  ];
  return lines.join('\n');
}

function cell(value, maxLength = 200) {
  const text = String(value).replace(/\s+/gu, ' ').replace(/\|/gu, '\\|').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function disabledWeb() {
  return {
    isSearchConfigured: () => false,
    async search() {
      throw new Error('EVAL_WEB_DISABLED');
    },
    async openPage() {
      throw new Error('EVAL_WEB_DISABLED');
    },
  };
}

function readOptions(argv) {
  const options = { only: [], web: false, dist: undefined, out: undefined, fixture: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--web') options.web = true;
    else if (argument === '--only') options.only = (argv[++index] ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    else if (argument === '--dist') options.dist = argv[++index];
    else if (argument === '--out') options.out = argv[++index];
    else if (argument === '--fixture') options.fixture = argv[++index];
    else if (argument !== '--') throw new Error(`unknown option ${argument}`);
  }
  return options;
}

function readCommit() {
  try {
    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'apps/api/src'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
    return dirty ? `${hash}-dirty` : hash;
  } catch {
    return 'unknown';
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

module.exports = { checkCase, matchesArgs };
