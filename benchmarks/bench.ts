import Cache from "../src/index"

function log(start: [number, number], count: number): void {
	const [secs, ns] = process.hrtime(start)
	const ms = ns / 1000
	const speed = (secs * 1000000 + ms) / count
	console.log("  done: %s μs/record.", speed.toFixed(2))
}

function benchData(size = 6) {
	const base = [1, 2, 5]
	// from 10B to 5MB
	const full = new Array(size)
		.fill(0)
		.flatMap((_, exp) => base.map((b) => b * Math.pow(10, exp)))
		.map((i) => Buffer.from(new Array(i).fill(0)))
	return full
}

async function benchWrite(cache: Cache, batch: number, size = 6) {
	console.log("> generating bench data from 10B to %sB", 5 * Math.pow(10, size))
	const full = benchData(size)

	let count = 0
	console.log("> starting %s x %s writes", batch, full.length)
	const start = process.hrtime()
	for (let i = 0; i < batch; i++) {
		for (let j = 0; j < full.length; j++) {
			await cache.set("key-" + j, full[j])
			count += 1
		}
	}

	log(start, count)
	return full.map((_, i) => "key-" + i)
}

async function benchRead(cache: Cache, batch: number, keys: string[]) {
	let count = 0
	console.log("> starting %s x %s reads", batch, keys.length)
	const start = process.hrtime()
	for (let i = 0; i < batch; i++) {
		for (const key of keys) {
			await cache.get(key)
			count += 1
		}
	}

	log(start, count)
}

async function benchHas(cache: Cache, batch: number, keys: string[]) {
	let count = 0
	console.log("> starting %s x %s has checks", batch, keys.length)
	const start = process.hrtime()
	for (let i = 0; i < batch; i++) {
		for (const key of keys) {
			await cache.has(key)
			count += 1
		}
	}

	log(start, count)
}

async function benchDel(cache: Cache, batch: number, keys: string[]) {
	let count = 0
	console.log("> starting %s x %s deletes", batch, keys.length)
	const start = process.hrtime()
	for (let i = 0; i < batch; i++) {
		for (const key of keys) {
			await cache.del(key)
			count += 1
		}
	}

	log(start, count)
}

if (require.main === module) {
	const runBenchmark = async () => {
		console.log("=== Cache Benchmark ===\n")

		const cache = new Cache()
		console.log("> cache located at: %s", cache.path)
		console.log("> database located at: %s\n", cache.dbPath)

		const batch = 100
		console.log("=== Writing Benchmarks ===")
		const keys = await benchWrite(cache, batch, 4)

		console.log("\n=== Reading Benchmarks ===")
		await benchRead(cache, batch, keys)

		console.log("\n=== Has Benchmarks ===")
		await benchHas(cache, batch, keys)

		console.log("\n=== Delete Benchmarks ===")
		await benchDel(cache, batch, keys)

		console.log("\n=== LRU Eviction Benchmarks ===")
		const lruCache = new Cache({ maxEntries: 50 })
		console.log("> LRU cache with maxEntries=50")
		console.log("> writing 200 entries (will evict 150)")
		const start = process.hrtime()
		for (let i = 0; i < 200; i++) {
			await lruCache.set(`lru-key-${i}`, Buffer.from(`data-${i}`))
		}
		log(start, 200)

		// Check remaining entries
		const remaining = await lruCache.db
			.prepare("SELECT COUNT(*) as count FROM cache")
			.get() as { count: number }
		console.log("> remaining entries: %s (expect ~50 due to LRU eviction)", remaining.count)

		console.log("\n✅ Benchmark complete!")
	}

	runBenchmark().catch(console.error)
}

