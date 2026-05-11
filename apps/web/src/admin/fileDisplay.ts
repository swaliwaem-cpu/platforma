import type { ObjectFileType } from '@platforma/shared';

type LinkedFileDisplaySource = {
  title?: string | null;
  type: ObjectFileType;
  file: {
    originalName?: string | null;
  };
};

type FileTypeLabels = Record<ObjectFileType, string>;

const missingOriginalNameLabel = 'Имя файла не указано';
const mojibakeMarkerPattern = /[ÐÑÃÂ]/u;
const cyrillicPattern = /[\u0400-\u04ff]/gu;
const c1ControlPattern = /[\u0080-\u009f]/gu;

function matchCount(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function textQualityScore(value: string): number {
  return (
    matchCount(value, cyrillicPattern) * 4 -
    matchCount(value, mojibakeMarkerPattern) * 3 -
    matchCount(value, c1ControlPattern) * 5 -
    matchCount(value, /\uFFFD/gu) * 8
  );
}

export function decodeMojibakeText(value: string): string {
  if (!mojibakeMarkerPattern.test(value)) {
    return value;
  }

  const codeUnits = Array.from(value, (char) => char.charCodeAt(0));

  if (codeUnits.some((codeUnit) => codeUnit > 0xff)) {
    return value;
  }

  try {
    const bytes = Uint8Array.from(codeUnits);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

    return textQualityScore(decoded) > textQualityScore(value) ? decoded : value;
  } catch {
    return value;
  }
}

export function getLinkedFileTitle(file: LinkedFileDisplaySource, labels: FileTypeLabels): string {
  return decodeMojibakeText(file.title || file.file.originalName || labels[file.type]);
}

export function getLinkedFileOriginalName(file: Pick<LinkedFileDisplaySource, 'file'>): string {
  return file.file.originalName ? decodeMojibakeText(file.file.originalName) : missingOriginalNameLabel;
}
