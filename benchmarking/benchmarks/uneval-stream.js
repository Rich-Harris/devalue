import { unevalStream } from '../../index.js';
import { median_test } from '../utils.js';

let blackhole = 0;

class Wrapper {
	/** @param {unknown} value */
	constructor(value) {
		this.value = value;
	}
}

class Atomic {
	/** @param {unknown} value */
	constructor(value) {
		this.value = value;
	}
}

/** @param {unknown} value @param {(value: unknown) => string} uneval */
function replacer(value, uneval) {
	if (value instanceof Wrapper) return `({value:${uneval(value.value)}})`;
	if (value instanceof Atomic) return `new Atomic(${uneval(value.value)})`;
}

/** @param {number} depth @param {number} breadth */
function tree(depth, breadth) {
	if (depth === 0) return { value: 1, label: 'leaf' };
	return {
		value: depth,
		children: Array.from({ length: breadth }, () => tree(depth - 1, breadth))
	};
}

function mixed_graph() {
	const shared = { enabled: true, values: [1, 2, 3] };
	const key = { id: 1 };
	const bytes = new Uint8Array(256);
	for (let i = 0; i < bytes.length; i++) bytes[i] = i;
	return {
		shared,
		again: shared,
		date: new Date(1_700_000_000_000),
		regexp: /devalue/giu,
		map: new Map([[key, shared], [shared, bytes]]),
		set: new Set([key, shared, bytes.buffer]),
		buffer: bytes.buffer,
		view: new Uint16Array(bytes.buffer)
	};
}

function large_tree() {
	const root = { index: 0, children: [] };
	let level = [root];
	let index = 1;
	for (let depth = 0; depth < 6; depth++) {
		const next = [];
		for (const parent of level) {
			for (let i = 0; i < 4; i++) {
				const child = { index: index++, children: [] };
				parent.children.push(child);
				next.push(child);
			}
		}
		level = next;
	}
	return root;
}

function wide_dag() {
	const shared = Array.from({ length: 256 }, (_, index) => ({ index, value: `shared-${index}` }));
	return Array.from({ length: 2048 }, (_, index) => ({
		left: shared[index & 255],
		right: shared[(index * 17) & 255]
	}));
}

function cyclic_graph() {
	const nodes = Array.from({ length: 512 }, (_, index) => ({ index, next: undefined, shared: undefined }));
	for (let i = 0; i < nodes.length; i++) {
		nodes[i].next = nodes[(i + 1) % nodes.length];
		nodes[i].shared = nodes[(i * 31) % nodes.length];
	}
	return nodes[0];
}

function sparse_graph() {
	const sparse = Array(4096);
	for (let i = 0; i < sparse.length; i += 32) sparse[i] = { index: i };
	const object = Object.create(null);
	for (let i = 0; i < 512; i++) object[`key_${i}`] = sparse[(i * 32) % sparse.length];
	return { sparse, object };
}

function collection_graph() {
	const values = Array.from({ length: 1024 }, (_, index) => ({ index }));
	return {
		map: new Map(values.map((value, index) => [value, values[(index + 1) % values.length]])),
		set: new Set(values)
	};
}

function custom_graph() {
	let value = { end: true };
	for (let i = 0; i < 512; i++) value = new Wrapper({ index: i, value, shared: value });
	return value;
}

function atomic_graph() {
	const containers = Array.from({ length: 256 }, (_, index) => ({ index, value: undefined }));
	for (let i = 0; i < containers.length; i++) {
		containers[i].value = new Atomic(containers[(i + 1) % containers.length]);
	}
	return containers[0];
}

/**
 * @param {string} label
 * @param {unknown} value
 * @param {number} iterations
 * @param {((value: unknown, uneval: (value: unknown) => string) => string | void)} [custom_replacer]
 */
function sync_benchmark(label, value, iterations, custom_replacer) {
	const run = async () => {
		for (let i = 0; i < iterations; i++) {
			const result = await unevalStream(value, custom_replacer, { id: 'benchmark' });
			blackhole += result.head.length;
		}
	};
	return {
		label,
		async fn() {
			await run();
			return median_test(5, run);
		}
	};
}

function deferred() {
	/** @type {(value: unknown) => void} */
	let resolve = () => {};
	const promise = new Promise((fulfil) => {
		resolve = fulfil;
	});
	return { promise, resolve };
}

/** @param {Awaited<ReturnType<typeof unevalStream>>} result */
async function consume(result) {
	blackhole += result.head.length;
	for await (const block of result.tail) blackhole += block.length;
}

const primitive = 42;
const flat = { id: 1, name: 'example', active: true, score: 42, optional: null };
const nested = tree(4, 4);
const shared = { value: { id: 1, values: [1, 2, 3] } };
const repeated = Array.from({ length: 1024 }, () => shared.value);

const benchmarks = [
	sync_benchmark('unevalStream sync/primitive', primitive, 100_000),
	sync_benchmark('unevalStream sync/flat object', flat, 40_000),
	sync_benchmark('unevalStream sync/nested tree', nested, 400),
	sync_benchmark('unevalStream sync/shared object', { shared, repeated }, 800),
	sync_benchmark('unevalStream sync/mixed graph', mixed_graph(), 6_000),
	sync_benchmark('unevalStream edge/many objects', large_tree(), 15),
	sync_benchmark('unevalStream edge/wide DAG', wide_dag(), 35),
	sync_benchmark('unevalStream edge/cyclic graph', cyclic_graph(), 125),
	sync_benchmark('unevalStream edge/sparse graph', sparse_graph(), 300),
	sync_benchmark('unevalStream edge/collections', collection_graph(), 100),
	sync_benchmark('unevalStream custom/nested', custom_graph(), 100, replacer),
	sync_benchmark('unevalStream custom/atomic cycle', atomic_graph(), 150, replacer),
	{
		label: 'unevalStream stream/resolved head',
		async fn() {
			const run = async () => {
				for (let iteration = 0; iteration < 3; iteration++) {
					const outcome = wide_dag();
					const promises = Array.from({ length: 128 }, (_, index) => Promise.resolve(index & 1 ? outcome[index] : outcome));
					await consume(await unevalStream(promises, undefined, { id: 'benchmark' }));
				}
			};
			await run();
			return median_test(5, run);
		}
	},
	{
		label: 'unevalStream stream/large tail',
		async fn() {
			const outcome = large_tree();
			const run = async () => {
				for (let iteration = 0; iteration < 8; iteration++) {
					const pending = deferred();
					const result = await unevalStream({ pending: pending.promise }, undefined, { id: 'benchmark' });
					pending.resolve(outcome);
					await consume(result);
				}
			};
			await run();
			return median_test(5, run);
		}
	},
	{
		label: 'unevalStream stream/shared regions',
		async fn() {
			const shared = collection_graph();
			const run = async () => {
				for (let iteration = 0; iteration < 20; iteration++) {
					const pending = Array.from({ length: 64 }, () => deferred());
					const result = await unevalStream(
						{ shared, pending: pending.map((item) => item.promise) },
						undefined,
						{ id: 'benchmark' }
					);
					for (let i = 0; i < pending.length; i++) pending[i].resolve(i & 1 ? shared : Array.from(shared.map.keys())[i]);
					await consume(result);
				}
			};
			await run();
			return median_test(5, run);
		}
	},
	{
		label: 'unevalStream stream/many regions',
		async fn() {
			const run = async () => {
				for (let iteration = 0; iteration < 5; iteration++) {
					async function* sequence() {
						for (let i = 0; i < 16; i++) yield { index: i, value: flat };
					}
					await consume(await unevalStream(sequence(), undefined, { id: 'benchmark' }));
				}
			};
			await run();
			return median_test(5, run);
		}
	}
];

export default benchmarks;
