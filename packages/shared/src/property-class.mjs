// Classes of residential projects. Keep in sync with property-class.cjs.
export const PROPERTY_CLASSES = ['Комфорт-класс', 'Бизнес-класс', 'Премиум-класс', 'Делюкс'];

const propertyClassStems = [
  ['Комфорт-класс', ['комфорт', 'comfort']],
  ['Бизнес-класс', ['бизнес', 'business']],
  ['Премиум-класс', ['премиум', 'premium']],
  ['Делюкс', ['делюкс', 'делакс', 'deluxe', 'элит', 'elit', 'люкс', 'lux']],
];

/** Canonical class for a class name or a broker synonym («элитка», «de luxe», «премиум»), or null. */
export function normalizePropertyClass(value) {
  if (typeof value !== 'string') return null;
  const key = value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е')
    .replace(/класс[а-я]*/gu, ' ')
    .replace(/[^a-zа-я]+/gu, '');
  if (!key) return null;
  const match = propertyClassStems.find(([, stems]) => stems.some((stem) => key.startsWith(stem)));
  return match ? match[0] : null;
}
