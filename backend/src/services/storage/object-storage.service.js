'use strict';

/**
 * 私有对象存储抽象。
 *
 * 默认 local 模式把对象保存到 backend/data/objects；s3 模式兼容 AWS S3、MinIO 与
 * 支持 SigV4 的 OSS endpoint。业务层只使用 opaque object key，浏览器下载始终
 * 经由后端归属鉴权，不产生公开 URL。
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const config = require('../../config');
const { logEvent } = require('../observability/observability.service');

const SAFE_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,510}$/;
let singleton = null;

function normalizeKey(value) {
  const key = String(value || '').replace(/^\/+/, '');
  if (!key || !SAFE_KEY_RE.test(key) || key.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return '';
  return key;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value ?? ''), 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, encoding).digest();
}

function awsSigningKey(secret, date, region, service) {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, 'aws4_request');
}

function isoDate(now = new Date()) {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: stamp, date: stamp.slice(0, 8) };
}

function xmlValue(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : '';
}

class LocalObjectStorage {
  constructor({ rootDir } = {}) {
    this.rootDir = path.resolve(rootDir || config.storage?.localDir || path.join(__dirname, '../../data/objects'));
  }

  _path(key) {
    const normalized = normalizeKey(key);
    if (!normalized) return '';
    const target = path.resolve(this.rootDir, normalized);
    return target.startsWith(`${this.rootDir}${path.sep}`) ? target : '';
  }

  getHealth() {
    try {
      fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
      fs.accessSync(this.rootDir, fs.constants.R_OK | fs.constants.W_OK);
      return { status: 'ready', backend: 'local', rootDir: this.rootDir };
    } catch (error) {
      return { status: 'unavailable', backend: 'local', rootDir: this.rootDir, lastError: error.message };
    }
  }

  async probe() {
    return this.getHealth();
  }

  async putObject(key, body, options = {}) {
    const target = this._path(key);
    if (!target) throw new Error('对象 key 无效');
    const buffer = toBuffer(body);
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.promises.writeFile(temp, buffer, { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temp, target);
    await fs.promises.chmod(target, 0o600).catch(() => {});
    return { key: normalizeKey(key), size: buffer.length, contentType: options.contentType || 'application/octet-stream', etag: sha256(buffer) };
  }

  async getObject(key) {
    const target = this._path(key);
    if (!target) return null;
    try {
      const [body, stat] = await Promise.all([fs.promises.readFile(target), fs.promises.stat(target)]);
      return { key: normalizeKey(key), body, size: stat.size, lastModified: stat.mtime.toISOString(), contentType: 'application/octet-stream', etag: sha256(body) };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async deleteObject(key) {
    const target = this._path(key);
    if (!target) return false;
    try { await fs.promises.unlink(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async exists(key) {
    return Boolean(await this.getObject(key));
  }

  async list(prefix = '') {
    const normalizedPrefix = prefix ? normalizeKey(String(prefix).replace(/\/+$/, '')) : '';
    if (prefix && !normalizedPrefix) return [];
    const root = normalizedPrefix
      ? path.resolve(this.rootDir, normalizedPrefix)
      : this.rootDir;
    if (!root.startsWith(`${this.rootDir}${path.sep}`) && root !== this.rootDir) return [];
    if (!root) return [];
    const output = [];
    const walk = async (directory) => {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const stat = await fs.promises.stat(full).catch(() => null);
          if (!stat) continue;
          output.push({ key: path.relative(this.rootDir, full).split(path.sep).join('/'), size: stat.size, lastModified: stat.mtime.toISOString() });
        }
      }
    };
    await walk(root);
    return output;
  }
}

class S3ObjectStorage {
  constructor(options = {}) {
    const s3 = options.s3 || config.storage?.s3 || {};
    this.endpoint = String(s3.endpoint || '').replace(/\/$/, '');
    this.region = s3.region || 'us-east-1';
    this.bucket = s3.bucket || '';
    this.accessKeyId = s3.accessKeyId || '';
    this.secretAccessKey = s3.secretAccessKey || '';
    this.forcePathStyle = s3.forcePathStyle !== false;
    this.timeoutMs = Math.max(Number(s3.timeoutMs) || 5000, 500);
    this._health = this.configured
      ? { status: 'starting', backend: 's3', bucket: this.bucket, endpoint: this.endpoint, lastError: null }
      : { status: 'unavailable', backend: 's3', lastError: 'S3 配置不完整' };
  }

  get configured() {
    return Boolean(this.endpoint && this.bucket && this.accessKeyId && this.secretAccessKey);
  }

  getHealth() {
    return { ...this._health };
  }

  async probe() {
    if (!this.configured) return this.getHealth();
    try {
      const result = await this._request('GET', '', Buffer.alloc(0), {}, 'list-type=2&max-keys=1');
      if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`S3 探测失败: HTTP ${result.statusCode}`);
      this._health = { status: 'ready', backend: 's3', bucket: this.bucket, endpoint: this.endpoint, lastError: null };
    } catch (error) {
      this._health = { status: 'unavailable', backend: 's3', bucket: this.bucket, endpoint: this.endpoint, lastError: error.message };
      logEvent('warn', 'object_storage_probe_failed', { backend: 's3', error: error.message });
    }
    return this.getHealth();
  }

  _url(key = '', query = '') {
    const endpoint = new URL(this.endpoint);
    const normalized = normalizeKey(key);
    const encodedKey = normalized.split('/').map(encodeURIComponent).join('/');
    const bucketPath = this.forcePathStyle ? `/${encodeURIComponent(this.bucket)}` : '';
    if (!this.forcePathStyle) endpoint.hostname = `${this.bucket}.${endpoint.hostname}`;
    return new URL(`${bucketPath}/${encodedKey}${query ? `?${query}` : ''}`, endpoint);
  }

  _signedRequest(method, key, body = Buffer.alloc(0), extraHeaders = {}, query = '') {
    if (!this.configured) throw new Error('S3 配置不完整');
    const url = this._url(key, query);
    const { amzDate, date } = isoDate();
    const payloadHash = sha256(body);
    const headers = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(Object.entries(extraHeaders).map(([name, value]) => [name.toLowerCase(), String(value)])),
    };
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name].trim()}\n`).join('');
    const canonicalQuery = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
    const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders, signedNames.join(';'), payloadHash].join('\n');
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const signature = crypto.createHmac('sha256', awsSigningKey(this.secretAccessKey, date, this.region, 's3')).update(stringToSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`;
    return { url, headers, body };
  }

  _request(method, key, body, headers, query) {
    const signed = this._signedRequest(method, key, body, headers, query);
    const client = signed.url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.request(signed.url, { method, headers: signed.headers, timeout: this.timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(new Error(`S3 请求超时（${this.timeoutMs}ms）`)));
      req.on('error', reject);
      if (body?.length) req.write(body);
      req.end();
    });
  }

  async putObject(key, body, options = {}) {
    const buffer = toBuffer(body);
    const result = await this._request('PUT', key, buffer, { 'content-type': options.contentType || 'application/octet-stream' });
    if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`S3 写入失败: HTTP ${result.statusCode}`);
    return { key: normalizeKey(key), size: buffer.length, contentType: options.contentType || 'application/octet-stream', etag: String(result.headers.etag || '').replace(/"/g, '') };
  }

  async getObject(key) {
    const result = await this._request('GET', key, Buffer.alloc(0));
    if (result.statusCode === 404) return null;
    if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`S3 读取失败: HTTP ${result.statusCode}`);
    return { key: normalizeKey(key), body: result.body, size: Number(result.headers['content-length']) || result.body.length, contentType: result.headers['content-type'] || 'application/octet-stream', lastModified: result.headers['last-modified'] || null, etag: String(result.headers.etag || '').replace(/"/g, '') };
  }

  async deleteObject(key) {
    const result = await this._request('DELETE', key, Buffer.alloc(0));
    if (result.statusCode === 404) return false;
    if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`S3 删除失败: HTTP ${result.statusCode}`);
    return true;
  }

  async exists(key) {
    const result = await this._request('HEAD', key, Buffer.alloc(0));
    if (result.statusCode === 404) return false;
    if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`S3 HEAD 失败: HTTP ${result.statusCode}`);
    return true;
  }

  async list(prefix = '') {
    const query = `list-type=2&prefix=${encodeURIComponent(normalizeKey(prefix))}`;
    const result = await this._request('GET', '', Buffer.alloc(0), {}, query);
    if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`S3 列举失败: HTTP ${result.statusCode}`);
    const xml = result.body.toString('utf8');
    return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => ({
      key: xmlValue(match[1], 'Key'),
      size: Number(xmlValue(match[1], 'Size')) || 0,
      lastModified: xmlValue(match[1], 'LastModified') || null,
    }));
  }
}

function createObjectStorage(options = {}) {
  const backend = options.backend || config.storage?.backend || 'local';
  if (backend === 's3') return new S3ObjectStorage(options);
  return new LocalObjectStorage(options);
}

function getObjectStorage() {
  if (!singleton) singleton = createObjectStorage();
  return singleton;
}

function resetObjectStorageForTests() {
  singleton = null;
}

module.exports = {
  LocalObjectStorage,
  S3ObjectStorage,
  createObjectStorage,
  getObjectStorage,
  resetObjectStorageForTests,
  normalizeKey,
};
