import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeMojibakeText,
  getLinkedFileOriginalName,
  getLinkedFileTitle,
} from '../src/files/fileDisplay.ts';

const fileTypeLabels = {
  PRESENTATION: 'Презентация',
  FLOOR_PLAN: 'Планировка',
  DOCUMENT: 'Документ',
  OTHER: 'Другое',
};

function asLatin1Mojibake(value) {
  return Buffer.from(value, 'utf8').toString('latin1');
}

test('decodeMojibakeText restores UTF-8 names that were read as latin1', () => {
  const brokenName = `1234qw4e ${asLatin1Mojibake('Презентация объекта.pdf')}`;

  assert.equal(decodeMojibakeText(brokenName), '1234qw4e Презентация объекта.pdf');
  assert.equal(decodeMojibakeText('presentation.pdf'), 'presentation.pdf');
  assert.equal(decodeMojibakeText('Презентация.pdf'), 'Презентация.pdf');
});

test('linked file display helpers decode titles and original names for admin UI', () => {
  const brokenName = `1234qw4e ${asLatin1Mojibake('Презентация объекта.pdf')}`;
  const linkedFile = {
    title: null,
    type: 'PRESENTATION',
    file: {
      originalName: brokenName,
    },
  };

  assert.equal(getLinkedFileTitle(linkedFile, fileTypeLabels), '1234qw4e Презентация объекта.pdf');
  assert.equal(getLinkedFileOriginalName(linkedFile), '1234qw4e Презентация объекта.pdf');
  assert.equal(getLinkedFileOriginalName({ file: { originalName: null } }), 'Имя файла не указано');
});
