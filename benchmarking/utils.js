import { performance, PerformanceObserver } from 'node:perf_hooks';

// Credit to https://github.com/milomg/js-reactivity-benchmark for the logic for timing + GC tracking.

/** @type {(fn: () => void | Promise<void>) => Promise<{ time: number, gc_time: number }>} */
async function track(fn) {
	%CollectGarbage(null);

	/** @type {PerformanceEntry[]} */
	const entries = [];

	const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
	observer.observe({ entryTypes: ['gc'] });

	const start = performance.now();
	await fn();
	const end = performance.now();

	await new Promise((f) => setTimeout(f, 10));

	const gc_time = entries
		.filter((e) => e.startTime >= start && e.startTime < end)
		.reduce((t, e) => e.duration + t, 0);

	observer.disconnect();

	return { time: end - start, gc_time };
}

/**
 * @param {number} times
 * @param {() => void | Promise<void>} fn
 */
export async function fastest_test(times, fn) {
	/** @type {Array<{ time: number, gc_time: number }>} */
	const results = [];

	for (let i = 0; i < times; i++) {
		results.push(await track(fn));
	}

	return results.reduce((a, b) => (a.time < b.time ? a : b));
}

/**
 * Returns the middle wall-clock sample, retaining its corresponding GC time.
 * This is less sensitive than the fastest sample to scheduler noise in async benchmarks.
 * @param {number} times
 * @param {() => void | Promise<void>} fn
 */
export async function median_test(times, fn) {
	/** @type {Array<{ time: number, gc_time: number }>} */
	const results = [];

	for (let i = 0; i < times; i++) {
		results.push(await track(fn));
	}

	return results.sort((a, b) => a.time - b.time)[Math.floor(results.length / 2)];
}
