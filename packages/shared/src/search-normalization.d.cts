export function normalizeSearchText(value: string): string;
export function createSearchVariants(value: string): string[];
export function matchesSearchVariants(query: string, values: Array<string | null | undefined>): boolean;
