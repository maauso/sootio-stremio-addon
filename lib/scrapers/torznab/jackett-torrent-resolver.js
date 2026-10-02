import axios from 'axios';
import parseTorrent from 'parse-torrent';

const INFO_HASH_PATTERN = /^[a-f0-9]{40}$/i;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_DOWNLOADS = 30;
const DEFAULT_CONCURRENCY = 2;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

const torrentRequester = axios.create({ proxy: false });
const linkCache = new Map();

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeInfoHash(value) {
    const hash = String(value || '').trim();
    return INFO_HASH_PATTERN.test(hash) ? hash.toLowerCase() : null;
}

export async function extractInfoHashFromMagnet(value) {
    const magnet = String(value || '').trim();
    if (!magnet.toLowerCase().startsWith('magnet:?')) return null;

    try {
        return normalizeInfoHash((await parseTorrent(magnet))?.infoHash);
    } catch {
        return null;
    }
}

export function validateJackettDownloadUrl(value, baseUrl) {
    const base = new URL(baseUrl);
    const candidate = new URL(value, base);

    if (!['http:', 'https:'].includes(base.protocol)) {
        throw new Error('Jackett base URL must use HTTP or HTTPS');
    }
    if (candidate.origin !== base.origin) {
        throw new Error('Torrent download URL is not served by Jackett');
    }
    if (candidate.username || candidate.password) {
        throw new Error('Torrent download URL must not contain userinfo');
    }
    if (!candidate.pathname.startsWith('/dl/')) {
        throw new Error('Torrent download URL is outside the Jackett download endpoint');
    }

    return candidate;
}

function pruneCache(now = Date.now()) {
    for (const [key, entry] of linkCache) {
        if (entry.expiresAt <= now) linkCache.delete(key);
    }

    while (linkCache.size > CACHE_MAX_ENTRIES) {
        const oldestKey = linkCache.keys().next().value;
        if (oldestKey === undefined) break;
        linkCache.delete(oldestKey);
    }
}

async function parseTorrentPayload(data, contentType = '') {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (buffer.length === 0) throw new Error('Jackett returned an empty torrent response');

    const type = String(contentType || '').toLowerCase();
    const prefix = buffer.subarray(0, 256).toString('utf8').trimStart();
    if (type.includes('text/html') || prefix.startsWith('<!DOCTYPE') || prefix.startsWith('<html')) {
        throw new Error('Jackett returned HTML instead of a torrent');
    }

    if (prefix.toLowerCase().startsWith('magnet:?')) {
        const hash = await extractInfoHashFromMagnet(buffer.toString('utf8').trim());
        if (!hash) throw new Error('Jackett returned an invalid magnet URI');
        return hash;
    }

    if (buffer[0] !== 0x64) {
        throw new Error('Jackett response is not a bencoded torrent');
    }

    try {
        const hash = normalizeInfoHash((await parseTorrent(buffer))?.infoHash);
        if (!hash) throw new Error('Torrent does not contain a v1 infohash');
        return hash;
    } catch (error) {
        throw new Error(`Jackett returned an invalid torrent: ${error.message}`);
    }
}

export async function fetchInfoHashFromJackettLink(link, options = {}) {
    const {
        baseUrl,
        requester = torrentRequester,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxBytes = DEFAULT_MAX_BYTES,
        signal
    } = options;

    const url = validateJackettDownloadUrl(link, baseUrl);
    const cacheKey = url.toString();
    const now = Date.now();
    pruneCache(now);

    const cached = linkCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.promise;

    const boundedTimeout = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
    const boundedSize = positiveInteger(maxBytes, DEFAULT_MAX_BYTES);
    const promise = requester.get(cacheKey, {
        responseType: 'arraybuffer',
        timeout: boundedTimeout,
        signal,
        maxRedirects: 0,
        maxContentLength: boundedSize,
        maxBodyLength: boundedSize,
        validateStatus: status => status >= 200 && status < 300,
        headers: {
            Accept: 'application/x-bittorrent, application/octet-stream;q=0.9, text/plain;q=0.5',
            'User-Agent': 'Sootio/1.9 Jackett torrent resolver'
        }
    }).then(async response => {
        const data = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || []);
        if (data.length > boundedSize) throw new Error('Jackett torrent response exceeds the size limit');
        return await parseTorrentPayload(data, response.headers?.['content-type']);
    });

    linkCache.set(cacheKey, { promise, expiresAt: now + CACHE_TTL_MS });
    promise.catch(() => linkCache.delete(cacheKey));
    return promise;
}

export async function resolveJackettResult(result, options = {}) {
    if (!result || typeof result !== 'object') return null;

    const existingHash = normalizeInfoHash(result.InfoHash);
    if (existingHash) return { ...result, InfoHash: existingHash };

    const magnetHash = (await extractInfoHashFromMagnet(result.MagnetUri))
        || (await extractInfoHashFromMagnet(result.Link));
    if (magnetHash) return { ...result, InfoHash: magnetHash };

    if (!result.Link) return null;
    const resolvedHash = await fetchInfoHashFromJackettLink(result.Link, options);
    return { ...result, InfoHash: resolvedHash };
}

export async function resolveJackettResults(results, options = {}) {
    if (!Array.isArray(results)) return [];

    const maxDownloads = positiveInteger(options.maxDownloads, DEFAULT_MAX_DOWNLOADS);
    const concurrency = Math.min(
        positiveInteger(options.concurrency, DEFAULT_CONCURRENCY),
        maxDownloads
    );
    const resolved = new Array(results.length);
    const resolveQueue = [];
    let queuedDownloads = 0;

    for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const existingHash = normalizeInfoHash(result?.InfoHash);
        const hasMagnet = String(result?.MagnetUri || '').toLowerCase().startsWith('magnet:?')
            || String(result?.Link || '').toLowerCase().startsWith('magnet:?');

        if (existingHash) {
            resolved[index] = { ...result, InfoHash: existingHash };
        } else if (hasMagnet) {
            resolveQueue.push({ index, result });
        } else if (result?.Link && queuedDownloads < maxDownloads) {
            resolveQueue.push({ index, result });
            queuedDownloads += 1;
        }
    }

    let cursor = 0;
    async function worker() {
        while (cursor < resolveQueue.length) {
            const item = resolveQueue[cursor];
            cursor += 1;
            try {
                resolved[item.index] = await resolveJackettResult(item.result, options);
            } catch (error) {
                options.onError?.(error, item.result);
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return resolved.filter(Boolean);
}
