import { createHash } from 'crypto';
import { jest } from '@jest/globals';

import {
    extractInfoHashFromMagnet,
    fetchInfoHashFromJackettLink,
    normalizeInfoHash,
    resolveJackettResult,
    resolveJackettResults,
    validateJackettDownloadUrl
} from '../lib/scrapers/torznab/jackett-torrent-resolver.js';

const BASE_URL = 'http://jackett:9117';
const KNOWN_HASH = 'd2474e86c95b19b8bcfdb92bc12c9d44667cfa36';

function createKnownTorrent() {
    const info = Buffer.from('d6:lengthi1e4:name1:x12:piece lengthi16384e6:pieces20:12345678901234567890e');
    return {
        data: Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]),
        infoHash: createHash('sha1').update(info).digest('hex')
    };
}

describe('Jackett torrent resolver', () => {
    test('normalizes a valid v1 infohash and rejects invalid values', () => {
        expect(normalizeInfoHash(KNOWN_HASH.toUpperCase())).toBe(KNOWN_HASH);
        expect(normalizeInfoHash('synthetic')).toBeNull();
    });

    test('extracts a BTIH from a magnet URI', async () => {
        const magnet = `magnet:?xt=urn:btih:${KNOWN_HASH}&dn=test`;
        expect(await extractInfoHashFromMagnet(magnet)).toBe(KNOWN_HASH);
    });

    test('keeps an existing valid hash without downloading', async () => {
        const requester = { get: jest.fn() };
        const result = await resolveJackettResult(
            { Title: 'Existing', InfoHash: KNOWN_HASH.toUpperCase() },
            { baseUrl: BASE_URL, requester }
        );
        expect(result.InfoHash).toBe(KNOWN_HASH);
        expect(requester.get).not.toHaveBeenCalled();
    });

    test('computes the v1 infohash from a known torrent payload', async () => {
        const torrent = createKnownTorrent();
        const requester = {
            get: jest.fn().mockResolvedValue({
                data: torrent.data,
                headers: { 'content-type': 'application/x-bittorrent' }
            })
        };

        const hash = await fetchInfoHashFromJackettLink(
            `${BASE_URL}/dl/test/?file=known`,
            { baseUrl: BASE_URL, requester }
        );
        expect(hash).toBe(torrent.infoHash);
    });

    test('rejects HTML and URLs outside the Jackett download endpoint', async () => {
        const requester = {
            get: jest.fn().mockResolvedValue({
                data: Buffer.from('<!DOCTYPE html><html>error</html>'),
                headers: { 'content-type': 'text/html' }
            })
        };

        await expect(fetchInfoHashFromJackettLink(
            `${BASE_URL}/dl/test/?file=html`,
            { baseUrl: BASE_URL, requester }
        )).rejects.toThrow('HTML');

        expect(() => validateJackettDownloadUrl('http://example.com/file.torrent', BASE_URL))
            .toThrow('not served by Jackett');
        expect(() => validateJackettDownloadUrl(`${BASE_URL}/api/v2.0/server/config`, BASE_URL))
            .toThrow('outside the Jackett download endpoint');
    });

    test('omits an individual failure without blocking successful results', async () => {
        const torrent = createKnownTorrent();
        const requester = {
            get: jest.fn(async url => {
                if (url.includes('bad')) {
                    return {
                        data: Buffer.from('<html>bad</html>'),
                        headers: { 'content-type': 'text/html' }
                    };
                }
                return {
                    data: torrent.data,
                    headers: { 'content-type': 'application/x-bittorrent' }
                };
            })
        };
        const errors = [];
        const results = await resolveJackettResults([
            { Title: 'Good', Link: `${BASE_URL}/dl/test/?file=good` },
            { Title: 'Bad', Link: `${BASE_URL}/dl/test/?file=bad` }
        ], {
            baseUrl: BASE_URL,
            requester,
            concurrency: 1,
            onError: error => errors.push(error.message)
        });

        expect(results).toHaveLength(1);
        expect(results[0].Title).toBe('Good');
        expect(results[0].InfoHash).toBe(torrent.infoHash);
        expect(errors).toHaveLength(1);
    });
});
