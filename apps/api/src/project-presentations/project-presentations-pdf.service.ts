import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';

import { FilesService } from '../files/files.service';
import {
  PROJECT_PRESENTATION_PAGE_HEIGHT,
  PROJECT_PRESENTATION_PAGE_WIDTH,
  ProjectPresentationSnapshotImage,
  ProjectPresentationSnapshotObject,
  ProjectPresentationSnapshotV1,
} from './project-presentations.types';

const colors = {
  paper: '#F2EEE6',
  paperLight: '#FAF8F3',
  ink: '#1D1B18',
  muted: '#777066',
  accent: '#356B58',
  dark: '#173E32',
  line: '#CFC6B8',
  white: '#FFFFFF',
};
const regularFontPath = resolveAsset('fonts/NotoSans-Regular.ttf');
const boldFontPath = resolveAsset('fonts/NotoSans-Bold.ttf');
const qrPath = resolveAsset('project-presentations/telegram-qr.png');

function resolveAsset(relativePath: string) {
  const candidates = [
    join(__dirname, '..', '..', 'assets', relativePath),
    join(process.cwd(), 'assets', relativePath),
    join(process.cwd(), 'apps', 'api', 'assets', relativePath),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`Project presentation asset is missing: ${relativePath}`);
  return path;
}

@Injectable()
export class ProjectPresentationsPdfService {
  private readonly imageCache = new Map<string, Promise<Buffer | null>>();

  constructor(private readonly filesService: FilesService) {}

  async generate(snapshot: ProjectPresentationSnapshotV1, onProgress?: (progress: number) => Promise<void>) {
    this.imageCache.clear();
    const doc = new PDFDocument({
      size: [PROJECT_PRESENTATION_PAGE_WIDTH, PROJECT_PRESENTATION_PAGE_HEIGHT],
      margin: 0,
      autoFirstPage: false,
      bufferPages: false,
      info: { Title: snapshot.title, Creator: 'Platforma', Author: snapshot.broker.name },
    });
    doc.registerFont('NotoSans', regularFontPath);
    doc.registerFont('NotoSansBold', boldFontPath);
    const chunks: Buffer[] = [];
    const completed = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    try {
    const totalPages = snapshot.objects.length + 4;
    let page = 0;
    const nextPage = async (tone: 'paper' | 'light' | 'dark' = 'paper') => {
      doc.addPage({ size: [PROJECT_PRESENTATION_PAGE_WIDTH, PROJECT_PRESENTATION_PAGE_HEIGHT], margin: 0 });
      page += 1;
      doc.rect(0, 0, PROJECT_PRESENTATION_PAGE_WIDTH, PROJECT_PRESENTATION_PAGE_HEIGHT)
        .fill(tone === 'dark' ? colors.dark : tone === 'light' ? colors.paperLight : colors.paper);
      await onProgress?.(Math.round(((page - 1) / totalPages) * 100));
    };

    await nextPage('dark');
    await this.drawCover(doc, snapshot);
    this.drawPageNumber(doc, page, totalPages, true);

    await nextPage('paper');
    this.drawContents(doc, snapshot.objects);
    this.drawPageNumber(doc, page, totalPages);

    for (const object of snapshot.objects) {
      await nextPage('light');
      await this.drawProject(doc, object);
      this.drawPageNumber(doc, page, totalPages);
    }

    await nextPage('dark');
    await this.drawTelegram(doc, snapshot);
    this.drawPageNumber(doc, page, totalPages, true);

    await nextPage('light');
    await this.drawFinal(doc, snapshot);
    this.drawPageNumber(doc, page, totalPages);
    await onProgress?.(99);
    doc.end();
    return await completed;
    } finally {
      this.imageCache.clear();
    }
  }

  private async drawCover(doc: PDFKit.PDFDocument, snapshot: ProjectPresentationSnapshotV1) {
    const image = snapshot.cover.image ? await this.loadImage(snapshot.cover.image) : null;
    if (image) {
      doc.image(image, 0, 0, { cover: [PROJECT_PRESENTATION_PAGE_WIDTH, PROJECT_PRESENTATION_PAGE_HEIGHT], align: 'center', valign: 'center' });
      doc.save().fillOpacity(0.58).rect(0, 0, PROJECT_PRESENTATION_PAGE_WIDTH, PROJECT_PRESENTATION_PAGE_HEIGHT).fill(colors.dark).restore();
    }
    doc.fillColor(colors.white).font('NotoSans').fontSize(9).text(snapshot.cover.issueLabel.toUpperCase() || 'ПЕРСОНАЛЬНАЯ ПОДБОРКА', 42, 48, { width: 456, characterSpacing: 1.3 });
    doc.moveTo(42, 74).lineTo(498, 74).strokeColor('#C7B7A8').lineWidth(0.7).stroke();
    doc.font('NotoSansBold').fontSize(34).text(snapshot.cover.title, 42, 166, { width: 456, height: 145, ellipsis: true, lineGap: 3 });
    if (snapshot.cover.subtitle) doc.font('NotoSans').fontSize(13).fillColor('#E7DFD5').text(snapshot.cover.subtitle, 42, 332, { width: 390, height: 80, ellipsis: true, lineGap: 4 });
    if (snapshot.cover.clientName) doc.font('NotoSans').fontSize(10).fillColor(colors.white).text(`Для ${snapshot.cover.clientName}`, 42, 578, { width: 456 });
    doc.font('NotoSansBold').fontSize(13).text('FluffyWhite', 42, 610);
  }

  private drawContents(doc: PDFKit.PDFDocument, objects: ProjectPresentationSnapshotObject[]) {
    this.drawKicker(doc, 'СОДЕРЖАНИЕ', 42, 45);
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(28).text('Выбранные проекты', 42, 80, { width: 456 });
    doc.font('NotoSans').fontSize(10).fillColor(colors.muted).text('Краткий каталог жилых комплексов в выбранном порядке', 42, 121, { width: 456 });
    const rowHeight = Math.min(42, 430 / Math.max(objects.length, 1));
    objects.forEach((object, index) => {
      const y = 169 + index * rowHeight;
      doc.moveTo(42, y + rowHeight - 8).lineTo(498, y + rowHeight - 8).strokeColor(colors.line).lineWidth(0.45).stroke();
      doc.fillColor(colors.accent).font('NotoSansBold').fontSize(9).text(String(index + 1).padStart(2, '0'), 42, y + 3, { width: 28 });
      doc.fillColor(colors.ink).font('NotoSansBold').fontSize(objects.length > 9 ? 9 : 10.5).text(object.title, 82, y, { width: 330, height: rowHeight - 9, ellipsis: true });
      doc.fillColor(colors.muted).font('NotoSans').fontSize(9).text(String(index + 3), 450, y + 3, { width: 48, align: 'right' });
    });
  }

  private async drawProject(doc: PDFKit.PDFDocument, object: ProjectPresentationSnapshotObject) {
    this.drawKicker(doc, 'FLUFFYWHITE · КАТАЛОГ ПРОЕКТОВ', 36, 27);
    doc.moveTo(36, 49).lineTo(504, 49).strokeColor(colors.line).lineWidth(0.5).stroke();
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(22).text(object.title, 36, 69, { width: 248, height: 58, ellipsis: true, lineGap: 1 });
    doc.fillColor(colors.muted).font('NotoSans').fontSize(7.5).text(object.description || 'Описание проекта будет дополнено.', 36, 132, { width: 248, height: 48, ellipsis: true, lineGap: 2 });
    const facts: Array<[string, string]> = [
      ['СТОИМОСТЬ', object.price],
      ['КЛАСС', object.propertyClass],
      ['СРОК СДАЧИ', object.completion],
      ['РАЙОН', object.district],
    ];
    facts.forEach(([label, value], index) => {
      const x = 315 + (index % 2) * 96;
      const y = 71 + Math.floor(index / 2) * 55;
      doc.fillColor(colors.muted).font('NotoSans').fontSize(5.8).text(label, x, y, { width: 88, characterSpacing: 0.5 });
      doc.fillColor(index === 0 ? colors.accent : colors.ink).font('NotoSansBold').fontSize(8.5).text(value, x, y + 15, { width: 88, height: 28, ellipsis: true });
    });
    const advantages = [...object.advantages.slice(0, 3)];
    while (advantages.length < 3) advantages.push(['Выверенная локация', 'Архитектура и комфорт', 'Персональные условия'][advantages.length] ?? 'Преимущество проекта');
    advantages.forEach((advantage, index) => {
      const x = 36 + index * 158;
      doc.roundedRect(x, 195, 146, 62, 7).fill('#E4EADF');
      doc.fillColor(colors.accent).font('NotoSansBold').fontSize(7).text(String(index + 1).padStart(2, '0'), x + 12, 207, { width: 24 });
      doc.fillColor(colors.ink).font('NotoSansBold').fontSize(7.2).text(advantage, x + 12, 226, { width: 122, height: 24, ellipsis: true });
    });
    const loadedImages = (await Promise.all(object.images.slice(0, 3).map((image) => this.loadImage(image)))).filter((image): image is Buffer => Boolean(image));
    this.drawProjectCollage(doc, loadedImages, 36, 279, 468, 226);
    doc.fillColor(colors.muted).font('NotoSans').fontSize(6.7).text([object.developer, object.metro].filter(Boolean).join(' · '), 36, 520, { width: 468, height: 18, ellipsis: true });
    doc.roundedRect(36, 555, 468, 52, 26).fill(colors.dark);
    doc.fillColor(colors.white).font('NotoSansBold').fontSize(9.5).text('Обсудить проект в Telegram', 36, 574, { width: 468, align: 'center', link: 'https://t.me/FluffyWhite' });
    doc.link(36, 555, 468, 52, 'https://t.me/FluffyWhite');
  }

  private drawProjectCollage(doc: PDFKit.PDFDocument, images: Buffer[], x: number, y: number, width: number, height: number) {
    if (images.length === 0) {
      doc.roundedRect(x, y, width, height, 8).fill(colors.dark);
      doc.fillColor('#D9E4DC').font('NotoSansBold').fontSize(15).text('FluffyWhite', x, y + height / 2 - 10, { width, align: 'center' });
      return;
    }
    if (images.length === 1) {
      this.drawClippedImage(doc, images[0]!, x, y, width, height, 8);
      return;
    }
    const leftWidth = images.length === 2 ? Math.round(width * 0.58) : Math.round(width * 0.65);
    this.drawClippedImage(doc, images[0]!, x, y, leftWidth - 5, height, 8);
    if (images.length === 2) {
      this.drawClippedImage(doc, images[1]!, x + leftWidth, y, width - leftWidth, height, 8);
      return;
    }
    this.drawClippedImage(doc, images[1]!, x + leftWidth, y, width - leftWidth, height / 2 - 4, 8);
    this.drawClippedImage(doc, images[2]!, x + leftWidth, y + height / 2 + 4, width - leftWidth, height / 2 - 4, 8);
  }

  private drawClippedImage(doc: PDFKit.PDFDocument, image: Buffer, x: number, y: number, width: number, height: number, radius: number) {
    doc.save().roundedRect(x, y, width, height, radius).clip();
    doc.image(image, x, y, { cover: [width, height], align: 'center', valign: 'center' });
    doc.restore();
  }

  private async drawTelegram(doc: PDFKit.PDFDocument, snapshot: ProjectPresentationSnapshotV1) {
    const { cta } = snapshot;
    doc.rect(0, 0, PROJECT_PRESENTATION_PAGE_WIDTH, PROJECT_PRESENTATION_PAGE_HEIGHT).fill(colors.dark);
    this.drawKicker(doc, 'FLUFFYWHITE · TELEGRAM', 42, 45, true);
    doc.fillColor(colors.white).font('NotoSansBold').fontSize(31).text('Недвижимость,\nкоторую выбирают\nдля жизни', 42, 88, { width: 340, lineGap: 1 });
    doc.fillColor('#D9E4DC').font('NotoSans').fontSize(10).text('Новые проекты, закрытые предложения и личный контакт с брокером.', 42, 236, { width: 280, lineGap: 4 });
    const qr = await readFile(qrPath);
    doc.roundedRect(362, 79, 136, 136, 9).fill(colors.white);
    doc.image(qr, 374, 91, { fit: [112, 112] });
    doc.link(362, 79, 136, 136, cta.url);
    doc.fillColor('#B8D0C2').font('NotoSansBold').fontSize(15).text(cta.label, 42, 307, { width: 220, link: cta.url });
    const photo = snapshot.cover.image ? await this.loadImage(snapshot.cover.image) : null;
    if (photo) {
      doc.image(photo, 0, 365, { cover: [PROJECT_PRESENTATION_PAGE_WIDTH, 310], align: 'center', valign: 'center' });
      doc.save().fillOpacity(0.28).rect(0, 365, PROJECT_PRESENTATION_PAGE_WIDTH, 310).fill(colors.dark).restore();
    } else {
      doc.rect(0, 365, PROJECT_PRESENTATION_PAGE_WIDTH, 310).fill('#245443');
    }
    doc.roundedRect(42, 568, 250, 48, 24).fill(colors.paperLight);
    doc.fillColor(colors.dark).font('NotoSansBold').fontSize(9).text('Открыть Telegram', 42, 586, { width: 250, align: 'center', link: cta.url });
    doc.link(42, 568, 250, 48, cta.url);
  }

  private async drawFinal(doc: PDFKit.PDFDocument, snapshot: ProjectPresentationSnapshotV1) {
    const photo = snapshot.broker.profilePhoto ? await this.loadImage(snapshot.broker.profilePhoto) : null;
    doc.rect(0, 0, PROJECT_PRESENTATION_PAGE_WIDTH, PROJECT_PRESENTATION_PAGE_HEIGHT).fill(colors.paperLight);
    this.drawKicker(doc, 'FLUFFYWHITE · ПЕРСОНАЛЬНЫЙ СЕРВИС', 42, 43);
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(30).text('Ваш следующий дом\nначинается с разговора', 42, 84, { width: 440, lineGap: 2 });
    doc.fillColor(colors.muted).font('NotoSans').fontSize(10).text('Мы уточним актуальность, сравним условия и организуем знакомство с проектами.', 42, 181, { width: 410, lineGap: 4 });
    doc.roundedRect(42, 254, 456, 196, 12).fill(colors.dark);
    if (photo) {
      doc.save().circle(116, 326, 43).clip();
      doc.image(photo, 73, 283, { cover: [86, 86], align: 'center', valign: 'center' });
      doc.restore();
    }
    doc.fillColor(colors.white).font('NotoSansBold').fontSize(16).text(snapshot.broker.name, 184, 285, { width: 280, height: 45, ellipsis: true });
    doc.fillColor('#D9E4DC').font('NotoSans').fontSize(9.5).text([snapshot.broker.phone, snapshot.broker.email].filter(Boolean).join('\n'), 184, 340, { width: 280, lineGap: 6 });
    doc.fillColor('#B8D0C2').font('NotoSansBold').fontSize(11).text(snapshot.cta.label, 184, 406, { width: 180, link: snapshot.cta.url });
    const services = [['01', 'Подбор'], ['02', 'Переговоры'], ['03', 'Сопровождение']];
    services.forEach(([number, label], index) => {
      const x = 42 + index * 158;
      doc.fillColor(colors.accent).font('NotoSansBold').fontSize(8).text(number!, x, 499);
      doc.fillColor(colors.ink).font('NotoSansBold').fontSize(9).text(label!, x, 520, { width: 140 });
      doc.fillColor(colors.muted).font('NotoSans').fontSize(6.8).text(['Точно под ваш запрос', 'Лучшие условия сделки', 'До получения ключей'][index]!, x, 541, { width: 140, height: 30 });
    });
    doc.fillColor(colors.dark).font('NotoSansBold').fontSize(13).text('fluffywhite.moscow', 42, 610);
  }

  private async loadImage(image: ProjectPresentationSnapshotImage) {
    if (!this.imageCache.has(image.fileId)) {
      this.imageCache.set(image.fileId, this.filesService.getContent(image.fileId, 'detail')
        .then(({ buffer }) => sharp(buffer).rotate().flatten({ background: colors.paperLight }).jpeg({ quality: 88, mozjpeg: true }).toBuffer())
        .catch(() => null));
    }
    return this.imageCache.get(image.fileId)!;
  }

  private drawKicker(doc: PDFKit.PDFDocument, text: string, x: number, y: number, inverse = false) {
    doc.fillColor(inverse ? '#D9D0C5' : colors.accent).font('NotoSansBold').fontSize(7.5).text(text, x, y, { width: 300, characterSpacing: 1.4 });
  }

  private drawImageFallback(doc: PDFKit.PDFDocument, x: number, y: number, width: number, height: number, label: string) {
    doc.rect(x, y, width, height).fill('#D8D0C5');
    doc.fillColor(colors.muted).font('NotoSans').fontSize(10).text(label, x, y + height / 2 - 6, { width, align: 'center' });
  }

  private drawPageNumber(doc: PDFKit.PDFDocument, current: number, total: number, inverse = false) {
    doc.fillColor(inverse ? '#BEB4A9' : colors.muted).font('NotoSans').fontSize(6.5).text(`${current} / ${total}`, 450, 642, { width: 48, align: 'right' });
  }
}
