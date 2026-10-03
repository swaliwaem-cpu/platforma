import { assistantMoscowAreaShapes } from './assistant-moscow-areas.data';

// Where a project stands in Moscow, by its coordinates. The rings, okrugs and districts are real
// outlines from OpenStreetMap, so «внутри ТТК» finds every project inside the ring, not only the
// ones whose card happens to carry such a tag.

/** Longitude first, as in GeoJSON. */
type Position = [number, number];
/** Outer ring first, then holes. */
type Polygon = Position[][];
type Shape = Polygon[];

export type AssistantAreaMatcher = {
  /** The area as it reads in answers, e.g. «между ТТК и МКАД». */
  label: string;
  contains: (longitude: number, latitude: number) => boolean;
};

const okrugs = [
  { short: 'ЦАО', name: 'Центральный административный округ', aliases: ['центр', 'в центре', 'центральный'] },
  { short: 'САО', name: 'Северный административный округ', aliases: ['север'] },
  { short: 'СВАО', name: 'Северо-Восточный административный округ', aliases: ['северо восток'] },
  { short: 'ВАО', name: 'Восточный административный округ', aliases: ['восток'] },
  { short: 'ЮВАО', name: 'Юго-Восточный административный округ', aliases: ['юго восток'] },
  { short: 'ЮАО', name: 'Южный административный округ', aliases: ['юг'] },
  { short: 'ЮЗАО', name: 'Юго-Западный административный округ', aliases: ['юго запад'] },
  { short: 'ЗАО', name: 'Западный административный округ', aliases: ['запад'] },
  { short: 'СЗАО', name: 'Северо-Западный административный округ', aliases: ['северо запад'] },
  { short: 'ЗелАО', name: 'Зеленоградский административный округ', aliases: ['зеленоград'] },
  { short: 'НАО', name: 'Новомосковский административный округ', aliases: ['новомосковский'] },
  { short: 'ТАО', name: 'Троицкий административный округ', aliases: ['троицкий'] },
] as const;

// Colloquial district names brokers use; official names and their «район …» forms work anyway.
const districtAliases: Record<string, string> = {
  пресня: 'Пресненский район',
};

type Shapes = {
  city: Shape;
  rings: Record<'Садовое кольцо' | 'ТТК' | 'МКАД', Shape>;
  okrugs: Map<string, Shape>;
  /** Normalized name without the word «район» → OSM name and outline. */
  districts: Map<string, { name: string; shape: Shape }>;
};

let shapes: Shapes | null = null;

function loadShapes(): Shapes {
  if (shapes) return shapes;
  const parse = (geometry: string) => (JSON.parse(geometry) as { coordinates: Shape }).coordinates;
  const byName = new Map(assistantMoscowAreaShapes.map((area) => [area.name, area]));
  const required = (name: string) => {
    const area = byName.get(name);
    if (!area) throw new Error(`ASSISTANT_AREA_MISSING: ${name}`);
    return parse(area.geometry);
  };
  shapes = {
    city: parse(assistantMoscowAreaShapes.find((area) => area.kind === 'city')!.geometry),
    rings: { 'Садовое кольцо': required('Садовое кольцо'), ТТК: required('ТТК'), МКАД: required('МКАД') },
    okrugs: new Map(okrugs.map((okrug) => [okrug.short, required(okrug.name)])),
    districts: new Map(assistantMoscowAreaShapes
      .filter((area) => area.kind === 'district')
      .map((area) => [districtKey(area.name), { name: area.name, shape: parse(area.geometry) }])),
  };
  return shapes;
}

type ZoneTest = (inside: (shape: Shape) => boolean, all: Shapes) => boolean;

const zones: Array<{ label: string; aliases: string[]; test: ZoneTest }> = [
  {
    label: 'внутри Садового кольца',
    aliases: ['внутри садового кольца', 'внутри садового', 'в пределах садового кольца', 'в пределах садового', 'садовое кольцо', 'садовое', 'в садовом кольце'],
    test: (inside, all) => inside(all.rings['Садовое кольцо']),
  },
  {
    label: 'между Садовым кольцом и ТТК',
    aliases: ['между садовым и ттк', 'между садовым кольцом и ттк', 'между садовым кольцом и третьим транспортным кольцом', 'от садового до ттк', 'от садового кольца до ттк'],
    test: (inside, all) => inside(all.rings.ТТК) && !inside(all.rings['Садовое кольцо']),
  },
  {
    label: 'внутри ТТК',
    aliases: ['внутри ттк', 'в пределах ттк', 'ттк', 'внутри третьего транспортного кольца', 'в пределах третьего транспортного кольца', 'третье транспортное кольцо'],
    test: (inside, all) => inside(all.rings.ТТК),
  },
  {
    label: 'между ТТК и МКАД',
    aliases: ['за ттк', 'между ттк и мкад', 'от ттк до мкад', 'за третьим транспортным кольцом'],
    test: (inside, all) => inside(all.rings.МКАД) && !inside(all.rings.ТТК),
  },
  {
    label: 'внутри МКАД',
    aliases: ['внутри мкад', 'в пределах мкад', 'мкад'],
    test: (inside, all) => inside(all.rings.МКАД),
  },
  {
    label: 'за МКАД',
    aliases: ['за мкад', 'за пределами мкад'],
    test: (inside, all) => !inside(all.rings.МКАД),
  },
  {
    label: 'Москва',
    aliases: ['москва', 'в москве', 'в пределах москвы', 'город москва'],
    test: (inside, all) => inside(all.city),
  },
  {
    label: 'Новая Москва',
    aliases: ['новая москва', 'тинао', 'нао и тао', 'нао тао'],
    test: (inside, all) => inside(all.okrugs.get('НАО')!) || inside(all.okrugs.get('ТАО')!),
  },
  {
    label: 'Подмосковье',
    aliases: ['подмосковье', 'московская область', 'область', 'мо', 'за пределами москвы'],
    test: (inside, all) => !inside(all.city),
  },
];

const zoneByAlias = new Map(zones.flatMap((zone) => zone.aliases.map((alias) => [alias, zone] as const)));
const okrugByAlias = new Map(okrugs.flatMap((okrug) => [
  normalizeAreaName(okrug.short),
  normalizeAreaName(okrug.name),
  normalizeAreaName(okrug.name.replace(' административный', '')),
  ...okrug.aliases,
].map((alias) => [alias, okrug] as const)));

/**
 * A zone, okrug or Moscow district by name, or null when the name is none of them (then it is
 * a location tag of the cards, like «У воды»). A word shared by several districts («Бутово»,
 * «Измайлово») means all of them.
 */
export function resolveAssistantArea(value: string): AssistantAreaMatcher | null {
  const name = normalizeAreaName(value);
  if (!name) return null;
  const all = loadShapes();

  const zone = zoneByAlias.get(name);
  if (zone) return { label: zone.label, contains: (longitude, latitude) => zone.test((shape) => shapeContains(shape, longitude, latitude), all) };

  const okrug = okrugByAlias.get(name);
  if (okrug) {
    const shape = all.okrugs.get(okrug.short)!;
    return { label: okrug.short, contains: (longitude, latitude) => shapeContains(shape, longitude, latitude) };
  }

  const districts = findDistricts(districtKey(districtAliases[name] ?? name), all);
  if (districts.length === 0) return null;
  return {
    label: districts.map((district) => district.name).join(', '),
    contains: (longitude, latitude) => districts.some((district) => shapeContains(district.shape, longitude, latitude)),
  };
}

/** Zone, okrug and district of a point, e.g. ['внутри Садового кольца', 'ЦАО', 'район Хамовники']. */
export function describeAssistantLocation(latitude: number | null, longitude: number | null): string[] {
  if (latitude === null || longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  const all = loadShapes();
  const inside = (shape: Shape) => shapeContains(shape, longitude, latitude);
  const zone = inside(all.rings['Садовое кольцо'])
    ? 'внутри Садового кольца'
    : inside(all.rings.ТТК)
      ? 'между Садовым кольцом и ТТК (внутри ТТК)'
      : inside(all.rings.МКАД)
        ? 'между ТТК и МКАД'
        : inside(all.city) ? 'Москва за МКАД' : 'за пределами Москвы';
  const okrug = [...all.okrugs].find(([, shape]) => inside(shape))?.[0];
  const district = [...all.districts.values()].find((item) => inside(item.shape))?.name;
  return [zone, okrug, district].filter((part): part is string => Boolean(part));
}

function findDistricts(key: string, all: Shapes) {
  const exact = all.districts.get(key);
  if (exact) return [exact];
  if (key.length < 4) return [];
  // «Бутово» → Северное и Южное Бутово.
  const byWord = [...all.districts].filter(([name]) => ` ${name} `.includes(` ${key} `)).map(([, district]) => district);
  if (byWord.length) return byWord;
  // Inflected forms: «в Хамовниках», «Пресненском».
  for (const stem of [key, key.length >= 7 ? key.slice(0, -2) : null]) {
    if (!stem || stem.length < 5) continue;
    const matches = [...all.districts].filter(([name]) => name.startsWith(stem)).map(([, district]) => district);
    if (matches.length === 1) return matches;
  }
  return [];
}

function districtKey(name: string) {
  return normalizeAreaName(name)
    .replace(/^(?:в|во|на)\s+/u, '')
    .replace(/(?:^|\s)(?:район|р н)(?=\s|$)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeAreaName(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function shapeContains(shape: Shape, longitude: number, latitude: number) {
  return shape.some(([outer, ...holes]) => (
    ringContains(outer!, longitude, latitude) && !holes.some((hole) => ringContains(hole, longitude, latitude))
  ));
}

// Ray casting; at city scale the outlines are fine as flat longitude/latitude polygons.
function ringContains(ring: Position[], x: number, y: number) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [xi, yi] = ring[index]!;
    const [xj, yj] = ring[previous]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
