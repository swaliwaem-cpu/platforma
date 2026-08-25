type MetroLineDirectoryEntry = {
  name: string;
  lineName: string | null;
  lineColor: string | null;
};

type MetroLineMarkerEntry = {
  color: string;
  lineName: string;
};

export type MetroLineLookup = ReadonlyMap<string, readonly MetroLineMarkerEntry[]>;

export type MetroLineMarker = {
  background: string | null;
  label: string | null;
};

export function normalizeMetroStationName(value: string) {
  return value
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function buildMetroLineLookup(stations: readonly MetroLineDirectoryEntry[]): MetroLineLookup {
  const entriesByStation = new Map<string, Map<string, MetroLineMarkerEntry>>();

  for (const station of stations) {
    const stationKey = normalizeMetroStationName(station.name);
    const lineName = station.lineName?.trim();
    const color = normalizeMetroLineColor(station.lineColor);

    if (!stationKey || !lineName || !color) {
      continue;
    }

    const entriesByLine = entriesByStation.get(stationKey) ?? new Map<string, MetroLineMarkerEntry>();
    entriesByLine.set(normalizeMetroStationName(lineName), { color, lineName });
    entriesByStation.set(stationKey, entriesByLine);
  }

  return new Map(
    [...entriesByStation].map(([stationKey, entriesByLine]) => [
      stationKey,
      [...entriesByLine.values()].sort((left, right) => left.lineName.localeCompare(right.lineName, 'ru-RU')),
    ]),
  );
}

export function resolveMetroLineMarker(stationName: string, lookup: MetroLineLookup): MetroLineMarker {
  const entries = lookup.get(normalizeMetroStationName(stationName)) ?? [];
  const colors = [...new Set(entries.map((entry) => entry.color))];
  const firstColor = colors[0];

  if (!firstColor) {
    return { background: null, label: null };
  }

  const label = [...new Set(entries.map((entry) => entry.lineName))].join(', ');

  if (colors.length === 1) {
    return { background: firstColor, label };
  }

  const sectorSize = 100 / colors.length;
  const sectors = colors.map((color, index) => {
    const start = formatPercentage(index * sectorSize);
    const end = formatPercentage((index + 1) * sectorSize);

    return `${color} ${start}% ${end}%`;
  });

  return {
    background: `conic-gradient(${sectors.join(', ')})`,
    label,
  };
}

function normalizeMetroLineColor(value: string | null) {
  const normalized = value?.trim().toUpperCase();

  return normalized && /^#[0-9A-F]{6}$/u.test(normalized) ? normalized : null;
}

function formatPercentage(value: number) {
  return Number(value.toFixed(4)).toString();
}
