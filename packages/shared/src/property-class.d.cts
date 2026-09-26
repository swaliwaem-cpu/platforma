export type PropertyClass = 'Комфорт-класс' | 'Бизнес-класс' | 'Премиум-класс' | 'Делюкс';
export const PROPERTY_CLASSES: readonly PropertyClass[];
export function normalizePropertyClass(value: unknown): PropertyClass | null;
