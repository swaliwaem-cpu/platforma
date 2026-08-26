const radiusClausePattern = /(?:в\s+радиусе|радиус(?:ом)?|не\s+дальше)\s*\d+(?:[.,]\d+)?\s*(?:км|километр(?:а|ов)?|м|метр(?:а|ов)?)\s+от\s+/iu;
const numericValuePattern = String.raw`\d[\d\s]*(?:[.,]\d+)?`;
const moneyUnitPattern = String.raw`(?:млн\p{L}*|миллион(?:а|ов)?|тыс\p{L}*|тысяч(?:а|и)?|руб\p{L}*|рубл(?:ь|я|ей)|₽)`;
const hardFilterClausePattern = [
  String.raw`(?:от\s+)?застройщик(?:а|ом)?`,
  String.raw`в\s+район(?:е)?`,
  String.raw`у\s+метро`,
  String.raw`(?<!станции\s)(?<!станция\s)(?<!ст\.\s)метро\s+`,
  String.raw`(?:сдач|готов)\p{L}*`,
  String.raw`(?:сдач\p{L}*\s+)?(?:до|не\s+позднее|от|не\s+раньше)\s+20\d{2}(?:\s+года?)?`,
  String.raw`[1-4]\s*(?:кв\.?|квартал)`,
  String.raw`(?:бюджет\s*)?(?:от\s*)?${numericValuePattern}\s*(?:${moneyUnitPattern})?\s*(?:до|-|–|—)\s*${numericValuePattern}\s*${moneyUnitPattern}`,
  String.raw`(?:бюджет\s*)?(?:от|не\s+дешевле|минимум|до|не\s+дороже|максимум)\s*${numericValuePattern}\s*${moneyUnitPattern}`,
  String.raw`(?:площад\p{L}*\s+)?${numericValuePattern}\s*(?:-|–|—|до)\s*${numericValuePattern}\s*(?:м2|м²|кв)`,
  String.raw`(?:площад\p{L}*\s+)?(?:от|до|не\s+меньше|не\s+больше)\s+${numericValuePattern}\s*(?:м2|м²|кв)`,
  String.raw`(?:этаж\p{L}*\s+(?:от|до|не\s+ниже|не\s+выше)\s+-?\d|(?:от|до|не\s+ниже|не\s+выше)\s+-?\d+\s*этаж\p{L}*)`,
  String.raw`(?:класс(?:а)?\s+)?(?:комфорт|бизнес|премиум|элит)\s*[- ]?класс\p{L}*`,
  String.raw`\d{1,2}\s*[- ]?\s*комн\p{L}*`,
  String.raw`студи\p{L}*|однуш\p{L}*|однокомнат\p{L}*|двуш\p{L}*|двухкомнат\p{L}*|треш\p{L}*|трехкомнат\p{L}*`,
  String.raw`коммерчес\p{L}*|жил\p{L}*\s+(?:квартир\p{L}*|объект\p{L}*)|квартир\p{L}*|апартамент\p{L}*`,
].join('|');
const trailingClausePattern = new RegExp(
  String.raw`(?=\s+(?:${hardFilterClausePattern}))|,\s*(?=(?:гео)?сценарий|вариант|запрос|проверка|найди|покажи|подбери)|\.(?=\s+(?:найди|покажи|подбери))|[!?;\r\n]`,
  'iu',
);

export type AssistantGeoDistanceClause = {
  start: number;
  end: number;
  anchor: string;
};

export function parseAssistantGeoDistanceClause(value: string): AssistantGeoDistanceClause | null {
  const radius = radiusClausePattern.exec(value);
  if (!radius || radius.index === undefined) return null;
  const anchorStart = radius.index + radius[0].length;
  const remainder = value.slice(anchorStart);
  const terminator = remainder.search(trailingClausePattern);
  const anchorLength = terminator >= 0 ? terminator : remainder.length;
  const anchor = remainder.slice(0, anchorLength).trim();
  if (!anchor) return null;
  return {
    start: radius.index,
    end: anchorStart + anchorLength,
    anchor,
  };
}

export function stripAssistantGeoDistanceClause(value: string) {
  let result = value;
  for (;;) {
    const clause = parseAssistantGeoDistanceClause(result);
    if (!clause) return result;
    result = `${result.slice(0, clause.start)}${result.slice(clause.end)}`;
  }
}
