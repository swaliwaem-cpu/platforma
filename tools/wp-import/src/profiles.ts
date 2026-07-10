import { RealEstateObjectType } from '@prisma/client';

export type WordPressImportProfileName = 'residential' | 'commercial';

export type WordPressImportProfile = {
  name: WordPressImportProfileName;
  postType: string;
  taxonomies: readonly string[];
  sourcePathPrefix: string;
  objectType: RealEstateObjectType;
  importFiles: boolean;
};

export const residentialWordPressImportProfile = {
  name: 'residential',
  postType: 'nedvizhimosts',
  taxonomies: ['nedvizhimost', 'custom_tag-two'],
  sourcePathPrefix: '',
  objectType: RealEstateObjectType.RESIDENTIAL,
  importFiles: true,
} satisfies WordPressImportProfile;

export const commercialWordPressImportProfile = {
  name: 'commercial',
  postType: 'commercials',
  taxonomies: ['commercial', 'custom_tag-three'],
  sourcePathPrefix: 'commercial',
  objectType: RealEstateObjectType.COMMERCIAL,
  importFiles: false,
} satisfies WordPressImportProfile;

const wordPressImportProfiles = new Map<WordPressImportProfileName, WordPressImportProfile>([
  [residentialWordPressImportProfile.name, residentialWordPressImportProfile],
  [commercialWordPressImportProfile.name, commercialWordPressImportProfile],
]);

export function getWordPressImportProfile(value: string | null | undefined) {
  const profileName = normalizeProfileName(value);
  const profile = wordPressImportProfiles.get(profileName);

  if (!profile) {
    throw new Error(
      `WP_IMPORT_PROFILE must be one of: ${[...wordPressImportProfiles.keys()].join(', ')}`,
    );
  }

  return profile;
}

function normalizeProfileName(value: string | null | undefined): WordPressImportProfileName {
  const normalizedValue = (value ?? '').trim().toLowerCase();

  if (!normalizedValue) {
    return 'residential';
  }

  if (normalizedValue === 'residential' || normalizedValue === 'commercial') {
    return normalizedValue;
  }

  return normalizedValue as WordPressImportProfileName;
}
