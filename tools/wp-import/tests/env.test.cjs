const test = require('node:test');
const assert = require('node:assert/strict');

const { loadImportConfig } = require('../dist/env.js');

const envKeys = [
  'WP_DB_HOST',
  'WP_DB_PORT',
  'WP_DB_SOCKET',
  'WP_DB_USER',
  'WP_DB_PASSWORD',
  'WP_DB_NAME',
  'WP_TABLE_PREFIX',
  'WP_UPLOADS_PATH',
  'WP_IMPORT_PROFILE',
  'WP_POST_TYPE',
  'WP_IMPORT_LIMIT',
];

test('loadImportConfig uses selected profile post type instead of legacy WP_POST_TYPE override', () => {
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

  try {
    process.env.WP_DB_HOST = '127.0.0.1';
    process.env.WP_DB_PORT = '3306';
    process.env.WP_DB_SOCKET = '';
    process.env.WP_DB_USER = 'root';
    process.env.WP_DB_PASSWORD = 'root';
    process.env.WP_DB_NAME = 'local';
    process.env.WP_TABLE_PREFIX = 'wp_';
    process.env.WP_UPLOADS_PATH = '/tmp/uploads';
    process.env.WP_IMPORT_PROFILE = 'commercial';
    process.env.WP_POST_TYPE = 'nedvizhimosts';
    process.env.WP_IMPORT_LIMIT = '5';

    const config = loadImportConfig();

    assert.equal(config.wp.profileName, 'commercial');
    assert.equal(config.wp.postType, 'commercials');
    assert.deepEqual(config.wp.taxonomies, ['commercial', 'custom_tag-three']);
    assert.equal(config.wp.importFiles, false);
  } finally {
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
