class Wayback {
    #baseApiUrl = 'https://archive.org/wayback/available';
    #baseSaveUrl = 'https://web.archive.org/save/_embed/';

    #connectionTimeoutMs;
    #headers;
    #cache = new Map();
    #cacheTTL;
    #gcInterval;
    #cleanupInterval;

    constructor({
        connectionTimeoutMs = 9000,
        cacheTTL = 86400,
        gcInterval = 3600,
        headers = undefined
    } = {}) {
        this.#connectionTimeoutMs = connectionTimeoutMs;
        this.#headers = headers;

        this.#cacheTTL = cacheTTL ? Math.max(parseInt(cacheTTL) * 1000, 3600 * 1000) : 0;
        this.#gcInterval = Math.max(parseInt(gcInterval) * 1000, 3600 * 1000);

        this.#cleanupInterval = setInterval(() => this.#cleanupCache(), this.#gcInterval).unref();
    }

    destroy() {
        clearInterval(this.#cleanupInterval);
        this.#cache.clear();
    }

    async isArchived(url, resolveRedirects = true) {
        const cachedEntry = this.#getCache(url);
        if (cachedEntry) {
            return cachedEntry;
        }

        try {
            if (resolveRedirects) {
                url = await this.getFinalRedirectUrl(url);
            }

            const response = await this.#fetch(`${this.#baseApiUrl}?timestamp=${this.#currentTimestamp()}&url=${encodeURIComponent(url.replace(/^https?:\/\//, ''))}`, { method: 'GET' });
            if (!response) {
                return null;
            }

            if (response.ok) {
                const data = await response.json();
                const closest = data.archived_snapshots?.closest || null;

                if (closest?.url && closest?.timestamp) {
                    const snapshot = { url: closest.url, timestamp: closest.timestamp };
                    this.#setCache(url, snapshot);

                    return snapshot;
                }
            }

            return response.status;
        } catch (e) {
            console.error(e);
        }

        return null;
    }

    async saveUrl(url) {
        try {
            const response = await this.#fetch(`${this.#baseSaveUrl}${url}`, { method: 'GET', redirect: 'manual' });
            if (!response) {
                return null;
            }

            if (response.ok || response.status === 301 || response.status === 302) {
                const archiveUrl = response.headers.get('Location');
                if (archiveUrl) {
                    const timestamp = archiveUrl.match(/(\d{14})/);
                    const formattedTimestamp = timestamp ? timestamp[0] : this.#currentTimestamp();

                    const snapshot = { url: archiveUrl, timestamp: formattedTimestamp };
                    this.#setCache(url, snapshot);

                    return snapshot;
                }
            }

            return response.status;
        } catch (e) {
            console.error(e);
        }

        return null;
    }

    async saveOutdatedUrl(url, maxAgeDays = 30, resolveRedirects = true) {
        const snapshot = await this.isArchived(url, resolveRedirects);
        if (!snapshot || !snapshot.timestamp) {
            return this.saveUrl(url);
        }

        try {
            const lastArchived = new Date(
                snapshot.timestamp.substring(0, 4) +
                '-' + snapshot.timestamp.substring(4, 6) +
                '-' + snapshot.timestamp.substring(6, 8)
            );

            const diffDays = (Date.now() - lastArchived.getTime()) / (1000 * 60 * 60 * 24);
            if (diffDays > maxAgeDays) {
                return this.saveUrl(url);
            }

            return snapshot;
        } catch (e) {
            console.error(e);
        }

        return this.saveUrl(url);
    }

    async getFinalRedirectUrl(url) {
        try {
            const response = await this.#fetch(url, { method: 'HEAD', redirect: 'follow' });
            return response?.url || url;
        } catch (e) {
            console.error(e);
        }

        return url;
    }

    async #fetch(url, options = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.#connectionTimeoutMs);

        try {
            const response = await fetch(url, { ...options, headers: this.#headers, signal: controller.signal });
            clearTimeout(timeoutId);
            return response;
        } catch (e) {
            clearTimeout(timeoutId);
            if (e.name !== 'AbortError' && e.name !== 'TypeError') {
                throw e;
            }
            console.warn(`${url} - ${e.message}`);
        }
        return null;
    }

    #currentTimestamp() {
        return new Date(Date.now() - 1000).toISOString().replace(/[-:T]/g, '').split('.')[0];
    }

    #getCache(url) {
        if (this.#cacheTTL) {
            const entry = this.#cache.get(url);
            if (entry) {
                if ((Date.now() - entry.timestamp) >= this.#cacheTTL) {
                    this.#cache.delete(url);
                } else {
                    return entry.data;
                }
            }
        }

        return undefined;
    }

    #setCache(url, snapshot) {
        if (this.#cacheTTL) {
            this.#cache.set(url, {
                data: snapshot,
                cacheTimestamp: Date.now()
            });
        }
    }

    #cleanupCache() {
        if (this.#cacheTTL) {
            const now = Date.now();
            for (const [url, entry] of this.#cache) {
                if (now - entry.cacheTimestamp >= this.#cacheTTL) {
                    this.#cache.delete(url);
                }
            }
        }
    }
}

export default Wayback;
export { Wayback };
