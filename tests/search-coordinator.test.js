import { jest } from '@jest/globals';

import searchCoordinator, { SearchCoordinator } from '../lib/util/search-coordinator.js';

const SECRET_VALUES = [
  'rd-top-level-secret',
  'rd-nested-secret',
  'newznab-secret',
  'nntp-password',
  'file-server-password'
];

const USER_CONFIG = {
  DebridProvider: 'RealDebrid',
  DebridApiKey: SECRET_VALUES[0],
  DebridServices: [{ provider: 'RealDebrid', apiKey: SECRET_VALUES[1] }],
  NewznabApiKey: SECRET_VALUES[2],
  NntpPassword: SECRET_VALUES[3],
  FileServerPassword: SECRET_VALUES[4],
  Scrapers: ['jackett'],
  IndexerScrapers: [],
  Languages: ['spanish']
};

describe('SearchCoordinator secret handling', () => {
  let coordinator;
  let errorSpy;
  let logSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    coordinator = new SearchCoordinator();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    coordinator.shutdown();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    jest.useRealTimers();
  });

  afterAll(() => {
    searchCoordinator.shutdown();
  });

  test('timeout errors and logs never contain user credentials', async () => {
    let timeoutError;
    const search = coordinator.executeSearch(
      'realdebrid',
      () => new Promise(() => {}),
      'movie',
      'tt15398776',
      USER_CONFIG
    ).catch(error => {
      timeoutError = error;
    });

    await jest.advanceTimersByTimeAsync(coordinator.searchTimeout);
    await search;

    expect(timeoutError).toBeInstanceOf(Error);
    expect(timeoutError.message).toBe(`Search timeout after ${coordinator.searchTimeout}ms`);
    expect(coordinator.getStats().ongoingSearches).toBe(0);

    const observableOutput = JSON.stringify({
      error: timeoutError.message,
      logs: errorSpy.mock.calls
    });
    for (const secret of SECRET_VALUES) {
      expect(observableOutput).not.toContain(secret);
    }
  });

  test('cache reuse logs only the allowlisted search context', async () => {
    const searchKey = `movie:tt15398776:${JSON.stringify(USER_CONFIG)}`;
    coordinator.cacheScraperResults(searchKey, ['cached']);

    await coordinator.executeSearch(
      'realdebrid',
      async () => ['fresh'],
      'movie',
      'tt15398776',
      USER_CONFIG
    );

    const observableOutput = JSON.stringify(logSpy.mock.calls);
    expect(observableOutput).toContain('Reusing cached scraper results');
    expect(observableOutput).toContain('tt15398776');
    for (const secret of SECRET_VALUES) {
      expect(observableOutput).not.toContain(secret);
    }
  });
});
