# xxstache API Documentation

Complete API reference and benchmark results for xxstache.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Examples](#examples)
- [Benchmarks](#benchmarks)
- [Performance Characteristics](#performance-characteristics)

## Installation

```bash
npm install xxstache
```

## Quick Start

```typescript
import Cache from 'xxstache'

const cache = new Cache({
  ttl: 3600,        // 1 hour TTL
  maxEntries: 1000  // LRU eviction at 1000 entries
})

await cache.set('key', Buffer.from('value'))
const value = await cache.get('key')
```

## API Reference

### Class: Cache

Main cache class. Manages storage of values in both SQLite and the filesystem.

#### Constructor

```typescript
new Cache(options?: CacheOptions)
```

Creates a new cache instance.

**Parameters:**
- `options` (optional): Configuration object

**Example:**
```typescript
const cache = new Cache({
  ttl: 7200,
  maxInMemorySize: 5 * 1024,
  maxEntries: 500
})
```

#### Methods

##### `cache.set(key, value, ttl?)`

Stores a value in the cache.

```typescript
await cache.set(key: string, value: Buffer, ttl?: number): Promise<void>
```

**Parameters:**
- `key` (string): Unique cache key
- `value` (Buffer): Data to store
- `ttl` (number, optional): Override default TTL in seconds

**Behavior:**
- Values smaller than `maxInMemorySize` are stored in SQLite BLOB
- Larger values are stored on disk
- Automatically triggers LRU eviction if `maxEntries` is exceeded
- Updates entry if key already exists

**Example:**
```typescript
// Store small value (goes to SQLite)
await cache.set('user:123', Buffer.from('{"name":"Alice"}'))

// Store large value (goes to disk)
await cache.set('image:1', largeImageBuffer)

// Override TTL for specific entry
await cache.set('temp', Buffer.from('data'), 60) // 1 minute TTL
```

##### `cache.get(key, defaultValue?)`

Retrieves a value from the cache.

```typescript
await cache.get(key: string, defaultValue?: Buffer): Promise<Buffer | undefined>
```

**Parameters:**
- `key` (string): Cache key to retrieve
- `defaultValue` (Buffer, optional): Return value if key not found

**Returns:**
- `Buffer | undefined`: The cached value, or `defaultValue`/`undefined` if not found

**Behavior:**
- Automatically loads from disk if value is file-backed
- Updates access time for LRU tracking
- Returns `undefined` if key doesn't exist and no default provided

**Example:**
```typescript
const value = await cache.get('user:123')
if (value) {
  console.log(value.toString())
}

// With default value
const data = await cache.get('missing', Buffer.from('default'))
```

##### `cache.has(key)`

Checks if a key exists and its freshness status.

```typescript
await cache.has(key: string): Promise<'hit' | 'stale' | 'miss'>
```

**Parameters:**
- `key` (string): Cache key to check

**Returns:**
- `'hit'`: Key exists and is not expired
- `'stale'`: Key exists but has expired
- `'miss'`: Key does not exist

**Example:**
```typescript
const status = await cache.has('user:123')

if (status === 'hit') {
  const value = await cache.get('user:123')
} else if (status === 'stale') {
  // Key exists but expired - you can still read it
  const value = await cache.get('user:123')
} else {
  // Cache miss - need to fetch fresh data
  const data = await fetchData()
  await cache.set('user:123', data)
}
```

##### `cache.del(key)`

Deletes a cache entry.

```typescript
await cache.del(key: string): Promise<void>
```

**Parameters:**
- `key` (string): Cache key to delete

**Behavior:**
- Removes entry from database
- Deletes associated file if value was stored on disk

**Example:**
```typescript
await cache.del('user:123')
```

##### `cache.purge()`

Removes all expired entries from the cache.

```typescript
await cache.purge(): Promise<number>
```

**Returns:**
- `Promise<number>`: Number of entries purged

**Behavior:**
- Deletes entries where `ttl < now - tbd`
- Removes associated disk files
- Returns count of deleted entries

**Example:**
```typescript
const purged = await cache.purge()
console.log(`Purged ${purged} expired entries`)
```

##### `cache.destroyDatabase()`

Destroys the persistent database file.

```typescript
await cache.destroyDatabase(): Promise<void>
```

**Behavior:**
- Only works for persistent databases
- Does nothing for in-memory or temporary databases

**Example:**
```typescript
await cache.destroyDatabase()
```

## Configuration

### CacheOptions Interface

```typescript
interface CacheOptions {
  path?: string                    // Directory for cached files (default: OS temp dir)
  dbPath?: "" | ":memory:" | string // SQLite path (default: temp dir)
  ttl?: number                     // Time to live in seconds (default: 3600)
  tbd?: number                     // Grace period before deletion (default: 3600)
  maxInMemorySize?: number         // Size threshold in bytes (default: 10240 / 10KB)
  maxEntries?: number              // Max entries before LRU eviction (default: unlimited)
}
```

### Configuration Details

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | string | OS temp dir | Directory where large cached files are stored |
| `dbPath` | string \| ":memory:" \| "" | temp dir | SQLite path. `:memory:` = RAM-only DB, `""` = temp DB, or path for persistent DB |
| `ttl` | number | 3600 | Time-to-live in seconds before entry expires |
| `tbd` | number | 3600 | Grace period in seconds after TTL expires before purging |
| `maxInMemorySize` | number | 10240 | Size in bytes. Smaller values stored in SQLite, larger on disk |
| `maxEntries` | number | undefined | Maximum entries. Exceeding triggers LRU eviction |

## Examples

### Basic Usage

```typescript
import Cache from 'xxstache'

const cache = new Cache()

// Store
await cache.set('key', Buffer.from('value'))

// Retrieve
const value = await cache.get('key')

// Check status
const status = await cache.has('key')

// Delete
await cache.del('key')
```

### Custom Storage Location

```typescript
const cache = new Cache({
  path: '/var/cache/myapp',
  dbPath: '/var/cache/myapp/cache.db'
})
```

### In-Memory Cache

You can run the entire cache in memory (no disk database):

```typescript
const cache = new Cache({
  dbPath: ':memory:'
})
// Database exists only in RAM, disappears when process exits
```

**How it works:**

- Small values (< 10KB): Stored in memory within the in-memory SQLite database
- Large values (≥ 10KB): Still written to disk files (uses `path` option)
- Database itself: Lives only in RAM, no database file

**Example:**

```typescript
// In-memory cache - fast, but temporary
const memCache = new Cache({
  dbPath: ':memory:',
  path: '/tmp/cache' // Large files still go here
})

await memCache.set('key', smallBuffer)     // Stored in RAM
await memCache.set('key2', largeBuffer)    // Stored to disk at /tmp/cache
// Process exits → RAM data lost, disk files remain
```

**Note:** Both `:memory:` and `""` create in-memory databases. The `""` variant is more temporary and uses SQLite's default temp database behavior.

### LRU Eviction

```typescript
const cache = new Cache({
  maxEntries: 100  // Keep only 100 most recent entries
})

// When you add entry 101, the least recently used entry is automatically removed
for (let i = 0; i < 150; i++) {
  await cache.set(`key-${i}`, Buffer.from(`data-${i}`))
}
// Only the most recent 100 entries remain
```

### Handling Stale Data

```typescript
const status = await cache.has('key')

if (status !== 'miss') {
  // Entry exists (fresh or stale)
  const value = await cache.get('key')
  // Use value
}
```

### Using Adapter for Automatic Purging

```typescript
import { Adapter } from 'xxstache'

const adapter = new Adapter({ ttl: 7200 })
await adapter.init()
// Adapter automatically purges expired entries on interval

// Use as normal cache
await adapter.cache.set('key', Buffer.from('value'))
const value = await adapter.cache.get('key')

// Clean up
await adapter.shutdown()
```

## Benchmarks

Benchmark results with xxstache:

### Write Performance

**Test:** Writing 3000 iterations of 15 different data sizes (10B to 500KB)

- **Average:** 42.68 μs/record
- **Range:** 10B to 500KB files
- **Storage:** Automatic (SQLite for small, disk for large)
- **Platform:** Windows 10

### Read Performance

**Test:** Reading 3000 iterations of cached entries

- **Average:** 59.77 μs/record
- **Notes:** Includes both in-DB and disk-backed entries

## Performance Characteristics

### The 10KB Threshold

The default `maxInMemorySize` of 10KB (10240 bytes) is a sensible default that balances performance and database size:

**Why 10KB?**

- **SQLite BLOB Performance**: Storing values in SQLite BLOBs is extremely fast for small data
- **Database Bloat Prevention**: Large BLOBs dramatically increase database size and slow down queries
- **Balanced Trade-off**: At 10KB, the overhead of a separate file read is acceptable compared to database bloat
- **Common Use Cases**: Most cache entries (JSON, small images, text) are well under 10KB

**You can adjust this threshold:**

```typescript
// Store more in SQLite (faster, but larger DB)
const cache = new Cache({ maxInMemorySize: 50 * 1024 }) // 50KB

// Store less in SQLite (smaller DB, more file I/O)
const cache = new Cache({ maxInMemorySize: 5 * 1024 })  // 5KB
```

### Optimization Strategies

1. **Small Values (< 10KB)**
   - Stored in SQLite BLOB for fastest access
   - No disk I/O overhead
   - SQLite index enables O(log n) lookups
   - Best for JSON, small text, thumbnails

2. **Large Values (≥ 10KB)**
   - Stored on filesystem to prevent database bloat
   - Database stores only file reference (tiny overhead)
   - Single disk read per retrieval
   - Best for images, videos, large documents

3. **LRU Eviction**
   - Automatic removal of least recently used entries
   - Keeps cache size manageable
   - Triggered on every `set()` operation

4. **TTL Management**
   - Entries kept for grace period after expiry
   - Allows reading stale data if needed
   - `purge()` cleans up completely

### Performance Tips

- Use `has()` for quick existence checks without data transfer
- Set `maxInMemorySize` based on your data patterns
- Use `maxEntries` to control memory/disk usage
- Call `purge()` periodically or use the `Adapter` class
- Store hot data (< 10KB) for best performance

### Storage Layout

**Persistent Cache:**
```
cache.db (SQLite on disk)
├── key TEXT PRIMARY KEY
├── value BLOB          # < 10KB values stored here
├── filename TEXT       # Reference to file for ≥ 10KB values  
├── ttl REAL            # Expiration timestamp
└── atime REAL          # Last access time (for LRU)

/tmp/hdc (Filesystem)
├── ab/
│   └── cd/
│       └── ef1234567890.v  # Large values stored as files
```

**In-Memory Cache (`dbPath: ':memory:'`):**
```
RAM (SQLite in-memory database)
├── key TEXT PRIMARY KEY
├── value BLOB          # < 10KB values stored in RAM
├── filename TEXT       # Reference to disk file for ≥ 10KB values  
├── ttl REAL            # Expiration timestamp
└── atime REAL          # Last access time (for LRU)

/tmp/hdc (Filesystem) - still used for large values
└── ab/cd/ef1234567890.v
```

### Persistent vs In-Memory Trade-offs

| Feature | Persistent (`dbPath` = file path) | In-Memory (`dbPath` = `":memory:"`) |
|---------|-----------------------------------|--------------------------------------|
| **Speed** | Fast (SQLite + disk) | Fastest (pure RAM) |
| **Persistence** | ✅ Survives restarts | ❌ Lost on exit |
| **Durability** | ✅ Safe | ⚠️ Data lost on crash |
| **Use Case** | Production, long-running | Testing, temporary |
| **Startup** | Reads DB file | Instant |
| **Memory** | Low | Higher (all in RAM) |

### Comparison to Original

The original `@next-boost/hybrid-disk-cache` uses simple hash-based directory structure. This port uses **xxhash64** for file organization, providing:

- Faster hash calculation (xxhash64 vs traditional hash)
- Better distribution of files across directories
- Consistent performance at scale

