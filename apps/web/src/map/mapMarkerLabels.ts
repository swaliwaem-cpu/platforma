type MapMarkerLabelSource = {
  title: string;
  mapName?: string | null;
};

const maxMapNameLength = 16;
const fallbackLabelLength = 6;
const leadingObjectTypePattern =
  /^(?:ж\.?\s*к\.?|жилой\s+комплекс|клубный\s+дом|клубная\s+резиденция|апарт-комплекс|апартаменты|квартал|резиденция|дом)(?:\s+|$)/iu;

export function resolveMapMarkerLabel(source: MapMarkerLabelSource) {
  const mapName = normalizeMarkerLabelText(source.mapName ?? '');

  if (mapName) {
    return takeVisibleCharacters(mapName, maxMapNameLength);
  }

  const title = normalizeMarkerLabelText(source.title);
  const cleanTitle = removeLeadingObjectTypes(title);

  return takeVisibleCharacters(cleanTitle || title, fallbackLabelLength);
}

function removeLeadingObjectTypes(value: string) {
  let result = value;

  for (let index = 0; index < 6; index += 1) {
    const nextResult = normalizeMarkerLabelText(result.replace(leadingObjectTypePattern, ''));

    if (nextResult === result) {
      return result;
    }

    result = nextResult;
  }

  return result;
}

function normalizeMarkerLabelText(value: string) {
  return value
    .replace(/[«»"“”„'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function takeVisibleCharacters(value: string, length: number) {
  return Array.from(value).slice(0, length).join('').trim();
}
