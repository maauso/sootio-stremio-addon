/**
 * Search coordinator to manage and coordinate searches across multiple debrid services
 * to avoid duplicate work when multiple services run simultaneously.
 *
 * Optimizations:
 * - Deduplicates simultaneous searches for the same content
 * - Shares scraper results across services (no need to scrape twice)
 * - Timeout protection to prevent hanging
 */

export class SearchCoordinator {
  constructor() {
    // Store ongoing searches to avoid duplicate work
    this.ongoingSearches = new Map();
    // Store scraper results to share across services
    this.scraperCache = new Map();
    this.scraperCacheTTL = 600000; // 10 minute cache for scraper results
    this.scraperCacheMaxSize = 5000; // Max entries to prevent unbounded growth
    const configuredTimeout = parseInt(process.env.SEARCH_TIMEOUT_MS || '15000', 10);
    // Reduced floor from 20s to 8s for faster fail-fast behavior
    this.searchTimeout = Math.max(8000, Number.isFinite(configuredTimeout) ? configuredTimeout : 15000);
    const configuredSlow = parseInt(process.env.SEARCH_SLOW_THRESHOLD_MS || '0', 10);
    this.slowThresholdMs = configuredSlow > 0
      ? configuredSlow
      : Math.min(15000, Math.floor(this.searchTimeout * 0.7));
    console.log(`[SEARCH COORD] Using search timeout: ${this.searchTimeout}ms`);
    this.cleanupIntervalId = null;

    // Start periodic cleanup to remove expired entries
    this.startCleanupInterval();
  }

  /**
   * Execute a coordinated search to avoid duplicate work
   * @param {string} serviceName - Name of the service (e.g., 'realdebrid', 'torbox', etc.)
   * @param {Function} searchFunction - Function that performs the actual search
   * @param {string} type - Content type ('movie' or 'series')
   * @param {string} id - Content ID (e.g., 'tt1234567:s01:e01')
   * @param {Object} userConfig - User configuration
   * @returns {Promise<any>} Search results
   */
  async executeSearch(serviceName, searchFunction, type, id, userConfig) {
    const searchKey = `${type}:${id}:${JSON.stringify(userConfig)}`;
    const serviceKey = `${serviceName}:${searchKey}`;
    const safeContext = {
      serviceName,
      type,
      id,
      provider: userConfig?.DebridProvider,
      scrapers: Array.isArray(userConfig?.Scrapers) ? userConfig.Scrapers : [],
      indexerScrapers: Array.isArray(userConfig?.IndexerScrapers) ? userConfig.IndexerScrapers : [],
      languages: Array.isArray(userConfig?.Languages) ? userConfig.Languages : []
    };

    // Check if this specific service search is already in progress
    if (this.ongoingSearches.has(serviceKey)) {
      // Wait for the existing search to complete
      try {
        return await this.ongoingSearches.get(serviceKey);
      } catch (error) {
        // If the existing search failed, remove it and start a new one
        this.ongoingSearches.delete(serviceKey);
        throw error;
      }
    }

    // Check scraper cache - can reuse scraper results across services
    const scraperCacheKey = searchKey;
    const cachedScrapers = this.scraperCache.get(scraperCacheKey);
    if (cachedScrapers && Date.now() < cachedScrapers.expires) {
      console.log(`[SEARCH COORD] Reusing cached scraper results: ${JSON.stringify(safeContext)}`);
      // Still execute the search function but with cached scraper data
      // The search function handles service-specific cache checking
    }

    const searchPromise = this._executeWithTimeout(searchFunction, serviceKey, safeContext);

    // Store the promise to prevent duplicate searches for the same service
    this.ongoingSearches.set(serviceKey, searchPromise);

    try {
      const results = await searchPromise;
      return results;
    } finally {
      // Clean up the ongoing search after completion or failure
      this.ongoingSearches.delete(serviceKey);
    }
  }

  /**
   * Cache scraper results so multiple services don't scrape the same content
   */
  cacheScraperResults(searchKey, results) {
    this.scraperCache.set(searchKey, {
      results,
      expires: Date.now() + this.scraperCacheTTL
    });
  }

  /**
   * Get cached scraper results
   */
  getCachedScraperResults(searchKey) {
    const cached = this.scraperCache.get(searchKey);
    if (cached && Date.now() < cached.expires) {
      return cached.results;
    }
    return null;
  }

  _executeWithTimeout(searchFunction, serviceKey, context = {}) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const contextJson = JSON.stringify(context);
      const timeoutId = setTimeout(() => {
        this.ongoingSearches.delete(serviceKey);
        const duration = Date.now() - startTime;
        if (duration >= this.slowThresholdMs) {
          console.error(`[SEARCH COORD] Search timeout after ${duration}ms: ${contextJson}`);
        }
        reject(new Error(`Search timeout after ${this.searchTimeout}ms`));
      }, this.searchTimeout);

      searchFunction()
        .then(result => {
          clearTimeout(timeoutId);
          const duration = Date.now() - startTime;
          if (duration >= this.slowThresholdMs) {
            console.error(`[SEARCH COORD] Slow search completed in ${duration}ms: ${contextJson}`);
          }
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          const duration = Date.now() - startTime;
          if (duration >= this.slowThresholdMs) {
            console.error(`[SEARCH COORD] Slow search failed after ${duration}ms: ${contextJson} (${error.message})`);
          }
          reject(error);
        });
    });
  }

  /**
   * Start periodic cleanup interval to remove expired cache entries
   * MEMORY LEAK FIX: Without this, expired entries stay in memory forever
   */
  startCleanupInterval() {
    // Clean up every minute
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupExpiredCache();
    }, 60000);
  }

  /**
   * Clean up expired entries from scraperCache
   */
  cleanupExpiredCache() {
    const now = Date.now();
    let removed = 0;

    for (const [key, value] of this.scraperCache.entries()) {
      if (now >= value.expires) {
        this.scraperCache.delete(key);
        removed++;
      }
    }

    // If still over size limit after removing expired, remove oldest entries
    if (this.scraperCache.size > this.scraperCacheMaxSize) {
      const entriesToRemove = this.scraperCache.size - this.scraperCacheMaxSize;
      const keysToRemove = Array.from(this.scraperCache.keys()).slice(0, entriesToRemove);

      for (const key of keysToRemove) {
        this.scraperCache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[SEARCH COORD] Cleaned up ${removed} cache entries (current size: ${this.scraperCache.size})`);
    }
  }

  getStats() {
    return {
      ongoingSearches: this.ongoingSearches.size,
      scraperCache: this.scraperCache.size,
      scraperCacheTtlMs: this.scraperCacheTTL,
      scraperCacheMaxSize: this.scraperCacheMaxSize,
      searchTimeoutMs: this.searchTimeout,
      slowThresholdMs: this.slowThresholdMs
    };
  }

  clearCaches(reason = 'manual') {
    const before = this.scraperCache.size;
    this.scraperCache.clear();
    console.error(`[SEARCH COORD] Cleared scraper cache (${before} entries) due to ${reason}`);
    return { cleared: before };
  }

  /**
   * Shutdown method to clean up resources
   */
  shutdown() {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
      console.log('[SEARCH COORD] Cleanup interval stopped');
    }

    // Clear all caches
    this.scraperCache.clear();
    this.ongoingSearches.clear();
  }
}

// Create a singleton instance
const searchCoordinator = new SearchCoordinator();

export default searchCoordinator;
