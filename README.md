# xxstache

A port of [`@next-boost/hybrid-disk-cache`](https://github.com/node-modules/hybrid-disk-cache) for toy projects, tweaked to use xxhash64 for hashing.

This is a simple hybrid disk cache for Node.js. It automatically stores small values in SQLite and large values on disk, so your database doesn't get bloated.

Why? Well, you probably don't want to stuff a 50MB file into your SQLite database. This cache handles that for you by storing anything over 10KB (configurable) as a regular file, while keeping the fast SQLite lookups for small stuff.

It also supports TTL expiration, LRU eviction when you hit size limits, and automatically cleans up expired entries.

The original implementation uses a simple hash-based directory structure. This port uses xxhash64 instead for the file organization.

```bash
npm install xxstache
```

Using it is pretty straightforward:

```typescript
import Cache from 'xxstache'

const cache = new Cache({
  ttl: 3600,        // entries expire after 1 hour
  maxEntries: 1000  // evict oldest when we hit 1000 entries
})

// Store something
await cache.set('user:123', Buffer.from(JSON.stringify({ name: 'Alice' })))

// Get it back
const data = await cache.get('user:123')
console.log(data?.toString()) // {"name":"Alice"}

// Check if it's still fresh
const status = await cache.has('user:123') // 'hit', 'stale', or 'miss'

// Clean up when you're done
await cache.del('user:123')
```

The cache automatically figures out where to put stuff - small things go in SQLite for speed, big things go to disk to keep the database lean.

### Configuration

Here's what you can configure:

**`path`** - Where to store large files (defaults to your OS temp directory)

**`dbPath`** - SQLite location. Use `""` or `":memory:"` for in-memory, or a path for a persistent database. Defaults to temp directory.

**`ttl`** - Time-to-live in seconds (default: 3600)

**`tbd`** - Grace period after expiry before purging (default: 3600)

**`maxInMemorySize`** - Size threshold in bytes. Anything smaller goes in SQLite, larger goes to disk (default: 10KB)

**`maxEntries`** - LRU eviction limit. When you hit this many entries, it automatically removes the least recently used ones. Leave it undefined for no limit.

### Methods

**`new Cache(options?)`** - Creates a cache instance

**`cache.set(key, value, ttl?)`** - Store a value. Large values automatically go to disk.

**`cache.get(key, defaultValue?)`** - Get a value. Returns `undefined` or the default if not found.

**`cache.has(key)`** - Check status: `'hit'` (fresh), `'stale'` (expired but still there), or `'miss'` (doesn't exist)

**`cache.del(key)`** - Delete a key and its file if it was stored on disk

**`cache.purge()`** - Clean up expired entries, returns count

**`cache.destroyDatabase()`** - Nuke the whole database (only for persistent databases)

### Some examples

Want a custom location?

```typescript
const cache = new Cache({
  path: '/var/cache/myapp',
  dbPath: '/var/cache/myapp/cache.db'
})
```

Just memory, no disk?

```typescript
const cache = new Cache({
  dbPath: ':memory:'
})
```

Dealing with large files? Bump up the threshold:

```typescript
const cache = new Cache({
  maxInMemorySize: 100 * 1024  // 100KB before disk storage
})

await cache.set('image:1', largeImageBuffer)
await cache.set('video:1', largeVideoBuffer)
// these go straight to disk
```

Set a size limit to keep things manageable:

```typescript
const cache = new Cache({
  maxEntries: 500  // only keep 500 most recent entries
})

// When you add entry 501, the oldest one gets kicked out automatically
```

There's also an `Adapter` class if you want automatic purging with some console output:

```typescript
import { Adapter } from 'xxstache'

const adapter = new Adapter({ ttl: 7200 })
await adapter.init()
// ... use it like normal cache ...
await adapter.shutdown()
```

### How it works

Small values (under 10KB by default) live in SQLite BLOB fields for quick access. Big stuff gets written to disk files to keep the database from bloating.

Every entry has a TTL timestamp. When you check with `has()`, it tells you if it's still fresh or expired (or missing).

If you set `maxEntries`, the cache tracks when you last accessed each entry. When you add a new entry and would exceed the limit, it automatically removes the least recently used ones.

Expired entries stick around for a grace period (controlled by `tbd`) before `purge()` actually deletes them. This gives you a window to handle things that expired but you might still want to read.

Files are organized by hash in a folder structure, and get cleaned up when their cache entry goes away.

Performance-wise: small reads are fast (SQLite), large files don't bloat your database, and it uses WAL mode for better concurrency. Simple enough.

### Documentation

Full API documentation and benchmarks: **[docs.md](docs.md)**

### Development

Tests run on Node.js 20 across Windows, macOS, and Linux. Try the benchmarks to see how it performs on your machine:

```bash
npm test        # run tests
npm run lint    # check code style
npm run bench   # run benchmarks
```

## License

This port is released under the MIT License.

The original [`hybrid-disk-cache`](https://github.com/node-modules/hybrid-disk-cache) project by [Rakuraku Jyo](https://github.com/rakuram01) is also MIT licensed and was used as the inspiration for this implementation.

Copyright 2024

