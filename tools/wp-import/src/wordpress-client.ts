import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import mysql, { RowDataPacket } from 'mysql2/promise';

import { ImportConfig } from './env';
import {
  WpAttachment,
  WpMetaRow,
  WpObjectTerm,
  WpPost,
  WpSourceData,
  WpTerm,
  WpTermMetaRow,
} from './types';

type OptionRow = RowDataPacket & {
  option_name: string;
  option_value: string | null;
};

type PostRow = RowDataPacket & WpPost & {
  guid?: string | null;
  post_mime_type?: string | null;
};

type MetaRow = RowDataPacket & WpMetaRow;
type TermRow = RowDataPacket & WpTerm;
type ObjectTermRow = RowDataPacket & WpObjectTerm;
type TermMetaRow = RowDataPacket & WpTermMetaRow;

export class WordPressReadonlyClient {
  private readonly pool: mysql.Pool;
  private readonly tablePrefix: string;

  constructor(private readonly config: ImportConfig['wp']) {
    this.tablePrefix = config.tablePrefix;
    this.pool = mysql.createPool({
      ...(config.socketPath
        ? {
            socketPath: config.socketPath,
          }
        : {
            host: config.host,
            port: config.port,
          }),
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: 4,
      dateStrings: true,
      namedPlaceholders: false,
    });
  }

  async fetchSourceData() {
    const [siteUrl, objects, terms, termMetaRows] = await Promise.all([
      this.fetchSiteUrl(),
      this.fetchObjects(),
      this.fetchTerms(),
      this.fetchTermMeta(),
    ]);
    const objectIds = objects.map((post) => post.ID);
    const [metaRows, objectTerms] = await Promise.all([
      this.fetchPostMeta(objectIds),
      this.fetchObjectTerms(objectIds),
    ]);
    const metaByPostId = groupPostMeta(metaRows);
    const referencedAttachmentIds = collectReferencedAttachmentIds(metaByPostId);
    const attachmentsById = await this.fetchAttachments([...referencedAttachmentIds]);

    return {
      siteUrl,
      uploadsPath: this.config.uploadsPath,
      objects,
      metaByPostId,
      termsByObjectId: groupObjectTerms(objectTerms),
      termsById: new Map(terms.map((term) => [term.term_id, term])),
      termMetaById: groupTermMeta(termMetaRows),
      attachmentsById,
      referencedAttachmentIds,
    } satisfies WpSourceData;
  }

  async close() {
    await this.pool.end();
  }

  private async fetchSiteUrl() {
    const rows = await this.query<OptionRow[]>(
      `SELECT option_name, option_value FROM ${this.table('options')} WHERE option_name IN (?, ?)`,
      ['siteurl', 'home'],
    );
    const siteUrl = rows.find((row) => row.option_name === 'siteurl')?.option_value;
    const homeUrl = rows.find((row) => row.option_name === 'home')?.option_value;

    return normalizeString(siteUrl) ?? normalizeString(homeUrl);
  }

  private async fetchObjects() {
    const limitClause = this.config.importLimit ? 'LIMIT ?' : '';
    const params: unknown[] = [this.config.postType, 'publish'];

    if (this.config.importLimit) {
      params.push(this.config.importLimit);
    }

    const rows = await this.query<PostRow[]>(
      `SELECT ID, post_title, post_name, post_content, post_status, post_date, post_modified
       FROM ${this.table('posts')}
       WHERE post_type = ?
         AND post_status = ?
       ORDER BY ID ASC
       ${limitClause}`,
      params,
    );

    return rows.map((row) => ({
      ID: Number(row.ID),
      post_title: row.post_title,
      post_name: row.post_name,
      post_content: row.post_content,
      post_status: row.post_status,
      post_date: row.post_date,
      post_modified: row.post_modified,
    }));
  }

  private async fetchPostMeta(objectIds: number[]) {
    const rows: WpMetaRow[] = [];

    for (const ids of chunk(objectIds, 250)) {
      if (ids.length === 0) {
        continue;
      }

      const chunkRows = await this.query<MetaRow[]>(
        `SELECT post_id, meta_key, meta_value
         FROM ${this.table('postmeta')}
         WHERE post_id IN (?)`,
        [ids],
      );

      rows.push(
        ...chunkRows.map((row) => ({
          post_id: Number(row.post_id),
          meta_key: row.meta_key,
          meta_value: row.meta_value,
        })),
      );
    }

    return rows;
  }

  private async fetchObjectTerms(objectIds: number[]) {
    const rows: WpObjectTerm[] = [];

    for (const ids of chunk(objectIds, 250)) {
      if (ids.length === 0) {
        continue;
      }

      const chunkRows = await this.query<ObjectTermRow[]>(
        `SELECT tr.object_id, t.term_id, t.name, t.slug, tt.taxonomy, tt.parent
         FROM ${this.table('term_relationships')} tr
         INNER JOIN ${this.table('term_taxonomy')} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
         INNER JOIN ${this.table('terms')} t ON t.term_id = tt.term_id
         WHERE tr.object_id IN (?)
           AND tt.taxonomy IN (?, ?)
         ORDER BY tr.object_id ASC, tt.parent ASC, t.name ASC`,
        [ids, 'nedvizhimost', 'custom_tag-two'],
      );

      rows.push(
        ...chunkRows.map((row) => ({
          object_id: Number(row.object_id),
          term_id: Number(row.term_id),
          name: row.name,
          slug: row.slug,
          taxonomy: row.taxonomy,
          parent: Number(row.parent),
        })),
      );
    }

    return rows;
  }

  private async fetchTerms() {
    const rows = await this.query<TermRow[]>(
      `SELECT t.term_id, t.name, t.slug, tt.taxonomy, tt.parent
       FROM ${this.table('terms')} t
       INNER JOIN ${this.table('term_taxonomy')} tt ON tt.term_id = t.term_id
       WHERE tt.taxonomy IN (?, ?)
       ORDER BY tt.parent ASC, t.name ASC`,
      ['nedvizhimost', 'custom_tag-two'],
    );

    return rows.map((row) => ({
      term_id: Number(row.term_id),
      name: row.name,
      slug: row.slug,
      taxonomy: row.taxonomy,
      parent: Number(row.parent),
    }));
  }

  private async fetchTermMeta() {
    const rows = await this.query<TermMetaRow[]>(
      `SELECT term_id, meta_key, meta_value
       FROM ${this.table('termmeta')}`,
      [],
    );

    return rows.map((row) => ({
      term_id: Number(row.term_id),
      meta_key: row.meta_key,
      meta_value: row.meta_value,
    }));
  }

  private async fetchAttachments(attachmentIds: number[]) {
    const attachmentsById = new Map<number, WpAttachment>();

    for (const ids of chunk(attachmentIds, 250)) {
      if (ids.length === 0) {
        continue;
      }

      const [posts, metaRows] = await Promise.all([
        this.query<PostRow[]>(
          `SELECT ID, post_title, post_name, post_content, post_status, post_date, post_modified, post_mime_type, guid
           FROM ${this.table('posts')}
           WHERE ID IN (?)
             AND post_type = ?`,
          [ids, 'attachment'],
        ),
        this.query<MetaRow[]>(
          `SELECT post_id, meta_key, meta_value
           FROM ${this.table('postmeta')}
           WHERE post_id IN (?)
             AND meta_key = ?`,
          [ids, '_wp_attached_file'],
        ),
      ]);
      const attachedFileById = new Map(
        metaRows.map((row) => [Number(row.post_id), normalizeString(row.meta_value)]),
      );

      for (const post of posts) {
        const attachedFile = attachedFileById.get(Number(post.ID)) ?? null;
        const localPath = attachedFile ? resolveAttachmentPath(this.config.uploadsPath, attachedFile) : null;
        const fileStat = localPath ? await stat(localPath).catch(() => null) : null;

        attachmentsById.set(Number(post.ID), {
          ID: Number(post.ID),
          post_title: post.post_title,
          post_name: post.post_name,
          post_content: post.post_content,
          post_status: post.post_status,
          post_date: post.post_date,
          post_modified: post.post_modified,
          attachedFile,
          localPath,
          localExists: Boolean(fileStat?.isFile()),
          sizeBytes: fileStat?.isFile() ? fileStat.size : null,
          mimeType: normalizeString(post.post_mime_type ?? null),
          guid: normalizeString(post.guid ?? null),
        });
      }
    }

    return attachmentsById;
  }

  private async query<T extends RowDataPacket[]>(sql: string, params: unknown[]) {
    this.assertReadonlyQuery(sql);
    const [rows] = await this.pool.query<T>(sql, params);

    return rows;
  }

  private table(name: string) {
    return `\`${this.tablePrefix}${name}\``;
  }

  private assertReadonlyQuery(sql: string) {
    const normalizedSql = sql.trim().replace(/^\/\*[\s\S]*?\*\//u, '').trim().toLowerCase();

    if (!/^(select|show|describe|explain)\b/u.test(normalizedSql)) {
      throw new Error('WordPress client allows only read-only SQL queries');
    }
  }
}

function collectReferencedAttachmentIds(metaByPostId: Map<number, Map<string, string[]>>) {
  const ids = new Set<number>();

  for (const meta of metaByPostId.values()) {
    for (const [key, values] of meta.entries()) {
      if (!isPotentialAttachmentMetaKey(key)) {
        continue;
      }

      for (const value of values) {
        const attachmentId = parsePositiveInteger(value);

        if (attachmentId) {
          ids.add(attachmentId);
        }
      }
    }
  }

  return ids;
}

function isPotentialAttachmentMetaKey(key: string) {
  return (
    key === 'izobrazhenie_1' ||
    key === 'izobrazhenie_miniatyura' ||
    key === 'pdf_fajl' ||
    /(?:izobrazhenie|fajl|ikonka|kartinka|foto|pdf)/iu.test(key)
  );
}

function groupPostMeta(rows: WpMetaRow[]) {
  const result = new Map<number, Map<string, string[]>>();

  for (const row of rows) {
    let postMeta = result.get(row.post_id);

    if (!postMeta) {
      postMeta = new Map<string, string[]>();
      result.set(row.post_id, postMeta);
    }

    const values = postMeta.get(row.meta_key) ?? [];
    values.push(row.meta_value ?? '');
    postMeta.set(row.meta_key, values);
  }

  return result;
}

function groupObjectTerms(rows: WpObjectTerm[]) {
  const result = new Map<number, WpObjectTerm[]>();

  for (const row of rows) {
    const terms = result.get(row.object_id) ?? [];
    terms.push(row);
    result.set(row.object_id, terms);
  }

  return result;
}

function groupTermMeta(rows: WpTermMetaRow[]) {
  const result = new Map<number, Map<string, string[]>>();

  for (const row of rows) {
    let termMeta = result.get(row.term_id);

    if (!termMeta) {
      termMeta = new Map<string, string[]>();
      result.set(row.term_id, termMeta);
    }

    const values = termMeta.get(row.meta_key) ?? [];
    values.push(row.meta_value ?? '');
    termMeta.set(row.meta_key, values);
  }

  return result;
}

function resolveAttachmentPath(uploadsPath: string, attachedFile: string) {
  return isAbsolute(attachedFile) ? attachedFile : join(uploadsPath, attachedFile);
}

function parsePositiveInteger(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalizedValue = value.trim();

  if (!/^\d+$/u.test(normalizedValue)) {
    return null;
  }

  const parsed = Number(normalizedValue);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeString(value: string | null | undefined) {
  const normalizedValue = value?.trim();

  return normalizedValue || null;
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}
