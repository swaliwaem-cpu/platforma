// «в Хамовниках», «в Марьине», «в Некрасовке»: a capitalised toponym right after «в» in the
// locative case. The canonical nominative name is resolved later against the locations table.
const locativeDistrictPattern = /(?:^|[\s,;(])в\s+(?<district>\p{Lu}[\p{L}-]{2,}(?:ах|ях|ине|ове|еве|ёве|ке))(?=[\s,.!?;)]|$)/u;

export function extractAssistantDistrictFromText(text: string, requireInPrefix = false) {
  const prefix = requireInPrefix ? '(?:^|[\\s,;])в\\s+' : '(?:в\\s+)?';
  const match = text.match(new RegExp(
    `${prefix}район(?:е)?\\s+[«"]?(.+?)[»"]?(?=\\s+(?:и\\s+)?(?:рядом\\s+с|возле|около|вокруг|у\\s+метро|метро|от\\s+[\\p{L}«"]|сдач\\p{L}*|\\d+\\s*квартал|площад\\p{L}*|этаж\\p{L}*|готов\\p{L}*|в\\s+готов\\p{L}*|класс\\p{L}*|до\\s+\\d|не\\s+(?:дороже|дешевле|позднее|раньше|меньше|больше))|[,.!?;\\r\\n]|$)`,
    'iu',
  ))?.[1]?.trim().replace(/^[«"]|[»"]$/gu, '');
  if (match && match.length <= 160) return match;
  const locative = text.match(locativeDistrictPattern)?.groups?.district;
  return locative && locative.length <= 160 ? locative : null;
}
