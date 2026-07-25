import { existsSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import { FeedUnitStatus, FeedUnitType, File, ObjectImageSection, Prisma } from '@prisma/client';
import type { LotPresentationFinishType, LotPresentationUnitFinish } from '@platforma/shared' with {
  'resolution-mode': 'import',
};
import PDFDocument from 'pdfkit';
import sharp from 'sharp';

import { FilesService } from '../files/files.service';

const pageWidth = 595.28;
const pageHeight = 841.89;
const marginX = 30;
const contentWidth = pageWidth - marginX * 2;
const imageFrameRadius = 5;
const colors = {
  paper: '#f3f0e9',
  white: '#fbfaf7',
  ink: '#171715',
  muted: '#77736d',
  line: '#cfcac0',
  accent: '#8f7d69',
  soft: '#e8e2d8',
};
const regularFontPath = resolveFontPath('NotoSans-Regular.ttf');
const boldFontPath = resolveFontPath('NotoSans-Bold.ttf');
const finishLabels: Record<LotPresentationFinishType, string> = {
  ROUGH: 'Черновая отделка (бетон)',
  FINE: 'Предчистовая отделка (вайт-бокс)',
  WITH_FINISH: 'Чистовая отделка (дизайнерская)',
};
const finishAssetPaths: Record<LotPresentationFinishType, string> = {
  ROUGH: resolveFinishAssetPath('rough.png'),
  FINE: resolveFinishAssetPath('fine.png'),
  WITH_FINISH: resolveFinishAssetPath('with-finish.png'),
};

function resolveFontPath(fileName: string) {
  const candidates = [
    join(__dirname, '..', '..', 'assets', 'fonts', fileName),
    join(process.cwd(), 'assets', 'fonts', fileName),
    join(process.cwd(), 'apps', 'api', 'assets', 'fonts', fileName),
  ];
  const resolvedPath = candidates.find((candidate) => existsSync(candidate));

  if (!resolvedPath) {
    throw new Error(`Lot presentation PDF font asset is missing: ${fileName}`);
  }

  return resolvedPath;
}

function resolveFinishAssetPath(fileName: string) {
  const candidates = [
    join(__dirname, '..', '..', 'assets', 'lot-presentations', 'finishes', fileName),
    join(process.cwd(), 'assets', 'lot-presentations', 'finishes', fileName),
    join(process.cwd(), 'apps', 'api', 'assets', 'lot-presentations', 'finishes', fileName),
  ];
  const resolvedPath = candidates.find((candidate) => existsSync(candidate));

  if (!resolvedPath) {
    throw new Error(`Lot presentation finish asset is missing: ${fileName}`);
  }

  return resolvedPath;
}

export type PdfPresentationBroker = {
  name: string;
  phone: string;
  email: string;
  photoFileId?: string | null;
};

type PdfPresentationObjectImage = {
  id: string;
  sortOrder: number;
  isCover: boolean;
  section: ObjectImageSection | null;
  file: File;
};

export type PdfPresentationNearbyPlace = {
  name: string;
  travelTime: string;
  latitude: number | null;
  longitude: number | null;
};

export type PdfPresentationObject = {
  id: string;
  title: string;
  description: string | null;
  address: string | null;
  propertyClass?: string | null;
  ceilingHeight?: string | null;
  completionYear?: number | null;
  completionQuarter?: number | null;
  developerName?: string | null;
  latitude?: Prisma.Decimal | null;
  longitude?: Prisma.Decimal | null;
  developer?: { name: string } | null;
  images: PdfPresentationObjectImage[];
  nearbyPlaces: PdfPresentationNearbyPlace[];
};

type PdfPresentationUnitObject = Omit<PdfPresentationObject, 'nearbyPlaces'>;

export type PdfPresentationUnit = {
  id: string;
  externalId: string;
  type: FeedUnitType;
  status: FeedUnitStatus;
  title: string | null;
  address: string | null;
  building: string | null;
  section: string | null;
  floor: number | null;
  rooms: number | null;
  price: Prisma.Decimal | null;
  discountPrice: Prisma.Decimal | null;
  effectivePrice: Prisma.Decimal | null;
  currency: string | null;
  area: Prisma.Decimal | null;
  pricePerMeter: Prisma.Decimal | null;
  discountPricePerMeter: Prisma.Decimal | null;
  effectivePricePerMeter: Prisma.Decimal | null;
  completionYear: number | null;
  completionQuarter: number | null;
  residentialDetails: {
    apartmentNumber: string | null;
    layoutType: string | null;
    livingArea: Prisma.Decimal | null;
    kitchenArea: Prisma.Decimal | null;
    balconyCount: number | null;
  } | null;
  commercialDetails: {
    commercialType: string | null;
    entrance: string | null;
    ceilingHeight: Prisma.Decimal | null;
    powerKw: Prisma.Decimal | null;
    separateEntrance: boolean | null;
  } | null;
  media: Array<{
    sortOrder: number;
    label: string | null;
    mediaAsset: {
      sourceUrl?: string;
      file: File | null;
    };
  }>;
  object: PdfPresentationUnitObject;
};

export type PdfPresentationGroup = {
  object: PdfPresentationObject;
  units: PdfPresentationUnit[];
};

type GeneratePdfInput = {
  broker: PdfPresentationBroker;
  groups: PdfPresentationGroup[];
  title: string;
  unitFinishes: LotPresentationUnitFinish[];
};

type PageContext = { current: number; total: number };

@Injectable()
export class LotPresentationsPdfService {
  private logoBufferPromise: Promise<Buffer | null> | null = null;

  constructor(private readonly filesService: FilesService) {}

  async generate(input: GeneratePdfInput) {
    const finishTypeByUnitId = new Map(input.unitFinishes.map((item) => [item.unitId, item.finishType]));
    const totalPages = input.groups.reduce(
      (total, group) => total + group.units.length + 1 + this.getProjectDetailsPageCount(group),
      1,
    );
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      bufferPages: false,
      autoFirstPage: true,
      info: { Title: input.title, Author: input.broker.name, Creator: 'Platforma' },
    });
    const chunks: Buffer[] = [];
    const completed = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    this.registerFonts(doc);
    let currentPage = 0;
    let firstPage = true;
    const nextPage = () => {
      if (!firstPage) doc.addPage();
      firstPage = false;
      currentPage += 1;
      doc.rect(0, 0, pageWidth, pageHeight).fill(colors.paper);
      return { current: currentPage, total: totalPages };
    };

    for (const group of input.groups) {
      for (const unit of group.units) {
        const finishType = finishTypeByUnitId.get(unit.id) ?? null;

        if (unit.type === FeedUnitType.RESIDENTIAL && !finishType) {
          throw new Error(`Lot presentation finish is missing for residential unit ${unit.id}`);
        }

        await this.drawLotPage(doc, unit, nextPage(), finishType);
      }

      await this.drawGalleryPage(doc, group.object, nextPage());
      for (const unit of group.units.filter((item) => item.type === FeedUnitType.RESIDENTIAL)) {
        const finishType = finishTypeByUnitId.get(unit.id);

        if (!finishType) {
          throw new Error(`Lot presentation finish is missing for residential unit ${unit.id}`);
        }

        await this.drawProjectDetailsPage(doc, group.object, nextPage(), unit, finishType);
      }

      const commercialUnit = group.units.find((item) => item.type === FeedUnitType.COMMERCIAL);

      if (commercialUnit) {
        await this.drawProjectDetailsPage(doc, group.object, nextPage(), commercialUnit, null);
      }
    }

    await this.drawBrokerPage(doc, input.broker, nextPage());
    doc.end();
    return completed;
  }

  private getProjectDetailsPageCount(group: PdfPresentationGroup) {
    const residentialCount = group.units.filter((unit) => unit.type === FeedUnitType.RESIDENTIAL).length;
    const hasCommercial = group.units.some((unit) => unit.type === FeedUnitType.COMMERCIAL);

    return residentialCount + Number(hasCommercial);
  }

  private registerFonts(doc: PDFKit.PDFDocument) {
    doc.registerFont('NotoSans', regularFontPath);
    doc.registerFont('NotoSansBold', boldFontPath);
    doc.font('NotoSans');
  }

  private async drawLotPage(
    doc: PDFKit.PDFDocument,
    unit: PdfPresentationUnit,
    page: PageContext,
    finishType: LotPresentationFinishType | null,
  ) {
    await this.drawHeader(doc, unit.object.title);
    const cover = [...unit.object.images].sort((a, b) => Number(b.isCover) - Number(a.isCover) || a.sortOrder - b.sortOrder)[0];
    const { plan, floorPlan, floorPlanFillFrame } = this.getLotPlanFiles(unit);

    const titleLayout = this.getLotTitleLayout(doc, this.getLotTitle(unit), 320);
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(titleLayout.fontSize);
    titleLayout.lines.forEach((line, index) => {
      doc.text(line, marginX, 58 + index * titleLayout.fontSize * 1.2, {
        width: 320,
        lineBreak: false,
      });
    });
    const subtitleY = titleLayout.lines.length === 1 ? 116 : 118;
    doc.fillColor(colors.muted).font('NotoSans').fontSize(7.5).text(this.getLotSubtitle(unit), marginX, subtitleY, {
      width: 320,
      height: 22,
      ellipsis: true,
    });
    await this.drawProjectFileFrame(doc, cover?.file ?? null, 368, 53, 197, 108, 'Фото проекта');

    doc.moveTo(marginX, 182).lineTo(pageWidth - marginX, 182).strokeColor(colors.line).lineWidth(0.7).stroke();
    doc.fillColor(colors.muted).font('NotoSans').fontSize(7).text('ПЛАНИРОВКА', marginX, 199);
    await this.drawFileFrame(doc, plan, marginX, 223, 303, 278, 'Планировка недоступна');
    this.drawPriceSummary(doc, unit, 374, 199, 191);
    this.drawPrimaryFacts(doc, unit, finishType, 374, 292);
    doc
      .fillColor(colors.muted)
      .font('NotoSans')
      .fontSize(6.7)
      .text('Полная оплата · ипотека · рассрочка', 374, unit.type === FeedUnitType.RESIDENTIAL ? 486 : 454, {
        width: 191,
      });

    doc.moveTo(marginX, 530).lineTo(pageWidth - marginX, 530).strokeColor(colors.line).lineWidth(0.7).stroke();
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(7).text('НА ЭТАЖЕ', marginX, 548);
    doc.fillColor(colors.muted).font('NotoSans').fontSize(7).text('ХАРАКТЕРИСТИКИ', 374, 548);
    await this.drawFileFrame(
      doc,
      floorPlan,
      marginX,
      570,
      303,
      192,
      'План этажа недоступен',
      floorPlanFillFrame,
    );
    this.drawCharacteristics(doc, unit, 374, 570, 191);

    this.drawFooter(
      doc,
      page,
      `Предложение сформировано ${new Intl.DateTimeFormat('ru-RU').format(new Date())}`,
    );
  }

  private drawPrimaryFacts(
    doc: PDFKit.PDFDocument,
    unit: PdfPresentationUnit,
    finishType: LotPresentationFinishType | null,
    x: number,
    y: number,
  ) {
    if (unit.type === FeedUnitType.RESIDENTIAL) {
      const finishLabel = finishType ? finishLabels[finishType] : '—';
      this.drawPrimaryFact(doc, 'Площадь', this.formatArea(unit.area) ?? '—', x, y, 91);
      this.drawPrimaryFact(doc, 'Этаж', unit.floor === null ? '—' : String(unit.floor), x + 99, y, 92);
      this.drawPrimaryFact(doc, 'Класс', unit.object.propertyClass?.trim() || '—', x, y + 54, 191);
      this.drawPrimaryFact(doc, 'Отделка', finishLabel, x, y + 108, 191, 32);
      return;
    }

    const facts: Array<[string, string]> = [
      ['Площадь', this.formatArea(unit.area) ?? '—'],
      ['Этаж', unit.floor === null ? '—' : String(unit.floor)],
      ['Класс', unit.object.propertyClass?.trim() || '—'],
      ['Состояние', '—'],
    ];
    const width = 91;
    facts.forEach(([label, value], index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const itemX = x + column * 99;
      const itemY = y + row * 78;
      this.drawPrimaryFact(doc, label, value, itemX, itemY, width);
    });
  }

  private drawPrimaryFact(
    doc: PDFKit.PDFDocument,
    label: string,
    value: string,
    x: number,
    y: number,
    width: number,
    height = 28,
  ) {
    doc.fillColor(colors.muted).font('NotoSans').fontSize(6.7).text(label, x, y, { width });
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(10.5).text(value, x, y + 15, {
      width,
      height,
      ellipsis: true,
    });
  }

  private drawPriceSummary(doc: PDFKit.PDFDocument, unit: PdfPresentationUnit, x: number, y: number, width: number) {
    const summary = this.getPriceSummary(unit);
    doc.fillColor(colors.muted).font('NotoSans').fontSize(7).text('СТОИМОСТЬ ПРИ ПОЛНОЙ ОПЛАТЕ', x, y, {
      width,
      height: 24,
    });
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(18).text(summary.primary, x, y + 19, {
      width,
      height: 29,
      ellipsis: true,
    });
    if (summary.secondary) {
      doc.fillColor(colors.muted).font('NotoSans').fontSize(7.5).text(summary.secondary, x, y + 50, { width: 100 });
      const oldWidth = doc.widthOfString(summary.secondary);
      doc.moveTo(x, y + 55).lineTo(x + Math.min(oldWidth, 100), y + 55).strokeColor(colors.muted).lineWidth(0.7).stroke();
    }
    doc.fillColor(colors.muted).font('NotoSans').fontSize(8).text(summary.pricePerMeter, x, y + (summary.secondary ? 69 : 51), { width });
  }

  private drawCharacteristics(
    doc: PDFKit.PDFDocument,
    unit: PdfPresentationUnit,
    x: number,
    y: number,
    width: number,
  ) {
    const residential = unit.type === FeedUnitType.RESIDENTIAL;
    const rows: Array<[string, string | null]> = residential
      ? [
          ['Срок сдачи', this.formatCompletion(unit)],
          ['Застройщик', unit.object.developerName ?? unit.object.developer?.name ?? null],
          ['Договор', 'ДДУ/ДКП'],
          ['Оплата', 'Полная оплата · ипотека · рассрочка'],
        ]
      : [
          ['Тип помещения', unit.commercialDetails?.commercialType ?? null],
          ['Высота потолков', this.formatMeters(unit.commercialDetails?.ceilingHeight ?? null)],
          ['Мощность', this.formatPower(unit.commercialDetails?.powerKw ?? null)],
          ['Вход', unit.commercialDetails?.entrance ?? null],
          ['Срок сдачи', this.formatCompletion(unit)],
          ['Застройщик', unit.object.developerName ?? unit.object.developer?.name ?? null],
          ['Отдельный вход', this.formatBoolean(unit.commercialDetails?.separateEntrance)],
          ['Оплата', 'Полная оплата · ипотека · рассрочка'],
        ];

    rows.forEach(([label, rawValue], index) => {
      const itemY = y + index * 24;
      doc.moveTo(x, itemY + 19).lineTo(x + width, itemY + 19).strokeColor(colors.line).lineWidth(0.45).stroke();
      doc.fillColor(colors.muted).font('NotoSans').fontSize(6.1).text(label, x, itemY, { width: 72 });
      doc.fillColor(colors.ink).font('NotoSans').fontSize(6.2).text(rawValue || '—', x + 76, itemY, {
        width: width - 76,
        height: 15,
        align: 'right',
        ellipsis: true,
      });
    });
  }

  private async drawGalleryPage(doc: PDFKit.PDFDocument, object: PdfPresentationObject, page: PageContext) {
    await this.drawHeader(doc);
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(22).text('Проект в деталях', marginX, 59, {
      width: contentWidth,
      height: 30,
    });
    doc
      .fillColor(colors.muted)
      .font('NotoSans')
      .fontSize(7.5)
      .text('Архитектура, благоустройство и пространства для жителей', marginX, 89, { width: contentWidth });
    doc.moveTo(marginX, 117).lineTo(pageWidth - marginX, 117).strokeColor(colors.line).lineWidth(0.5).stroke();
    const images = this.selectProjectImages(object.images);
    await this.drawProjectFileFrame(doc, images.hero?.file ?? null, marginX, 136, contentWidth, 223, 'Фото проекта');
    const galleryFrames = [
      [marginX, 370, 168, 196],
      [marginX, 575, 168, 196],
      [208, 370, 174, 196],
      [208, 575, 174, 196],
      [392, 370, 173, 196],
      [392, 575, 173, 196],
    ] as const;
    const galleryImages = [
      images.architecture[0],
      images.architecture[1],
      images.interiors[0],
      images.interiors[1],
      images.filling[0],
      images.filling[1],
    ];

    for (const [index, frame] of galleryFrames.entries()) {
      await this.drawProjectFileFrame(
        doc,
        galleryImages[index]?.file ?? null,
        frame[0],
        frame[1],
        frame[2],
        frame[3],
        'Фото проекта',
      );
    }
    this.drawFooter(doc, page, 'Персональное предложение FluffyWhite');
  }

  private async drawProjectDetailsPage(
    doc: PDFKit.PDFDocument,
    object: PdfPresentationObject,
    page: PageContext,
    unit: PdfPresentationUnit,
    finishType: LotPresentationFinishType | null,
  ) {
    await this.drawHeader(doc, object.title);
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(22).text('Отделка и расположение', marginX, 59);
    doc
      .fillColor(colors.muted)
      .font('NotoSans')
      .fontSize(7.5)
      .text(
        finishType
          ? `${this.getLotTitle(unit)} · ${this.getLotSubtitle(unit)}`
          : 'Состояние квартиры, транспорт и особенности проекта',
        marginX,
        89,
        { width: contentWidth, height: 16, ellipsis: true },
      );
    doc.moveTo(marginX, 117).lineTo(pageWidth - marginX, 117).strokeColor(colors.line).lineWidth(0.5).stroke();

    doc
      .fillColor(colors.muted)
      .font('NotoSans')
      .fontSize(7)
      .text('СОСТОЯНИЕ КВАРТИРЫ', marginX, 136);
    this.drawPhotoBufferFrame(
      doc,
      finishType ? finishAssetPaths[finishType] : null,
      marginX,
      153,
      303,
      164,
      'Фото отделки',
    );
    doc
      .fillColor(colors.muted)
      .font('NotoSans')
      .fontSize(7)
      .text(finishType ? 'ТИП ОТДЕЛКИ' : 'БАЗОВАЯ ОТДЕЛКА', 374, 136, { width: 191 });
    doc
      .fillColor(colors.ink)
      .font('NotoSansBold')
      .fontSize(14)
      .text(finishType ? finishLabels[finishType] : 'Без отделки', 374, 156, { width: 191 });

    if (!finishType) {
      doc
        .font('NotoSans')
        .fontSize(7.7)
        .fillColor(colors.ink)
        .text('Информация об отделке будет добавлена позже.', 374, 184, {
          width: 191,
          lineGap: 3,
        });
    }

    if (finishType) {
      doc
        .fillColor(colors.muted)
        .font('NotoSans')
        .fontSize(5.2)
        .text(
          'Пример состояния отделки представлен для иллюстрации, но не является конечной версией отделки',
          marginX,
          322,
          { width: contentWidth, height: 7, lineBreak: false },
        );
    }

    const mapBuffer = await this.loadStaticMap(object);
    doc.moveTo(marginX, 334).lineTo(pageWidth - marginX, 334).strokeColor(colors.line).lineWidth(0.5).stroke();
    doc.fillColor(colors.muted).font('NotoSans').fontSize(7).text('РАСПОЛОЖЕНИЕ', marginX, 350);
    this.drawPhotoBufferFrame(doc, mapBuffer, marginX, 368, 303, 201, 'Карта недоступна');
    this.drawNearbyPlaces(doc, object.nearbyPlaces, 374, 350, 191);

    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(7.5).text(object.address || 'Адрес не указан', marginX, 579, {
      width: 303,
      height: 18,
      ellipsis: true,
    });
    doc.moveTo(marginX, 608).lineTo(pageWidth - marginX, 608).strokeColor(colors.line).lineWidth(0.5).stroke();
    doc.fillColor(colors.muted).font('NotoSans').fontSize(7).text('О ПРОЕКТЕ', marginX, 624);
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(14).text(this.cleanProjectName(object.title), marginX, 641, {
      width: contentWidth,
      height: 22,
      ellipsis: true,
    });
    const description = object.description?.trim() || 'Описание проекта пока не заполнено.';
    doc.fillColor(colors.ink).font('NotoSans').fontSize(7.3).text(description, marginX, 664, {
      width: contentWidth,
      height: 112,
      lineGap: 2,
      ellipsis: true,
    });
    this.drawFooter(doc, page, 'Персональное предложение FluffyWhite');
  }

  private async drawBrokerPage(doc: PDFKit.PDFDocument, broker: PdfPresentationBroker, page: PageContext) {
    await this.drawHeader(doc);
    const photo = broker.photoFileId ? await this.safeLoadImage(broker.photoFileId, 'detail') : null;
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(22).text('Персональный брокер', marginX, 59, { width: contentWidth });
    doc
      .fillColor(colors.muted)
      .font('NotoSans')
      .fontSize(7.5)
      .text('Проверка актуальности, ответы на вопросы и организация просмотра', marginX, 89, { width: contentWidth });
    doc.moveTo(marginX, 117).lineTo(pageWidth - marginX, 117).strokeColor(colors.line).lineWidth(0.5).stroke();
    doc.fillColor(colors.muted).font('NotoSans').fontSize(7).text('КОНТАКТ', marginX, 136);
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(22).text(broker.name, marginX, 160, {
      width: 323,
      height: 58,
      ellipsis: true,
    });
    doc.fillColor(colors.muted).font('NotoSans').fontSize(7.5).text('Персональный брокер FluffyWhite', marginX, 219, { width: 323 });
    doc.moveTo(marginX, 244).lineTo(353, 244).strokeColor(colors.line).lineWidth(0.5).stroke();
    doc.fillColor(colors.ink).font('NotoSans').fontSize(10).text([broker.phone, broker.email].filter(Boolean).join('\n'), marginX, 260, {
      width: 323,
      lineGap: 3,
    });
    doc.moveTo(marginX, 304).lineTo(353, 304).strokeColor(colors.line).lineWidth(0.5).stroke();
    const contactLabel = 'Связаться с брокером';
    doc.fillColor(colors.ink).font('NotoSans').fontSize(8).text(contactLabel, marginX, 318, { width: 323 });
    const contactArrowX = marginX + doc.widthOfString(contactLabel) + 7;
    doc.moveTo(contactArrowX, 329).lineTo(contactArrowX, 316).strokeColor(colors.ink).lineWidth(0.7).stroke();
    doc
      .moveTo(contactArrowX - 3, 320)
      .lineTo(contactArrowX, 316)
      .lineTo(contactArrowX + 3, 320)
      .strokeColor(colors.ink)
      .lineWidth(0.7)
      .stroke();
    doc.moveTo(marginX, 338).lineTo(353, 338).strokeColor(colors.line).lineWidth(0.5).stroke();
    doc.fillColor(colors.muted).font('NotoSans').fontSize(8).text(
      'Отвечу на вопросы по квартире, актуальным условиям покупки и организую просмотр проекта.',
      marginX,
      354,
      { width: 323, lineGap: 3 },
    );
    this.drawPhotoBufferFrame(doc, photo, 373, 134, 192, 303, 'Фото брокера');

    doc.moveTo(marginX, 475).lineTo(pageWidth - marginX, 475).strokeColor(colors.line).lineWidth(0.5).stroke();
    doc.fillColor(colors.muted).font('NotoSans').fontSize(7).text('О FLUFFYWHITE', marginX, 490);
    const logo = await this.getLogoBuffer();
    if (logo) doc.image(logo, 78, 522, { fit: [48, 55], align: 'center', valign: 'center' });
    doc.fillColor(colors.ink).font('NotoSansBold').fontSize(14).text('Агентство FluffyWhite', 170, 515, { width: 395 });
    doc.fillColor(colors.muted).font('NotoSans').fontSize(7.5).text('Экспертный подход к недвижимости', 170, 537, { width: 395 });
    doc.fillColor(colors.ink).font('NotoSans').fontSize(7.5).text(
      'FluffyWhite — бутиковое агентство недвижимости. Мы подбираем объекты под цели, образ жизни и инвестиционную стратегию клиента, анализируем проект и условия сделки и сопровождаем покупку на ключевых этапах.',
      170,
      555,
      { width: 395, lineGap: 2 },
    );
    const advantages: Array<[string, string]> = [
      ['ПЕРСОНАЛЬНЫЙ ПОДБОР', 'Объекты под цели, бюджет и сценарий жизни клиента.'],
      ['ЭКСПЕРТНЫЙ АНАЛИЗ', 'Оценка проекта, локации, цены и условий сделки.'],
      ['ПОЛНОЕ СОПРОВОЖДЕНИЕ', 'Координация коммуникации, документов и этапов покупки.'],
    ];
    advantages.forEach(([title, text], index) => {
      const y = 615 + index * 44;
      doc.fillColor(colors.ink).font('NotoSansBold').fontSize(7.5).text(title, marginX, y, { width: contentWidth });
      doc.fillColor(colors.muted).font('NotoSans').fontSize(6.7).text(text, marginX, y + 14, { width: contentWidth });
      doc.moveTo(marginX, y + 32).lineTo(pageWidth - marginX, y + 32).strokeColor(colors.line).lineWidth(0.45).stroke();
    });
    doc.fillColor(colors.accent).font('NotoSansBold').fontSize(10.5).text('fluffywhite.moscow', marginX, 755);
    doc.fillColor(colors.muted).font('NotoSans').fontSize(5.8).text(
      'Информация в презентации не является публичной офертой. Стоимость и характеристики объекта необходимо уточнять на дату обращения.',
      marginX,
      778,
      { width: contentWidth - 65, lineGap: 1.5 },
    );
    this.drawFooter(doc, page);
  }

  private async drawHeader(doc: PDFKit.PDFDocument, contextLabel?: string) {
    if (contextLabel) {
      const logo = await this.getLogoBuffer();
      if (logo) {
        doc.image(logo, marginX, 10, { fit: [18, 24], valign: 'center' });
      } else {
        doc.fillColor(colors.ink).font('NotoSansBold').fontSize(8).text('FW', marginX, 20);
      }
      doc.fillColor(colors.ink).font('NotoSansBold').fontSize(8.5).text('FluffyWhite', marginX + 28, 20);
      doc
        .fillColor(colors.ink)
        .font('NotoSans')
        .fontSize(6.7)
        .text(`${this.cleanProjectName(contextLabel).toUpperCase()} · ПЕРСОНАЛЬНОЕ ПРЕДЛОЖЕНИЕ`, 280, 20, {
          width: pageWidth - marginX - 280,
          height: 12,
          align: 'right',
          ellipsis: true,
        });
    }
    doc.moveTo(marginX, 39).lineTo(pageWidth - marginX, 39).strokeColor(colors.line).lineWidth(0.6).stroke();
  }

  private drawFooter(doc: PDFKit.PDFDocument, page: PageContext, label?: string) {
    if (label) {
      doc.fillColor(colors.muted).font('NotoSans').fontSize(5.5).text(label, marginX, pageHeight - 27, {
        width: contentWidth - 70,
      });
    }
    doc.fillColor(colors.muted).font('NotoSans').fontSize(6).text(`${page.current} / ${page.total}`, pageWidth - marginX - 55, pageHeight - 28, {
      width: 55,
      align: 'right',
    });
  }

  private async drawFileFrame(
    doc: PDFKit.PDFDocument,
    file: File | null,
    x: number,
    y: number,
    width: number,
    height: number,
    fallback: string,
    fillFrame = false,
  ) {
    const buffer = file ? await this.safeLoadImage(file.id, 'detail') : null;
    if (fillFrame) {
      this.drawPhotoBufferFrame(doc, buffer, x, y, width, height, fallback);
    } else {
      this.drawBufferFrame(doc, buffer, x, y, width, height, fallback);
    }
  }

  private async drawProjectFileFrame(
    doc: PDFKit.PDFDocument,
    file: File | null,
    x: number,
    y: number,
    width: number,
    height: number,
    fallback: string,
  ) {
    const buffer = file ? await this.safeLoadImage(file.id, 'detail') : null;
    this.drawPhotoBufferFrame(doc, buffer, x, y, width, height, fallback);
  }

  private drawPhotoBufferFrame(
    doc: PDFKit.PDFDocument,
    source: Buffer | string | null,
    x: number,
    y: number,
    width: number,
    height: number,
    fallback: string,
  ) {
    doc.roundedRect(x, y, width, height, imageFrameRadius).fill(colors.white);
    if (source) {
      doc.save();
      doc.roundedRect(x, y, width, height, imageFrameRadius).clip();
      doc.image(source, x, y, { cover: [width, height], align: 'center', valign: 'center' });
      doc.restore();
      doc.roundedRect(x, y, width, height, imageFrameRadius).strokeColor(colors.line).lineWidth(0.5).stroke();
    } else {
      doc.roundedRect(x, y, width, height, imageFrameRadius).strokeColor(colors.line).lineWidth(0.5).stroke();
      this.drawImageFallback(doc, x, y, width, height, fallback);
    }
  }

  private drawBufferFrame(
    doc: PDFKit.PDFDocument,
    buffer: Buffer | null,
    x: number,
    y: number,
    width: number,
    height: number,
    fallback: string,
  ) {
    doc
      .lineWidth(0.5)
      .roundedRect(x, y, width, height, imageFrameRadius)
      .fillAndStroke(colors.white, colors.line);
    if (buffer) {
      doc.save();
      doc.roundedRect(x, y, width, height, imageFrameRadius).clip();
      doc.image(buffer, x + 3, y + 3, { fit: [width - 6, height - 6], align: 'center', valign: 'center' });
      doc.restore();
    } else {
      this.drawImageFallback(doc, x, y, width, height, fallback);
    }
  }

  private drawNearbyPlaces(
    doc: PDFKit.PDFDocument,
    nearbyPlaces: PdfPresentationNearbyPlace[],
    x: number,
    y: number,
    width: number,
  ) {
    doc.fillColor(colors.muted).font('NotoSans').fontSize(7).text('МЕСТА РЯДОМ', x, y, { width });

    if (nearbyPlaces.length === 0) {
      doc
        .fillColor(colors.muted)
        .font('NotoSans')
        .fontSize(7.2)
        .text('Информация о местах рядом не указана', x, y + 25, { width, lineGap: 2 });
      return;
    }

    nearbyPlaces.forEach((place, index) => {
      const rowY = y + 25 + index * 43;

      doc.fillColor(colors.ink).font('NotoSansBold').fontSize(7.1).text(place.name, x, rowY, {
        width,
        height: 18,
        ellipsis: true,
      });
      doc.fillColor(colors.muted).font('NotoSans').fontSize(6.5).text(place.travelTime, x, rowY + 20, {
        width,
        height: 10,
        ellipsis: true,
      });

      if (index < nearbyPlaces.length - 1) {
        doc.moveTo(x, rowY + 35).lineTo(x + width, rowY + 35).strokeColor(colors.line).lineWidth(0.45).stroke();
      }
    });
  }

  private drawImageFallback(doc: PDFKit.PDFDocument, x: number, y: number, width: number, height: number, label: string) {
    doc.fillColor(colors.muted).font('NotoSans').fontSize(8).text(label, x + 10, y + height / 2 - 5, {
      width: width - 20,
      align: 'center',
    });
  }

  private selectProjectImages(images: PdfPresentationObjectImage[]) {
    const sorted = [...images].sort((left, right) => Number(right.isCover) - Number(left.isCover) || left.sortOrder - right.sortOrder);
    const hero = sorted.find((image) => image.isCover) ?? sorted[0] ?? null;
    const galleryImages = hero ? sorted.filter((image) => image.id !== hero.id) : sorted;
    const architecture = galleryImages.filter((image) => image.section === ObjectImageSection.ARCHITECTURE).slice(0, 2);
    const interiors = galleryImages.filter((image) => image.section === ObjectImageSection.INTERIORS).slice(0, 2);
    const filling = galleryImages.filter((image) => image.section === ObjectImageSection.FILLING).slice(0, 2);
    const usedImageIds = new Set([...architecture, ...interiors, ...filling].map((image) => image.id));
    const fallbackImages = galleryImages.filter((image) => !usedImageIds.has(image.id));
    const fillSection = (selected: PdfPresentationObjectImage[]) => {
      while (selected.length < 2) {
        const fallbackImage = fallbackImages.shift();
        if (!fallbackImage) break;
        selected.push(fallbackImage);
      }

      return selected;
    };

    return {
      hero,
      architecture: fillSection(architecture),
      interiors: fillSection(interiors),
      filling: fillSection(filling),
    };
  }

  private getLotPlanFiles(unit: PdfPresentationUnit) {
    const media = [...unit.media]
      .filter((item) => item.mediaAsset.file)
      .sort((left, right) => left.sortOrder - right.sortOrder);
    const normalizedLabel = (item: (typeof media)[number]) => item.label?.trim().toLowerCase() ?? '';
    const normalizedFileReference = (item: (typeof media)[number]) => {
      const file = item.mediaAsset.file;
      return [item.mediaAsset.sourceUrl, file?.originalName, file?.key, file?.url]
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLowerCase();
    };
    const hasFloorPlanReference = (item: (typeof media)[number]) => {
      const reference = normalizedFileReference(item);

      return (
        /(?:^|[\s/_-])floor[\s_-]?plan(?:[\s/_.-]|$)/u.test(reference) ||
        /(?:^|\/)ddu(?:\/|$)/u.test(reference)
      );
    };
    const hasUnitPlanReference = (item: (typeof media)[number]) =>
      /(?:^|[\s/_-])(?:flat|image)[\s_-]?plan(?:[\s/_.-]|$)/u.test(normalizedFileReference(item));
    const floorPlanItem =
      media.find(hasFloorPlanReference) ??
      media.find((item) => normalizedLabel(item) === 'floor-plan') ??
      media.find((item) => normalizedLabel(item).includes('floor-plan'));
    const explicitPlanItem =
      media.find((item) => item !== floorPlanItem && hasUnitPlanReference(item)) ??
      media.find((item) => item !== floorPlanItem && normalizedLabel(item) === 'flat-plan') ??
      media.find(
        (item) =>
          item !== floorPlanItem &&
          normalizedLabel(item).includes('flat-plan') &&
          !normalizedLabel(item).includes('floor'),
      ) ??
      media.find(
        (item) =>
          item !== floorPlanItem &&
          normalizedLabel(item).includes('plan') &&
          !normalizedLabel(item).includes('floor'),
      );
    const planItem =
      explicitPlanItem ??
      media.find((item) => item !== floorPlanItem) ??
      null;
    const resolvedFloorPlanItem =
      floorPlanItem ??
      (explicitPlanItem ? null : media.find((item) => item !== planItem));
    const objectGalleryFallback = [...unit.object.images].sort(
      (left, right) => Number(right.isCover) - Number(left.isCover) || left.sortOrder - right.sortOrder,
    )[1]?.file ?? null;
    const floorPlan = resolvedFloorPlanItem?.mediaAsset.file ?? objectGalleryFallback;

    return {
      plan: planItem?.mediaAsset.file ?? null,
      floorPlan,
      floorPlanFillFrame: floorPlan !== null && floorPlanItem === undefined,
    };
  }

  private async loadStaticMap(object: PdfPresentationObject) {
    const latitude = this.decimalToNumber(object.latitude);
    const longitude = this.decimalToNumber(object.longitude);
    if (latitude === null || longitude === null) return null;
    const params = new URLSearchParams({
      ll: `${longitude},${latitude}`,
      z: '15',
      size: '650,340',
      l: 'map',
      lang: 'ru_RU',
      pt: `${longitude},${latitude},pm2rdm`,
    });
    try {
      const response = await fetch(`https://static-maps.yandex.ru/1.x/?${params.toString()}`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Platforma PDF generator' },
      });
      if (!response.ok) return null;
      const source = Buffer.from(await response.arrayBuffer());
      return sharp(source).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    } catch {
      return null;
    }
  }

  private getPriceSummary(unit: PdfPresentationUnit) {
    const hasDiscount = this.hasRealDiscount(unit);
    const primary = hasDiscount
      ? this.formatMoney(unit.discountPrice, unit.currency)
      : this.formatMoney(unit.effectivePrice ?? unit.price, unit.currency);
    return {
      primary,
      secondary: hasDiscount ? this.formatMoney(unit.price, unit.currency) : null,
      pricePerMeter: this.formatPricePerMeter(unit),
    };
  }

  private getLotTitle(unit: PdfPresentationUnit) {
    const projectName = this.cleanProjectName(unit.object.title);
    if (unit.type === FeedUnitType.COMMERCIAL) {
      const commercialType = unit.commercialDetails?.commercialType?.trim() || 'Коммерческое помещение';
      return `${commercialType} в проекте ${projectName}`;
    }
    if (unit.rooms === 0) return `Студия в проекте ${projectName}`;
    if (unit.rooms) return `${unit.rooms}-К в проекте ${projectName}`;
    return `Квартира в проекте ${projectName}`;
  }

  private getLotTitleLayout(doc: PDFKit.PDFDocument, title: string, maxWidth: number) {
    const normalizedTitle = title.replace(/\s+/gu, ' ').trim();
    const baseFontSize = 22;
    const words = normalizedTitle.split(' ');

    doc.font('NotoSansBold').fontSize(baseFontSize);
    if (doc.widthOfString(normalizedTitle) <= maxWidth || words.length === 1) {
      const scale = Math.min(1, maxWidth / doc.widthOfString(normalizedTitle));
      return {
        lines: [normalizedTitle],
        fontSize: Math.max(1, Math.floor(baseFontSize * scale * 10) / 10),
      };
    }

    const candidates = words.slice(1).map((_, index) => {
      const splitAt = index + 1;
      const lines: [string, string] = [
        words.slice(0, splitAt).join(' '),
        words.slice(splitAt).join(' '),
      ];
      const widths: [number, number] = [doc.widthOfString(lines[0]), doc.widthOfString(lines[1])];
      return {
        lines,
        maxLineWidth: Math.max(...widths),
        widthDifference: Math.abs(widths[0] - widths[1]),
      };
    });
    const best = candidates.reduce((current, candidate) => {
      if (candidate.maxLineWidth < current.maxLineWidth) return candidate;
      if (
        candidate.maxLineWidth === current.maxLineWidth &&
        candidate.widthDifference < current.widthDifference
      ) {
        return candidate;
      }
      return current;
    });
    const scale = Math.min(1, maxWidth / best.maxLineWidth);

    return {
      lines: best.lines,
      fontSize: Math.max(1, Math.floor(baseFontSize * scale * 10) / 10),
    };
  }

  private cleanProjectName(value: string) {
    const original = value.trim();
    let result = original;
    const prefix = /^(?:(?:премиальный|элитный|жилой|апартаментный)\s+)*(?:жилой\s+(?:комплекс|квартал)|клубный\s+(?:дом|особняк)|многофункциональный\s+комплекс|комплекс\s+апартаментов|апарт-комплекс|резиденци(?:я|и)|жк|кд|мфк|дом)\s*/iu;

    while (prefix.test(result)) result = result.replace(prefix, '').trim();
    result = result.replace(/^[«„“"']+|[»“"']+$/gu, '').trim();
    return result || original;
  }

  private getLotSubtitle(unit: PdfPresentationUnit) {
    const details = [
      this.formatArea(unit.area),
      unit.building?.trim() ? `корпус ${unit.building.trim()}` : null,
      unit.section?.trim() ? `секция ${unit.section.trim()}` : null,
      unit.type === FeedUnitType.RESIDENTIAL && unit.residentialDetails?.apartmentNumber
        ? `квартира № ${unit.residentialDetails.apartmentNumber}`
        : null,
    ].filter(Boolean);
    return details.join(' · ') || unit.object.title;
  }

  private formatPricePerMeter(unit: PdfPresentationUnit) {
    const value = unit.effectivePricePerMeter ?? unit.discountPricePerMeter ?? unit.pricePerMeter;
    if (value) return `${this.formatMoney(value, unit.currency)} / м²`;
    const price = this.decimalToNumber(unit.effectivePrice ?? unit.discountPrice ?? unit.price);
    const area = this.decimalToNumber(unit.area);
    return price !== null && area !== null && area > 0 ? `${this.formatNumber(price / area)} ₽ / м²` : '— / м²';
  }

  private formatMoney(value: Prisma.Decimal | null | undefined, currency: string | null) {
    const number = this.decimalToNumber(value);
    if (number === null) return 'По запросу';
    return currency && !['RUB', 'RUR'].includes(currency.toUpperCase())
      ? `${this.formatNumber(number)} ${currency}`
      : `${this.formatNumber(number)} ₽`;
  }

  private formatArea(value: Prisma.Decimal | null) {
    const number = this.decimalToNumber(value);
    return number === null ? null : `${this.formatNumber(number)} м²`;
  }

  private formatMeters(value: Prisma.Decimal | null) {
    const number = this.decimalToNumber(value);
    return number === null ? null : `${this.formatNumber(number)} м`;
  }

  private formatPower(value: Prisma.Decimal | null) {
    const number = this.decimalToNumber(value);
    return number === null ? null : `${this.formatNumber(number)} кВт`;
  }

  private formatCompletion(unit: PdfPresentationUnit) {
    if (!unit.completionYear) return null;
    return unit.completionQuarter ? `${unit.completionQuarter} кв. ${unit.completionYear}` : String(unit.completionYear);
  }

  private formatBoolean(value: boolean | null | undefined) {
    return value === null || value === undefined ? null : value ? 'Да' : 'Нет';
  }

  private hasRealDiscount(unit: PdfPresentationUnit) {
    const price = this.decimalToNumber(unit.price);
    const discount = this.decimalToNumber(unit.discountPrice);
    return price !== null && discount !== null && discount > 0 && discount < price;
  }

  private decimalToNumber(value: Prisma.Decimal | null | undefined) {
    if (!value) return null;
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : null;
  }

  private formatNumber(value: number) {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: Number.isInteger(value) ? 0 : 1 }).format(value);
  }

  private async safeLoadImage(fileId: string, variant: 'detail' | 'card' | 'thumbnail') {
    try {
      const { buffer } = await this.filesService.getContent(fileId, variant);
      return sharp(buffer)
        .rotate()
        .flatten({ background: colors.white })
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
    } catch {
      return null;
    }
  }

  private async getLogoBuffer() {
    if (!this.logoBufferPromise) this.logoBufferPromise = this.loadLogoBuffer();
    return this.logoBufferPromise;
  }

  private async loadLogoBuffer() {
    const candidates = [
      join(process.cwd(), '_Fluffy_White_1-02.svg'),
      join(process.cwd(), '..', '_Fluffy_White_1-02.svg'),
      join(process.cwd(), '..', '..', '_Fluffy_White_1-02.svg'),
    ];
    for (const candidate of candidates) {
      if (await this.pathExists(candidate)) {
        return sharp(await readFile(candidate)).resize({ width: 150, withoutEnlargement: true }).png().toBuffer();
      }
    }
    return null;
  }

  private async pathExists(path: string) {
    return access(path).then(() => true).catch(() => false);
  }
}
