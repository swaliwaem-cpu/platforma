// Class suggestions for published projects without a class: the model proposes, an admin decides.
//
//   node --env-file-if-exists=apps/api/.env apps/api/scripts/assistant-class-suggestions.cjs suggest [--limit 20] [--out file.csv]
//     Paid: one model call per project. Writes a CSV with an empty «final» column.
//   node --env-file-if-exists=apps/api/.env apps/api/scripts/assistant-class-suggestions.cjs apply --file file.csv [--overwrite] [--write --actor-email a@b]
//     Sets the class where «final» is filled. Without --write it only prints what would change;
//     --write needs the admin who reviewed the CSV, for the audit log.
//     A project that got a class in the meantime is skipped unless --overwrite is given.
//
// Build apps/api first (pnpm build:api): the script uses the compiled model client.
require('reflect-metadata');

const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const { PROPERTY_CLASSES, normalizePropertyClass } = require('@platforma/shared/property-class');

const csvColumns = ['object_id', 'title', 'suggested_class', 'confidence', 'reason', 'admin_url', 'final'];
const maxDescriptionChars = 1_500;

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`class suggestions failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main(argv) {
  const [mode, ...rest] = argv.filter((argument) => argument !== '--');
  const options = readOptions(rest);
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    if (mode === 'suggest') await suggest(prisma, options);
    else if (mode === 'apply') await apply(prisma, options);
    else throw new Error('mode must be suggest or apply');
  } finally {
    await prisma.$disconnect();
  }
}

async function suggest(prisma, options) {
  const { AssistantLlmClient } = require(resolve(__dirname, '../dist/assistant/assistant-llm.client.js'));
  const llm = new AssistantLlmClient();
  if (!llm.isConfigured()) throw new Error('ALIBABA_API_KEY is not set');

  // Median over projects (each project's own median), so a few big projects do not set the level.
  const medians = await prisma.$queryRaw`
    SELECT "propertyClass", percentile_cont(0.5) WITHIN GROUP (ORDER BY median)::bigint AS median, COUNT(*)::int AS projects
    FROM (
      SELECT o.property_class AS "propertyClass",
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ${lotPricePerMeterSql()}) AS median
      FROM feed_units fu
      JOIN feed_sources fs ON fs.id = fu.source_id
      JOIN real_estate_objects o ON o.id = fu.object_id
      WHERE ${availableLotSql()} AND o.property_class IS NOT NULL
        AND o.status = 'published'::object_status AND o.deleted_at IS NULL
      GROUP BY o.id, o.property_class
    ) per_project
    GROUP BY "propertyClass"
  `;
  const projects = await prisma.$queryRaw`
    SELECT o.id::text AS id, o.title, o.address, o.description, o.short_description AS "shortDescription",
      o.ceiling_height AS "ceilingHeight", o.features_json AS features,
      COALESCE(o.feed_price_per_meter_from, o.price_per_meter_from)::bigint AS "pricePerMeterFrom",
      d.name AS developer, l.name AS district,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ${lotPricePerMeterSql()})::bigint
        FROM feed_units fu JOIN feed_sources fs ON fs.id = fu.source_id
        WHERE fu.object_id = o.id AND ${availableLotSql()}) AS "medianPricePerMeter"
    FROM real_estate_objects o
    LEFT JOIN developers d ON d.id = o.developer_id
    LEFT JOIN locations l ON l.id = o.primary_location_id
    WHERE o.status = 'published'::object_status AND o.deleted_at IS NULL AND o.property_class IS NULL
    ORDER BY o.title
  `;
  const selected = options.limit ? projects.slice(0, options.limit) : projects;
  const appUrl = (process.env.PUBLIC_APP_URL?.trim() || 'http://localhost:5173').replace(/\/+$/u, '');
  const medianText = medians.length
    ? medians.map((row) => `${row.propertyClass}: ${formatNumber(row.median)} ₽/м² (${row.projects} ЖК)`).join('; ')
    : 'нет размеченных ЖК';

  const rows = [];
  for (const project of selected) {
    process.stderr.write(`${project.title} … `);
    const suggestion = await suggestClass(llm, project, medianText).catch((error) => ({
      propertyClass: '',
      confidence: '',
      reason: `ошибка: ${error instanceof Error ? error.message : String(error)}`,
    }));
    process.stderr.write(`${suggestion.propertyClass || '—'}\n`);
    rows.push({
      object_id: project.id,
      title: project.title,
      suggested_class: suggestion.propertyClass,
      confidence: suggestion.confidence,
      reason: suggestion.reason,
      admin_url: `${appUrl}/admin/objects/${project.id}/edit`,
      final: '',
    });
  }
  const out = resolve(options.out ?? `assistant-class-suggestions-${new Date().toISOString().slice(0, 10)}.csv`);
  writeFileSync(out, toCsv(rows, csvColumns));
  process.stderr.write(`${rows.length} projects, CSV: ${out}\n`);
}

async function suggestClass(llm, project, medianText) {
  const facts = [
    `Название: ${project.title}`,
    `Застройщик: ${project.developer ?? 'нет данных'}`,
    `Район: ${project.district ?? 'нет данных'}`,
    `Адрес: ${project.address ?? 'нет данных'}`,
    `Цена за м² по доступным лотам (медиана): ${project.medianPricePerMeter ? `${formatNumber(project.medianPricePerMeter)} ₽` : 'нет данных'}`,
    `Цена за м² от (карточка): ${project.pricePerMeterFrom ? `${formatNumber(project.pricePerMeterFrom)} ₽` : 'нет данных'}`,
    `Потолки: ${project.ceilingHeight ?? 'нет данных'}`,
    `Характеристики и метки сайта: ${project.features ? JSON.stringify(project.features).slice(0, maxDescriptionChars) : 'нет'}`,
    `Описание: ${plainText(project.description || project.shortDescription || '').slice(0, maxDescriptionChars) || 'нет'}`,
  ].join('\n');
  const response = await llm.complete({
    messages: [
      {
        role: 'system',
        content: [
          'Ты аналитик рынка новостроек Москвы. Определи класс жилого комплекса.',
          `Допустимые классы: ${PROPERTY_CLASSES.join(', ')}. «Элитный» и «de luxe» — это Делюкс.`,
          `Медианы цены за м² по уже размеченным ЖК Platforma: ${medianText}.`,
          'Учитывай цену за метр относительно медиан, локацию, потолки, описание и застройщика.',
          'Если данных мало, всё равно выбери класс, но поставь низкую уверенность.',
        ].join('\n'),
      },
      { role: 'user', content: facts },
    ],
    tools: [{
      name: 'suggest_class',
      description: 'Предложенный класс ЖК.',
      parameters: {
        type: 'object',
        properties: {
          propertyClass: { type: 'string', enum: [...PROPERTY_CLASSES] },
          confidence: { type: 'string', enum: ['высокая', 'средняя', 'низкая'] },
          reason: { type: 'string', description: 'Одно короткое предложение: почему.' },
        },
        required: ['propertyClass', 'confidence', 'reason'],
      },
    }],
    requiredTool: 'suggest_class',
  });
  const args = JSON.parse(response.toolCalls[0]?.arguments ?? '{}');
  return {
    propertyClass: normalizePropertyClass(args.propertyClass) ?? '',
    confidence: typeof args.confidence === 'string' ? args.confidence : '',
    reason: typeof args.reason === 'string' ? args.reason.slice(0, 300) : '',
  };
}

async function apply(prisma, options) {
  if (!options.file) throw new Error('--file is required');
  const rows = parseCsv(readFileSync(resolve(options.file), 'utf8'));
  const actor = options.actorEmail
    ? await prisma.user.findUnique({ where: { email: options.actorEmail }, select: { id: true } })
    : null;
  if (options.actorEmail && !actor) throw new Error(`user ${options.actorEmail} not found`);
  // Like an edit in the admin, every written change names the admin who approved it.
  if (options.write && !actor) throw new Error('--write needs --actor-email of the admin who reviewed the CSV');

  const summary = { updated: 0, unchanged: 0, skipped: 0, invalid: 0 };
  for (const row of rows) {
    if (!row.final?.trim()) continue;
    const propertyClass = normalizePropertyClass(row.final);
    if (!propertyClass) {
      summary.invalid += 1;
      process.stderr.write(`invalid class «${row.final}» for ${row.title} (${row.object_id})\n`);
      continue;
    }
    const object = await prisma.realEstateObject.findFirst({
      where: { id: row.object_id, deletedAt: null },
      select: { id: true, title: true, propertyClass: true },
    });
    if (!object) {
      summary.skipped += 1;
      process.stderr.write(`not found: ${row.object_id}\n`);
      continue;
    }
    if (object.propertyClass === propertyClass) {
      summary.unchanged += 1;
      continue;
    }
    if (object.propertyClass && !options.overwrite) {
      summary.skipped += 1;
      process.stderr.write(`kept «${object.propertyClass}» for ${object.title}: already set\n`);
      continue;
    }
    process.stderr.write(`${options.write ? 'set' : 'would set'} «${propertyClass}» for ${object.title}\n`);
    if (options.write) {
      const change = { from: object.propertyClass, to: propertyClass };
      await prisma.$transaction([
        prisma.realEstateObject.update({ where: { id: object.id }, data: { propertyClass } }),
        // Same audit shape as an edit in the admin, marked with where it came from.
        prisma.auditLog.create({
          data: {
            actorUserId: actor.id,
            action: 'object.update',
            entityType: 'object',
            entityId: object.id,
            objectId: object.id,
            metadata: {
              before: { propertyClass: object.propertyClass },
              after: { propertyClass },
              changes: { propertyClass: change },
              source: 'assistant-class-suggestions',
            },
            userAgent: 'assistant-class-suggestions',
          },
        }),
      ]);
    }
    summary.updated += 1;
  }
  process.stderr.write(`${options.write ? '' : 'dry run: '}${JSON.stringify(summary)}\n`);
}

function lotPricePerMeterSql() {
  const { Prisma } = require('@prisma/client');
  return Prisma.sql`COALESCE(fu.effective_price_per_meter, fu.discount_price_per_meter, fu.price_per_meter)`;
}

function availableLotSql() {
  const { Prisma } = require('@prisma/client');
  return Prisma.sql`fu.status = 'available'::feed_unit_status AND fu.archived_at IS NULL
    AND fu.type = 'residential'::feed_unit_type AND fs.deleted_at IS NULL AND fs.is_active = TRUE
    AND COALESCE(fu.effective_price_per_meter, fu.discount_price_per_meter, fu.price_per_meter) > 0`;
}

function plainText(value) {
  return String(value).replace(/<[^>]+>/gu, ' ').replace(/&nbsp;/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function formatNumber(value) {
  return Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

function toCsv(rows, columns) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",;\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
  };
  return `${[columns, ...rows.map((row) => columns.map((column) => row[column]))]
    .map((values) => values.map(escape).join(','))
    .join('\n')}\n`;
}

// RFC 4180: quoted fields may hold separators, quotes ("") and line breaks. The first row is the
// header; the separator is a comma or, as Excel saves it in the Russian locale, a semicolon.
function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/u, '');
  const headerLine = source.split(/\r?\n/u, 1)[0] ?? '';
  const separator = (headerLine.match(/;/gu)?.length ?? 0) > (headerLine.match(/,/gu)?.length ?? 0) ? ';' : ',';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === separator) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  const [header = [], ...body] = records.filter((values) => values.some((value) => value.trim()));
  return body.map((values) => Object.fromEntries(header.map((name, column) => [name.trim(), values[column] ?? ''])));
}

function readOptions(argv) {
  const options = { limit: undefined, out: undefined, file: undefined, actorEmail: undefined, overwrite: false, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--limit') options.limit = Number(argv[++index]) || undefined;
    else if (argument === '--out') options.out = argv[++index];
    else if (argument === '--file') options.file = argv[++index];
    else if (argument === '--actor-email') options.actorEmail = argv[++index];
    else if (argument === '--overwrite') options.overwrite = true;
    else if (argument === '--write') options.write = true;
    else throw new Error(`unknown option ${argument}`);
  }
  return options;
}

module.exports = { parseCsv, toCsv };
