import { createSearchVariants } from '@platforma/shared/search-normalization';

type SearchContainsFilter<Field extends string> = Record<
  Field,
  {
    contains: string;
    mode: 'insensitive';
  }
>;

export function createSearchContainsFilters<Field extends string>(
  search: string,
  fields: readonly Field[],
): Array<SearchContainsFilter<Field>> {
  return createSearchVariants(search).flatMap((variant) =>
    fields.map((field) => ({
      [field]: {
        contains: variant,
        mode: 'insensitive' as const,
      },
    }) as SearchContainsFilter<Field>),
  );
}
