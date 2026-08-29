export function extractAssistantDistrictFromText(text: string, requireInPrefix = false) {
  const prefix = requireInPrefix ? '(?:^|[\\s,;])в\\s+' : '(?:в\\s+)?';
  const match = text.match(new RegExp(
    `${prefix}район(?:е)?\\s+[«"]?(.+?)[»"]?(?=\\s+(?:и\\s+)?(?:рядом\\s+с|возле|около|вокруг|у\\s+метро|метро|от\\s+[\\p{L}«"]|сдач\\p{L}*|\\d+\\s*квартал|площад\\p{L}*|этаж\\p{L}*|готов\\p{L}*|в\\s+готов\\p{L}*|класс\\p{L}*|до\\s+\\d|не\\s+(?:дороже|дешевле|позднее|раньше|меньше|больше))|[,.!?;\\r\\n]|$)`,
    'iu',
  ))?.[1]?.trim().replace(/^[«"]|[»"]$/gu, '');
  return match && match.length <= 160 ? match : null;
}
