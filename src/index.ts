/**
 * @fileoverview
 * A hybrid disk cache implementation that efficiently stores data in SQLite for small values
 * and on the filesystem for larger values. This provides optimal performance by minimizing
 * database bloat while maintaining fast access to cached data.
 *
 * Features:
 * - Automatic threshold-based storage (DB for small values, disk for large values)
 * - Time-based expiration (TTL) with configurable grace period
 * - LRU (Least Recently Used) cache eviction when size limits are reached
 * - Automatic purging of expired entries
 * - Support for in-memory and persistent databases
 * - High-performance SQLite with WAL mode
 */

import SQLite3, { Database, Statement } from "better-sqlite3"
import fs from "fs-extra"
import { join as pathJoin } from "path"

import {
	createDirectoryIfDoesNotExists,
	getDatabasePath,
	getFileCachePath,
	hasPersistentDatabaseLocation,
	xxhname,
	removeFile,
	purgeEmptyPath,
	read,
	write,
} from "./utils"

export { Adapter } from "./adapter"

const DDL = `
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value BLOB, filename TEXT, ttl REAL NOT NULL, atime REAL NOT NULL);
CREATE INDEX IF NOT EXISTS cache_ttl ON cache (ttl);
CREATE INDEX IF NOT EXISTS cache_atime ON cache (atime);
`

/**
 * Cache entry status indicating whether a key exists and its freshness.
 * - "hit": Key exists and is not expired
 * - "stale": Key exists but has expired
 * - "miss": Key does not exist in cache
 */
type CacheStatus = "hit" | "stale" | "miss"

interface CacheRow {
	key?: string
	value?: Buffer | null
	filename?: string | null
	ttl?: number
	atime?: number
}

interface CacheRowWithValue extends CacheRow {
	value: Buffer | null
	filename: string | null
}

interface CacheRowWithTtl extends CacheRow {
	ttl: number
}

interface CacheRowWithFilename extends CacheRow {
	filename: string | null
	key: string
}

/**
 * Configuration options for the cache instance.
 *
 * @example
 * ```typescript
 * const cache = new Cache({
 *   path: '/tmp/my-cache',
 *   ttl: 7200,  // 2 hours
 *   maxInMemorySize: 5 * 1024,  // 5KB threshold
 *   maxEntries: 1000  // LRU eviction after 1000 entries
 * })
 * ```
 */
export interface CacheOptions {
	/** Directory path for storing cached files. Defaults to OS temp directory. */
	path?: string
	/** SQLite database path. Use "" or ":memory:" for in-memory, or a file path for persistent storage. */
	dbPath?: "" | ":memory:" | string
	/** Time to live in seconds for cache entries. Default: 3600 (1 hour). */
	ttl?: number
	/** Time before deletion: grace period in seconds after TTL expires before purging. Default: 3600 (1 hour). */
	tbd?: number
	/** Maximum size in bytes for in-database storage. Values larger than this are stored on disk. Default: 10240 (10KB). */
	maxInMemorySize?: number
	/** Maximum number of entries before LRU eviction kicks in. 0 or undefined means no limit. Default: undefined (no limit). */
	maxEntries?: number
}

/**
 * Hybrid disk cache with automatic threshold-based storage strategy.
 *
 * Small values (< maxInMemorySize) are stored in SQLite for fast access.
 * Large values (≥ maxInMemorySize) are stored on disk to prevent database bloat.
 *
 * @example
 * ```typescript
 * // Create a cache instance
 * const cache = new Cache({ ttl: 7200 })
 * await cache.set('key', Buffer.from('data'))
 * const value = await cache.get('key')
 * ```
 */
class Cache {
	db: Database
	ttl = 3600 // time to live
	tbd = 3600 // time before deletion
	maxInMemorySize = 10 * 1024 // size threshold for storing on disk
	maxEntries: number | undefined = undefined // max entries before LRU eviction
	public path: string
	public dbPath: string

	// Prepared statements for performance - I just learnt about this
	private stmtInsert: Statement
	private stmtGet: Statement
	private stmtUpdateAtime: Statement
	private stmtHas: Statement
	private stmtGetFilename: Statement
	private stmtDelete: Statement
	private stmtCountEntries: Statement
	private stmtEvictLRU: Statement
	private stmtPurgeSelect: Statement
	private stmtPurgeDelete: Statement

	// Transaction wrapper for bulk inserts (synchronous body)
	private insertManyTx!: (rows: Array<{ key: string; value: Buffer | null; filename: string | null; ttl: number; atime: number }>) => void

	/**
	 * Constructs a new cache instance.
	 * @param options - Configuration options for the cache
	 */
	constructor({ path, ttl, tbd, dbPath, maxInMemorySize, maxEntries }: CacheOptions = {}) {
		this.path = getFileCachePath(path)
		this.dbPath = getDatabasePath(dbPath)

		createDirectoryIfDoesNotExists(this.path)
		if (hasPersistentDatabaseLocation(this.dbPath))
			createDirectoryIfDoesNotExists(this.dbPath)

		if (ttl) this.ttl = ttl
		if (tbd) this.tbd = tbd
		if (maxInMemorySize) this.maxInMemorySize = maxInMemorySize
		if (maxEntries !== undefined) this.maxEntries = maxEntries

		const db = new SQLite3(this.dbPath)
		// Performance-oriented pragmas; adjust for your durability needs
		db.exec("PRAGMA journal_mode = WAL")
		db.exec("PRAGMA synchronous = NORMAL")
		db.exec("PRAGMA temp_store = MEMORY")
		// negative cache_size sets size in KB of page cache in memory
		db.exec("PRAGMA cache_size = -20000")
		for (const s of DDL.trim().split("\n")) {
			db.prepare(s).run()
		}
		
		// Add atime column if it doesn't exist (for existing databases)
		try {
			db.exec("ALTER TABLE cache ADD COLUMN atime REAL NOT NULL DEFAULT 0")
			db.exec("CREATE INDEX IF NOT EXISTS cache_atime ON cache (atime)")
		} catch {
			// Column already exists, ignore
		}
		
		this.db = db

		// Prepare all statements once for performance
		this.stmtInsert = db.prepare(
			"INSERT INTO cache (key, value, filename, ttl, atime) VALUES (@key, @value, @filename, @ttl, @atime)" +
			" ON CONFLICT(key)" +
			" DO UPDATE SET value = @value, ttl = @ttl, filename = @filename, atime = @atime",
		)
		this.stmtGet = db.prepare("SELECT value, filename FROM cache WHERE key = ?")
		this.stmtUpdateAtime = db.prepare("UPDATE cache SET atime = ? WHERE key = ?")
		this.stmtHas = db.prepare("SELECT ttl FROM cache WHERE key = ?")
		this.stmtGetFilename = db.prepare("SELECT filename FROM cache WHERE key = ?")
		this.stmtDelete = db.prepare("DELETE FROM cache WHERE key = ?")
		this.stmtCountEntries = db.prepare("SELECT COUNT(*) as count FROM cache WHERE ttl > ?")
		this.stmtEvictLRU = db.prepare("SELECT key, filename FROM cache WHERE ttl > ? ORDER BY atime ASC LIMIT ?")
		this.stmtPurgeSelect = db.prepare("SELECT key, filename FROM cache WHERE ttl < ?")
		this.stmtPurgeDelete = db.prepare("DELETE FROM cache WHERE ttl < ?")

		// Build a synchronous transaction for bulk inserts
		const tx = db.transaction((rows: Array<{ key: string; value: Buffer | null; filename: string | null; ttl: number; atime: number }>) => {
			for (const row of rows) this.stmtInsert.run(row)
		})
		this.insertManyTx = tx
	}

	/**
	 * Stores a value in the cache.
	 * Values larger than maxInMemorySize are automatically stored on disk.
	 * When maxEntries is configured and exceeded, LRU eviction automatically removes least recently used entries.
	 *
	 * @param key - Unique identifier for the cached value
	 * @param value - The data to cache as a Buffer
	 * @param ttl - Optional time-to-live in seconds (overrides default)
	 * @throws Error if the database operation fails
	 *
	 * @example
	 * ```typescript
	 * await cache.set('user:123', Buffer.from(JSON.stringify(userData)))
	 * await cache.set('file:image.png', imageBuffer, 86400) // 24 hour TTL
	 * ```
	 */
	async set(key: string, value: Buffer, ttl?: number) {
		if (!ttl) ttl = this.ttl

		const insert = this.db.prepare(
			"INSERT INTO cache (key, value, filename, ttl, atime) VALUES (@key, @value, @filename, @ttl, @atime)" +
			" ON CONFLICT(key)" +
			" DO UPDATE SET value = @value, ttl = @ttl, filename = @filename, atime = @atime",
		)
		let filename: string | null = null
		// larger than maxInMemorySize
		if (value.length > this.maxInMemorySize) {
			filename = await xxhname(key)
			write(this.path, filename, value)
		}

		const now = new Date().getTime() / 1000
		insert.run({
			key,
			value: filename ? null : value,
			filename,
			ttl: now + ttl,
			atime: now,
		})

		// LRU eviction: if maxEntries is set and we're over the limit, evict the least recently used
		if (this.maxEntries && this.maxEntries > 0) {
			await this._evictLRU()
		}
	}

	/**
	 * Efficiently set many entries in a single transaction.
	 * Precomputes filenames for large values to avoid async inside transaction.
	 */
	async setMany(entries: Array<{ key: string; value: Buffer; ttl?: number }>) {
		// Precompute filenames for large values, and shape rows
		const now = new Date().getTime() / 1000
		const rows: Array<{ key: string; value: Buffer | null; filename: string | null; ttl: number; atime: number }> = []
		for (const { key, value, ttl } of entries) {
			let filename: string | null = null
			if (value.length > this.maxInMemorySize) {
				filename = await xxhname(key)
				write(this.path, filename, value)
			}
			rows.push({
				key,
				value: filename ? null : value,
				filename,
				ttl: now + (ttl ?? this.ttl),
				atime: now,
			})
		}

		// Execute single transaction
		this.insertManyTx(rows)

		// Optional single LRU pass
		if (this.maxEntries && this.maxEntries > 0) {
			await this._evictLRU()
		}
	}

	/**
	 * Retrieves a value from the cache.
	 * Automatically loads from disk if the value is file-backed.
	 *
	 * @param key - The unique identifier for the cached value
	 * @param defaultValue - Optional value to return if key is not found
	 * @returns The cached value as a Buffer, or defaultValue/undefined if not found
	 *
	 * @example
	 * ```typescript
	 * const value = await cache.get('user:123')
	 * const valueWithDefault = await cache.get('user:456', Buffer.from('default'))
	 * ```
	 */
	async get(key: string, defaultValue?: Buffer): Promise<Buffer | undefined> {
		const rv = this.stmtGet.get(key) as CacheRowWithValue | undefined
		if (!rv) return defaultValue
		
		// Update access time for LRU tracking (only if maxEntries is configured)
		if (this.maxEntries && this.maxEntries > 0) {
			const now = new Date().getTime() / 1000
			this.stmtUpdateAtime.run(now, key)
		}
		
		if (rv && rv.filename) rv.value = read(this.path, rv.filename)
		return rv.value ?? defaultValue
	}

	/**
	 * Checks if a key exists in the cache and whether it's fresh or stale.
	 *
	 * @param key - The unique identifier to check
	 * @returns Cache status: "hit" (exists and fresh), "stale" (exists but expired), or "miss" (doesn't exist)
	 *
	 * @example
	 * ```typescript
	 * const status = await cache.has('user:123')
	 * if (status === 'hit') {
	 *   const value = await cache.get('user:123')
	 * }
	 * ```
	 */
	async has(key: string): Promise<CacheStatus> {
		const now = new Date().getTime() / 1000
		const rv = this.stmtHas.get(key) as CacheRowWithTtl | undefined
		return !rv ? "miss" : rv.ttl > now ? "hit" : "stale"
	}

	/**
	 * Deletes a value from the cache, including any associated disk file.
	 *
	 * @param key - The unique identifier to delete
	 *
	 * @example
	 * ```typescript
	 * await cache.del('user:123')
	 * ```
	 */
	async del(key: string) {
		const rv = this.stmtGetFilename.get(key) as CacheRowWithFilename | undefined
		this.stmtDelete.run(key)
		this._delFile(rv?.filename)
	}

	/**
	 * Evicts the least recently used entries when cache exceeds maxEntries.
	 * Private method called automatically by set() when maxEntries is configured.
	 */
	async _evictLRU() {
		if (!this.maxEntries || this.maxEntries <= 0) return

		// Count current entries (non-expired)
		const now = new Date().getTime() / 1000
		const count = this.stmtCountEntries.get(now) as { count: number }
		
		// If we're under the limit, no eviction needed
		if (count.count <= this.maxEntries) return

		// Calculate how many to evict
		const toEvict = count.count - this.maxEntries

		// Get the least recently used entries (oldest atime)
		const rows = this.stmtEvictLRU.all(now, toEvict) as CacheRowWithFilename[]

		// Delete them from cache and their files
		for (const row of rows) {
			this.stmtDelete.run(row.key)
			this._delFile(row.filename)
		}
	}

	_delFile(filename?: string | null) {
		if (!filename) return
		const f = pathJoin(this.path, filename)
		fs.unlink(f).catch()
	}

	/**
	 * Permanently removes all expired entries from the cache.
	 * Entries are purged after TTL + TBD (grace period) has passed.
	 * Returns the number of entries purged.
	 *
	 * @returns The number of cache entries that were purged
	 *
	 * @example
	 * ```typescript
	 * const purged = await cache.purge()
	 * console.log(`Purged ${purged} expired entries`)
	 * ```
	 */
	async purge() {
		// ttl + tbd < now => ttl < now - tbd
		const now = new Date().getTime() / 1000 - this.tbd
		const rows = this.stmtPurgeSelect.all(now) as CacheRowWithFilename[]
		this.stmtPurgeDelete.run(now)
		for (const row of rows) this._delFile(row.filename)
		await purgeEmptyPath(this.path)
		return rows.length
	}

	/**
	 * Destroys the persistent database file.
	 * Only works for persistent databases, not in-memory or temporary databases.
	 *
	 * @example
	 * ```typescript
	 * await cache.destroyDatabase()
	 * ```
	 */
	async destroyDatabase() {
		if (hasPersistentDatabaseLocation(this.dbPath)) {
			await removeFile(this.dbPath)
		}
	}
}

export default Cache