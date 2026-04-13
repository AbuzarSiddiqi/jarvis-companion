const https = require('https');
const fs = require('fs');
const path = require('path');

/**
 * JSONBin Cloud Sync
 * Shared data store between the local Jarvis app and the cloud companion bot.
 * Both systems read/write to the same JSONBin, so tasks, routine, and logs
 * stay in sync whether you're using Telegram from your Mac or with it off.
 *
 * JSONBin API Docs: https://jsonbin.io
 */

const JSONBIN_API = 'api.jsonbin.io';
const MASTER_KEY = process.env.JSONBIN_KEY;
const BIN_ID_FILE = path.join(__dirname, '.jsonbin-id');

function request(method, path, body, key) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const options = {
            hostname: JSONBIN_API,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': key,
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
            }
        };

        const req = https.request(options, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(raw));
                } catch (e) {
                    reject(new Error(`Invalid JSON response: ${raw.substring(0, 100)}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (data) req.write(data);
        req.end();
    });
}

class CloudSync {
    constructor() {
        this.binId = null;
        this.masterKey = MASTER_KEY;
        this.lastFetch = null;
        this.cacheMs = 30000; // 30s cache to avoid hammering API
        this.cachedData = null;
    }

    setBinId(id) {
        this.binId = id;
        fs.writeFileSync(BIN_ID_FILE, id);
    }

    loadBinId() {
        if (this.binId) return this.binId;
        if (fs.existsSync(BIN_ID_FILE)) {
            this.binId = fs.readFileSync(BIN_ID_FILE, 'utf8').trim();
            return this.binId;
        }
        return null;
    }

    /** Create a new bin with initial data. Returns bin ID. */
    async createBin(initialData) {
        const key = this.masterKey;
        if (!key) throw new Error('JSONBIN_KEY not set');

        console.log('[Sync] Creating new JsonBin...');
        const result = await request('POST', '/v3/b', initialData, key);

        if (!result.metadata?.id) {
            throw new Error('Failed to create bin: ' + JSON.stringify(result).substring(0, 200));
        }

        const id = result.metadata.id;
        this.setBinId(id);
        console.log(`[Sync] Bin created: ${id}`);
        return id;
    }

    /** Read the latest data from the bin */
    async read() {
        const key = this.masterKey;
        if (!key) throw new Error('JSONBIN_KEY not set');

        const id = this.loadBinId();
        if (!id) throw new Error('No bin ID — run setup first');

        // Cache
        if (this.cachedData && this.lastFetch && (Date.now() - this.lastFetch < this.cacheMs)) {
            return this.cachedData;
        }

        const result = await request('GET', `/v3/b/${id}/latest`, null, key);
        this.cachedData = result.record;
        this.lastFetch = Date.now();
        return result.record;
    }

    /** Write data to the bin */
    async write(data) {
        const key = this.masterKey;
        if (!key) throw new Error('JSONBIN_KEY not set');

        const id = this.loadBinId();
        if (!id) throw new Error('No bin ID — run setup first');

        const result = await request('PUT', `/v3/b/${id}`, data, key);
        this.cachedData = data;
        this.lastFetch = Date.now();
        return result;
    }

    /** Merge and push a partial update */
    async update(partialData) {
        const current = await this.read();
        const merged = { ...current, ...partialData };
        await this.write(merged);
        return merged;
    }

    /** Check if sync is configured */
    isConfigured() {
        return !!(this.masterKey && this.loadBinId());
    }
}

module.exports = new CloudSync();
