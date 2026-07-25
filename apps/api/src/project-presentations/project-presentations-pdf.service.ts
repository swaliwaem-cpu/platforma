import { existsSync, readFileSync } from 'node:fs';
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
  ivory: '#F5F0E9',
  ivoryLight: '#FBF8F3',
  ink: '#151310',
  muted: '#766F65',
  gold: '#C99322',
  goldLine: '#D8BF8B',
  line: '#D8CEC0',
  soft: '#ECE5DB',
  white: '#FFFFFF',
};

const regularFontPath = resolveAsset('fonts/NotoSans-Regular.ttf');
const boldFontPath = resolveAsset('fonts/NotoSans-Bold.ttf');
const displayFontPath = resolveAsset('fonts/NotoSerifDisplay-Regular.ttf');
const logoPath = resolveAsset('project-presentations/fluffywhite-logo-gold.png');
const logo = readFileSync(logoPath);

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
      info: { Title: snapshot.title, Creator: 'Platforma', Author: 'FluffyWhite' },
    });
    doc.registerFont('NotoSans', regularFontPath);
    doc.registerFont('NotoSansBold', boldFontPath);
    doc.registerFont('NotoSerifDisplay', displayFontPath);

    const chunks: Buffer[] = [];
    const completed = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    try {
      const totalPages = snapshot.objects.length + 4;
      let page = 0;
      const nextPage = async () => {
        doc.addPage({ size: [PROJECT_PRESENTATION_PAGE_WIDTH, PROJECT_PRESENTATION_PAGE_HEIGHT], margin: 0 });
        page += 1;
        doc.rect(0, 0, PROJECT_PRESENTATION_PAGE_WIDTH, PROJECT_PRESENTATION_PAGE_HEIGHT).fill(colors.ivoryLight);
        await onProgress?.(Math.round(((page - 1) / totalPages) * 100));
      };

      await nextPage();
      await this.drawCover(doc, snapshot);
      this.drawPageNumber(doc, page, totalPages, 'ВАРИАНТ A · ОБЛОЖКА');

      await nextPage();
      this.drawEditorialMap(doc, snapshot);
      this.drawPageNumber(doc, page, totalPages, 'ВАРИАНТ A · ГЕОГРАФИЯ ПОДБОРКИ');

      for (const object of snapshot.objects) {
        await nextPage();
        await this.drawProject(doc, snapshot, object);
        this.drawPageNumber(doc, page, totalPages, 'ВАРИАНТ A · КАРТОЧКА ЖК');
      }

      await nextPage();
      this.drawCompany(doc, snapshot);
      this.drawPageNumber(doc, page, totalPages, 'ВАРИАНТ A · О КОМПАНИИ');

      await nextPage();
      this.drawFinal(doc, snapshot);
      this.drawPageNumber(doc, page, totalPages, 'ВАРИАНТ A · ФИНАЛ');

      await onProgress?.(99);
      doc.end();
      return await completed;
    } finally {
      this.imageCache.clear();
    }
  }

  private async drawCover(doc: PDFKit.PDFDocument, snapshot: ProjectPresentationSnapshotV1) {
    this.drawHeader(doc, snapshot.cover.issueLabel);
    this.drawKicker(doc, 'КАТАЛОГ ПРОЕКТОВ МОСКВЫ', 42, 82, 456, 'center');

    const coverTitle = snapshot.cover.title || snapshot.title;
    doc
      .fillColor(colors.ink)
      .font('NotoSerifDisplay')
      .fontSize(this.titleFontSize(coverTitle, 48, 34))
      .text(coverTitle, 42, 112, { width: 456, height: 68, align: 'center', ellipsis: true, lineGap: -2 });

    const image = snapshot.cover.image ? await this.loadImage(snapshot.cover.image) : null;
    if (image) {
      this.drawClippedImage(doc, image, 78, 188, 384, 300, 0);
    } else {
      this.drawImageFallback(doc, 78, 188, 384, 300, 'ФОТО ОБЛОЖКИ');
    }

    doc
      .fillColor(colors.ink)
      .font('NotoSerifDisplay')
      .fontSize(this.titleFontSize(snapshot.cover.subtitle || 'ПРОЕКТЫ ДЛЯ ЖИЗНИ', 28, 21))
      .text(snapshot.cover.subtitle || 'ПРОЕКТЫ ДЛЯ ЖИЗНИ', 42, 507, {
        width: 456,
        height: 42,
        align: 'center',
        ellipsis: true,
      });

    const teasers = ['СТАРТЫ\nПРОДАЖ', 'ПРЕИМУЩЕСТВА', 'ЛОКАЦИИ\nИ ЦИФРЫ', 'УСЛОВИЯ\nПОКУПКИ'];
    teasers.forEach((label, index) => {
      const x = 42 + index * 114;
      if (index > 0) {
        doc.moveTo(x, 583).lineTo(x, 642).strokeColor(colors.goldLine).lineWidth(0.55).stroke();
      }
      this.drawStar(doc, x + 57, 573, 4.5);
      doc
        .fillColor(colors.ink)
        .font('NotoSansBold')
        .fontSize(7.4)
        .text(label, x + 7, 603, { width: 100, align: 'center', lineGap: 1 });
    });

    if (snapshot.cover.clientName) {
      doc
        .fillColor(colors.muted)
        .font('NotoSans')
        .fontSize(6.8)
        .text(`ПОДГОТОВЛЕНО ДЛЯ ${snapshot.cover.clientName.toUpperCase()}`, 42, 661, {
          width: 456,
          align: 'center',
          characterSpacing: 0.7,
        });
    }
  }

  private drawEditorialMap(doc: PDFKit.PDFDocument, snapshot: ProjectPresentationSnapshotV1) {
    this.drawHeader(doc, snapshot.cover.issueLabel);
    this.drawKicker(doc, 'ПОЧЕМУ ЭТИ ПРОЕКТЫ', 36, 86);
    doc
      .fillColor(colors.ink)
      .font('NotoSerifDisplay')
      .fontSize(39)
      .text('Москва, в которой\nхочется жить', 36, 106, { width: 468, height: 136, lineGap: -3 });
    doc
      .fillColor(colors.muted)
      .font('NotoSans')
      .fontSize(8.8)
      .text(
        'Мы собрали проекты, где архитектура, зелёные маршруты и ежедневная инфраструктура работают вместе. Карта показывает подборку как единый городской сценарий.',
        36,
        244,
        { width: 452, height: 53, lineGap: 4 },
      );

    const map = { x: 36, y: 315, width: 468, height: 269 };
    this.drawEditorialGrid(doc, map.x, map.y, map.width, map.height);
    const points = this.mapPoints(snapshot.objects, map.x + 30, map.y + 28, map.width - 60, map.height - 56);
    points.forEach((point, index) => {
      const radius = 7;
      doc.circle(point.x, point.y, radius).fill(colors.gold);
      doc
        .fillColor(colors.white)
        .font('NotoSansBold')
        .fontSize(5.5)
        .text(String(index + 1), point.x - radius, point.y - 2.5, { width: radius * 2, align: 'center' });

      if (index < 4) {
        const labelWidth = 118;
        const labelX = Math.min(Math.max(point.x + 11, map.x + 4), map.x + map.width - labelWidth - 4);
        const labelY = Math.min(Math.max(point.y - 10, map.y + 4), map.y + map.height - 24);
        doc.roundedRect(labelX, labelY, labelWidth, 21, 10.5).fill(colors.ink);
        doc
          .fillColor(colors.white)
          .font('NotoSansBold')
          .fontSize(6.1)
          .text(this.truncate(point.object.title, 25).toUpperCase(), labelX + 8, labelY + 7, {
            width: labelWidth - 16,
            height: 9,
            ellipsis: true,
          });
      }
    });

    const names = snapshot.objects.slice(0, 6);
    names.forEach((object, index) => {
      const x = 36 + (index % 2) * 234;
      const y = 610 + Math.floor(index / 2) * 19;
      doc
        .fillColor(colors.gold)
        .font('NotoSansBold')
        .fontSize(6.4)
        .text(String(index + 1).padStart(2, '0'), x, y, { width: 18 });
      doc
        .fillColor(colors.ink)
        .font('NotoSansBold')
        .fontSize(6.4)
        .text(this.truncate(object.title, 34).toUpperCase(), x + 23, y, { width: 200, height: 10, ellipsis: true });
    });
  }

  private async drawProject(
    doc: PDFKit.PDFDocument,
    snapshot: ProjectPresentationSnapshotV1,
    object: ProjectPresentationSnapshotObject,
  ) {
    this.drawHeader(doc, snapshot.cover.issueLabel);
    const projectTitleLength = object.title.replace(/\s+/gu, ' ').trim().length;
    const projectTitleSize = projectTitleLength > 44 ? 20 : projectTitleLength > 28 ? 24 : this.titleFontSize(object.title, 40, 26);
    doc
      .fillColor(colors.ink)
      .font('NotoSerifDisplay')
      .fontSize(projectTitleSize)
      .text(object.title.toUpperCase(), 36, 69, { width: 468, height: 72, align: 'center', lineGap: -2 });

    const loadedImages = (
      await Promise.all(object.images.slice(0, 3).map((image) => this.loadImage(image)))
    ).filter((image): image is Buffer => Boolean(image));

    if (loadedImages[0]) {
      this.drawClippedImage(doc, loadedImages[0], 36, 143, 468, 202, 0);
    } else {
      this.drawImageFallback(doc, 36, 143, 468, 202, 'ГЛАВНОЕ ФОТО ЖК');
    }

    const facts: Array<[string, string]> = [
      ['ЦЕНА ОТ', object.price],
      ['ЛОКАЦИЯ', object.district],
      ['КЛАСС', object.propertyClass],
      ['МЕТРО', object.metro],
    ];
    facts.forEach(([label, value], index) => {
      const x = 36 + index * 117;
      if (index > 0) {
        doc.moveTo(x, 359).lineTo(x, 412).strokeColor(colors.goldLine).lineWidth(0.55).stroke();
      }
      doc.fillColor(colors.muted).font('NotoSansBold').fontSize(6.1).text(label, x + 8, 366, { width: 101, align: 'center' });
      doc
        .fillColor(colors.ink)
        .font('NotoSansBold')
        .fontSize(7.4)
        .text(value || 'ПО ЗАПРОСУ', x + 8, 388, { width: 101, height: 18, align: 'center', ellipsis: true });
    });

    if (loadedImages[1]) {
      this.drawClippedImage(doc, loadedImages[1], 36, 426, 228, 111, 4);
    } else {
      this.drawImageFallback(doc, 36, 426, 228, 111, 'ДЕТАЛЬ ПРОЕКТА');
    }
    if (loadedImages[2]) {
      this.drawClippedImage(doc, loadedImages[2], 276, 426, 228, 111, 4);
    } else {
      this.drawImageFallback(doc, 276, 426, 228, 111, 'ТЕРРИТОРИЯ');
    }

    doc
      .fillColor(colors.muted)
      .font('NotoSans')
      .fontSize(6.9)
      .text(object.description || 'Описание проекта будет дополнено.', 36, 552, {
        width: 468,
        height: 43,
        ellipsis: true,
        lineGap: 2,
      });

    doc.moveTo(36, 608).lineTo(504, 608).strokeColor(colors.goldLine).lineWidth(0.55).stroke();
    doc
      .fillColor(colors.ink)
      .font('NotoSansBold')
      .fontSize(7.2)
      .text('УЗНАТЬ ПОДРОБНОСТИ  >', 36, 620, { width: 220, link: snapshot.cta.url });
    doc.link(36, 611, 220, 28, snapshot.cta.url);

    const advantages = object.advantages.filter(Boolean).slice(0, 4);
    const defaults = ['СТАРТ ПРОДАЖ', 'СПЕЦИАЛЬНЫЕ УСЛОВИЯ', 'ПРОДУМАННАЯ СРЕДА', 'РЯДОМ С ЦЕНТРОМ'];
    while (advantages.length < 4) advantages.push(defaults[advantages.length]!);
    advantages.forEach((advantage, index) => {
      const x = 36 + index * 117;
      if (index > 0) {
        doc.moveTo(x, 651).lineTo(x, 690).strokeColor(colors.goldLine).lineWidth(0.55).stroke();
      }
      this.drawStar(doc, x + 58.5, 651, 4);
      doc
        .fillColor(colors.ink)
        .font('NotoSansBold')
        .fontSize(6.1)
        .text(advantage.toUpperCase(), x + 8, 670, { width: 101, height: 20, align: 'center', ellipsis: true, lineGap: 1 });
    });
  }

  private drawCompany(doc: PDFKit.PDFDocument, snapshot: ProjectPresentationSnapshotV1) {
    this.drawHeader(doc, snapshot.cover.issueLabel);
    this.drawKicker(doc, 'О КОМПАНИИ', 36, 87);

    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(21).text('НАША ГЛАВНАЯ ЦЕЛЬ —', 36, 124, { width: 340 });
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(21).text('НАЙТИ ВАМ', 36, 155, { width: 340 });
    doc.fillColor(colors.gold).font('NotoSerifDisplay').fontSize(32).text('ЛУЧШИЙ ОБЪЕКТ,', 36, 190, { width: 350, height: 42 });
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(21).text('А НЕ ПРОДАТЬ ТО,', 36, 235, { width: 340 });
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(21).text('ЧТО ЕСТЬ В НАЛИЧИИ', 36, 266, { width: 340 });

    doc.roundedRect(391, 116, 113, 191, 13).fill(colors.ivory);
    doc.image(logo, 424, 154, { fit: [48, 58], align: 'center', valign: 'center' });
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(7.8).text('FluffyWhite', 391, 232, {
      width: 113,
      align: 'center',
    });

    const services: Array<[string, string]> = [
      ['ПОЛНОЕ СОПРОВОЖДЕНИЕ', 'Сопровождаем сделку и документы от первого шага. Остаёмся на связи до получения ключей.'],
      ['СПЕЦИАЛЬНЫЕ УСЛОВИЯ', 'Знаем акции и закрытые предложения. Ведём переговоры и добиваемся дополнительной выгоды.'],
      ['ЧЕСТНЫЙ ПОДХОД', 'Открыто говорим о плюсах, минусах и рисках, чтобы выбор был объективным.'],
      ['НЕЗАВИСИМЫЙ АНАЛИЗ', 'Не привязаны к одному проекту. Сравниваем рынок и выбираем лучший вариант для вас.'],
    ];
    services.forEach(([title, description], index) => {
      const y = 348 + index * 65;
      this.drawStar(doc, 41, y + 1, 4);
      doc.fillColor(colors.ink).font('NotoSansBold').fontSize(7.5).text(title, 58, y - 2, { width: 410 });
      doc.fillColor(colors.muted).font('NotoSans').fontSize(6.7).text(description, 58, y + 17, {
        width: 430,
        height: 28,
        lineGap: 2,
      });
    });

    this.drawKicker(doc, 'А ГЛАВНОЕ', 36, 626, 468, 'center');
    doc.fillColor(colors.ink).font('NotoSerifDisplay').fontSize(33).text('БЕСПЛАТНО ДЛЯ ВАС', 36, 649, {
      width: 468,
      align: 'center',
    });
  }

  private drawFinal(doc: PDFKit.PDFDocument, snapshot: ProjectPresentationSnapshotV1) {
    this.drawHeader(doc, snapshot.cover.issueLabel);
    this.drawKicker(doc, 'С НАМИ ВЫ ПРОЙДЁТЕ', 36, 86, 468, 'center');
    doc.fillColor(colors.ink).font('NotoSerifDisplay').fontSize(47).text('ВЕСЬ ПУТЬ:', 36, 116, {
      width: 468,
      align: 'center',
    });
    this.drawStar(doc, 270, 188, 6);
    doc.fillColor(colors.ink).font('NotoSans').fontSize(8.8).text('Подбор вариантов жилых комплексов\nпо вашим параметрам', 90, 216, {
      width: 360,
      align: 'center',
      lineGap: 4,
    });

    const steps = [
      'Проведение показов\nнепосредственно на стройке',
      'Анализ конкурентов\nи альтернатив',
      'Бронирование и заключение\nдоговора с застройщиком',
      'Регистрация прав\nна вашу квартиру',
    ];
    steps.forEach((label, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = 36 + col * 234;
      const y = 279 + row * 103;
      if (col === 1) {
        doc.moveTo(270, y - 4).lineTo(270, y + 75).strokeColor(colors.goldLine).lineWidth(0.55).stroke();
      }
      if (row === 0) {
        doc.moveTo(78, 265).lineTo(462, 265).strokeColor(colors.goldLine).lineWidth(0.55).stroke();
      }
      this.drawStar(doc, x + 117, y, 4);
      doc.fillColor(colors.ink).font('NotoSans').fontSize(8.1).text(label, x + 14, y + 26, {
        width: 206,
        align: 'center',
        lineGap: 3,
      });
    });

    this.drawStar(doc, 270, 492, 5);
    doc
      .fillColor(colors.ink)
      .font('NotoSerifDisplay')
      .fontSize(17.5)
      .text(
        'С FluffyWhite вы не просто покупаете квартиру.\nВы получаете уверенность, спокойствие и опору.',
        40,
        518,
        { width: 460, height: 80, align: 'center', lineGap: 2 },
      );

    doc
      .fillColor(colors.ink)
      .font('NotoSansBold')
      .fontSize(7.2)
      .text('НАЧАТЬ ПОДБОР  >', 36, 606, { width: 468, align: 'center', link: snapshot.cta.url });
    doc.link(190, 596, 160, 28, snapshot.cta.url);
    doc.moveTo(36, 636).lineTo(504, 636).strokeColor(colors.goldLine).lineWidth(0.55).stroke();

    const phone = snapshot.broker.phone || '+7 (495) 492-48-58';
    const contacts: Array<{ label: string; link?: string }> = [
      { label: 'TELEGRAM', link: snapshot.cta.url },
      { label: 'INSTAGRAM' },
      { label: 'YOUTUBE' },
      { label: phone, link: phone ? `tel:${phone.replace(/[^\d+]/gu, '')}` : undefined },
    ];
    contacts.forEach(({ label, link }, index) => {
      const x = 36 + index * 117;
      doc
        .fillColor(colors.ink)
        .font(index === 3 ? 'NotoSansBold' : 'NotoSans')
        .fontSize(6.8)
        .text(label, x + 3, 658, { width: 111, align: 'center', ...(link ? { link } : {}) });
      if (link) doc.link(x + 3, 650, 111, 22, link);
    });
  }

  private drawHeader(doc: PDFKit.PDFDocument, issueLabel: string) {
    doc.moveTo(36, 43).lineTo(222, 43).strokeColor(colors.goldLine).lineWidth(0.55).stroke();
    doc.moveTo(318, 43).lineTo(504, 43).strokeColor(colors.goldLine).lineWidth(0.55).stroke();
    doc.image(logo, 260, 16, { fit: [20, 26], align: 'center', valign: 'center' });
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(6.4).text('FluffyWhite', 234, 45, {
      width: 72,
      align: 'center',
    });
    doc
      .fillColor(colors.ink)
      .font('NotoSansBold')
      .fontSize(6.2)
      .text((issueLabel || 'КАТАЛОГ ПРОЕКТОВ').toUpperCase(), 405, 22, {
        width: 99,
        height: 12,
        align: 'right',
        ellipsis: true,
        characterSpacing: 0.6,
      });
  }

  private drawEditorialGrid(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    width: number,
    height: number,
  ) {
    doc.save().strokeColor(colors.goldLine).lineWidth(0.48).opacity(0.8);
    for (let row = 0; row < 7; row += 1) {
      const lineY = y + (row * height) / 6;
      doc
        .moveTo(x, lineY)
        .bezierCurveTo(x + width * 0.32, lineY - 16, x + width * 0.66, lineY + 18, x + width, lineY - 2)
        .stroke();
    }
    for (let column = 0; column < 7; column += 1) {
      const lineX = x + (column * width) / 6;
      doc
        .moveTo(lineX, y)
        .bezierCurveTo(lineX + 13, y + height * 0.3, lineX - 14, y + height * 0.7, lineX + 8, y + height)
        .stroke();
    }
    doc.restore();
  }

  private mapPoints(
    objects: ProjectPresentationSnapshotObject[],
    x: number,
    y: number,
    width: number,
    height: number,
  ) {
    const validCoordinates = objects
      .filter(
        (object) =>
          typeof object.latitude === 'number' &&
          Number.isFinite(object.latitude) &&
          typeof object.longitude === 'number' &&
          Number.isFinite(object.longitude),
      )
      .map((object) => ({ object, latitude: object.latitude!, longitude: object.longitude! }));
    const latitudes = validCoordinates.map((item) => item.latitude);
    const longitudes = validCoordinates.map((item) => item.longitude);
    const minLatitude = latitudes.length ? Math.min(...latitudes) : 0;
    const maxLatitude = latitudes.length ? Math.max(...latitudes) : 0;
    const minLongitude = longitudes.length ? Math.min(...longitudes) : 0;
    const maxLongitude = longitudes.length ? Math.max(...longitudes) : 0;
    const latitudeRange = Math.max(maxLatitude - minLatitude, 0.01);
    const longitudeRange = Math.max(maxLongitude - minLongitude, 0.01);
    const coordinatesById = new Map(validCoordinates.map((item) => [item.object.sourceObjectId, item]));

    return objects.map((object, index) => {
      const coordinate = coordinatesById.get(object.sourceObjectId);
      if (coordinate) {
        return {
          object,
          x: x + ((coordinate.longitude - minLongitude) / longitudeRange) * width,
          y: y + (1 - (coordinate.latitude - minLatitude) / latitudeRange) * height,
        };
      }
      const angle = (index / Math.max(objects.length, 1)) * Math.PI * 2 - Math.PI / 2;
      return {
        object,
        x: x + width / 2 + Math.cos(angle) * width * 0.34,
        y: y + height / 2 + Math.sin(angle) * height * 0.32,
      };
    });
  }

  private async loadImage(image: ProjectPresentationSnapshotImage) {
    if (!this.imageCache.has(image.fileId)) {
      this.imageCache.set(
        image.fileId,
        this.filesService
          .getContent(image.fileId, 'detail')
          .then(({ buffer }) =>
            sharp(buffer)
              .rotate()
              .flatten({ background: colors.ivoryLight })
              .jpeg({ quality: 90, mozjpeg: true })
              .toBuffer(),
          )
          .catch(() => null),
      );
    }
    return this.imageCache.get(image.fileId)!;
  }

  private drawClippedImage(
    doc: PDFKit.PDFDocument,
    image: Buffer,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ) {
    doc.save();
    if (radius > 0) {
      doc.roundedRect(x, y, width, height, radius).clip();
    } else {
      doc.rect(x, y, width, height).clip();
    }
    doc.image(image, x, y, { cover: [width, height], align: 'center', valign: 'center' });
    doc.restore();
  }

  private drawImageFallback(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    width: number,
    height: number,
    label: string,
  ) {
    doc.rect(x, y, width, height).fill(colors.soft);
    doc
      .fillColor(colors.muted)
      .font('NotoSansBold')
      .fontSize(7)
      .text(label, x, y + height / 2 - 4, { width, align: 'center', characterSpacing: 0.8 });
  }

  private drawKicker(
    doc: PDFKit.PDFDocument,
    text: string,
    x: number,
    y: number,
    width = 300,
    align: 'left' | 'center' | 'right' = 'left',
  ) {
    doc
      .fillColor(colors.muted)
      .font('NotoSans')
      .fontSize(6.8)
      .text(text, x, y, { width, align, characterSpacing: 1.5 });
  }

  private drawStar(doc: PDFKit.PDFDocument, x: number, y: number, radius: number) {
    doc
      .save()
      .fillColor(colors.gold)
      .moveTo(x, y - radius)
      .lineTo(x + radius * 0.28, y - radius * 0.28)
      .lineTo(x + radius, y)
      .lineTo(x + radius * 0.28, y + radius * 0.28)
      .lineTo(x, y + radius)
      .lineTo(x - radius * 0.28, y + radius * 0.28)
      .lineTo(x - radius, y)
      .lineTo(x - radius * 0.28, y - radius * 0.28)
      .closePath()
      .fill()
      .restore();
  }

  private drawPageNumber(doc: PDFKit.PDFDocument, current: number, total: number, label: string) {
    doc
      .fillColor(colors.muted)
      .font('NotoSans')
      .fontSize(5.8)
      .text(label, 36, 701, { width: 250, characterSpacing: 1.1 });
    doc.fillColor(colors.muted).font('NotoSans').fontSize(5.8).text(`${String(current).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, 452, 701, {
      width: 52,
      align: 'right',
    });
  }

  private titleFontSize(text: string, max: number, min: number) {
    const normalizedLength = text.replace(/\s+/gu, ' ').trim().length;
    if (normalizedLength <= 16) return max;
    if (normalizedLength <= 28) return Math.max(min, max - 5);
    if (normalizedLength <= 44) return Math.max(min, max - 10);
    return min;
  }

  private truncate(value: string, maxLength: number) {
    return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
  }
}
