// Matching a user's project reference («ЖК Слава», «Nicole», «Set») against catalog objects.
// Titles are often Cyrillic while brands are Latin (or the other way round); catalog slugs are
// Latin transliterations produced by ObjectsService.slugify, so a transliterated reference is
// compared against the slug as a second identity of the same object.

const objectPrefixPattern = /^(?:жк|жилой\s+комплекс|бц|бизнес[- ]центр|мфк)\s+/u;
const slugPrefixPattern = /^(?:zhk|zhiloj kompleks|zhiloy kompleks|bc|biznes tsentr|mfk)\s+/u;

// Mirrors the character map of ObjectsService.slugify so references land on the same letters.
const slugTransliteration: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function normalizeObjectIdentity(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е')
    .replace(objectPrefixPattern, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function createObjectSlugReference(value: string) {
  return [...normalizeObjectIdentity(value)]
    .map((character) => slugTransliteration[character] ?? character)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .replace(slugPrefixPattern, '');
}

export function normalizeObjectSlug(slug: string | null | undefined) {
  return (slug ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .replace(slugPrefixPattern, '');
}

export function objectSlugEqualsReference(slug: string | null | undefined, reference: string) {
  const expected = createObjectSlugReference(reference);
  return expected.length >= 3 && normalizeObjectSlug(slug) === expected;
}

export function objectSlugContainsReference(slug: string | null | undefined, reference: string) {
  const expected = createObjectSlugReference(reference);
  return expected.length >= 3 && ` ${normalizeObjectSlug(slug)} `.includes(` ${expected} `);
}
