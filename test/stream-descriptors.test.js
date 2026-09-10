import vm from 'node:vm';
import { suite } from 'uvu';
import * as assert from 'uvu/assert';
import { unevalStream } from '../index.js';

const test = suite('unevalStream descriptor holes');

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((a, b) => { resolve = a; reject = b; });
	return { promise, resolve, reject };
}

function client() {
	const context = vm.createContext({});
	context.globalThis = context;
	return {
		context,
		head: (source) => vm.runInContext(`(${source})`, context),
		block: (source) => vm.runInContext(source, context)
	};
}

async function rejected(promise) {
	try { await promise; } catch (error) { return error; }
	assert.unreachable('expected rejection');
}

test('serializes graph values in construct and reachable capture expressions', async () => {
	const ready = deferred();
	const shared = { name: 'shared' };
	const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
	const view = new Uint16Array(buffer);
	const config = {
		shared,
		array: [shared],
		map: new Map([[shared, view]]),
		set: new Set([shared]),
		view,
		buffer
	};
	let construct_calls = 0;
	let discarded_then_reads = 0;
	const job = {};
	const discarded = { get then() { discarded_then_reads++; return () => {}; } };
	const result = await unevalStream({ shared, job }, (value, js) => value === job && ({
		type: 'async-value',
		source: ready.promise,
		construct: (capture) => {
			construct_calls++;
			js`${discarded}`;
			return js`({config:${config},control:${capture(js`[${shared}]`)},value:null})`;
		},
		resolve: () => js``,
		reject: () => js``
	}), { id: 'descriptor-construct-holes' });
	const target = client();
	const root = target.head(result.head);
	assert.is(construct_calls, 1);
	assert.is(discarded_then_reads, 0);
	assert.is(root.job.config.shared, root.shared);
	assert.is(root.job.config.array[0], root.shared);
	assert.is(Array.from(root.job.config.set)[0], root.shared);
	assert.is(Array.from(root.job.config.map.keys())[0], root.shared);
	assert.is(root.job.config.map.get(root.shared), root.job.config.view);
	assert.is(root.job.config.view.buffer, root.job.config.buffer);
	assert.is(root.job.control[0], root.shared);
	ready.resolve();
	for await (const block of result.tail) target.block(block);
});

test('populates sparse and null-object holes before repeated descriptor construction in every value region', async () => {
	class Job {
		constructor(value) {
			this.value = value;
			this.ready = new Promise(() => {});
		}
	}
	for (const mode of ['head', 'folded', 'outcome']) {
		const null_child = Object.assign(Object.create(null), { x: 42 });
		const sparse_child = Array(3);
		sparse_child[1] = null_child;
		const job = new Job({ items: sparse_child });
		const graph = { null_child, sparse_child, jobs: [job, job] };
		const gate = deferred();
		const value = mode === 'head' ? graph : mode === 'folded' ? Promise.resolve(graph) : gate.promise;
		let constructions = 0;
		const context = client();
		context.context.construct = (value) => {
			constructions++;
			return { value, observed: value.items[1].x };
		};
		const result = await unevalStream(value, (value, js) => value instanceof Job && ({
			type: 'async-value',
			source: value.ready,
			construct: () => js`construct(${value.value})`,
			resolve: () => js``,
			reject: () => js``
		}), { id: `descriptor-construction-readiness-${mode}` });
		let root = context.head(result.head);
		if (mode === 'outcome') {
			gate.resolve(graph);
			context.block((await result.tail.next()).value);
		}
		if (mode !== 'head') root = await root;
		assert.is(root.jobs[0], root.jobs[1]);
		assert.is(root.jobs[0].value.items, root.sparse_child);
		assert.is(root.sparse_child[1], root.null_child);
		assert.is(root.jobs[0].observed, 42);
		assert.is(constructions, 1);
		await result.tail.return();
	}
});

test('populates operation-hole children before nested descriptor construction', async () => {
	class Job {
		constructor(source, value) {
			this.source = source;
			this.value = value;
		}
	}
	const outer_ready = deferred();
	const child_ready = new Promise(() => {});
	const null_child = Object.assign(Object.create(null), { x: 42 });
	const sparse_child = Array(3);
	sparse_child[1] = null_child;
	const nested = new Job(child_ready, { items: sparse_child });
	const outer = new Job(outer_ready.promise, null);
	let constructions = 0;
	const context = client();
	context.context.construct = (value) => {
		constructions++;
		return { value, observed: value.items[1].x };
	};
	const result = await unevalStream(outer, (value, js) => value instanceof Job && ({
		type: 'async-value',
		source: value.source,
		construct: () => value === outer ? js`({values:null})` : js`construct(${value.value})`,
		resolve: ({ target }) => value === outer ? js`${target}.values=[${sparse_child},${null_child},${nested},${nested}]` : js``,
		reject: () => js``
	}), { id: 'descriptor-operation-construction-readiness' });
	const root = context.head(result.head);
	outer_ready.resolve();
	context.block((await result.tail.next()).value);
	assert.is(root.values[2], root.values[3]);
	assert.is(root.values[2].value.items, root.values[0]);
	assert.is(root.values[0][1], root.values[1]);
	assert.is(root.values[2].observed, 42);
	assert.is(constructions, 1);
	await result.tail.return();
});

test('groups the complete descriptor construction expression after lowering holes', async () => {
	const ready = deferred();
	const job = {};
	const config = { value: 2 };
	const result = await unevalStream(job, (value, js) => value === job && ({
		type: 'async-value', source: ready.promise,
		construct: () => js`0,{config:${config}}`,
		resolve: () => js``, reject: () => js``
	}));
	const root = client().head(result.head);
	assert.is(root.config.value, 2);
	ready.resolve();
	for await (const _block of result.tail) {}
});

test('materializes repeated operation holes once and preserves head/payload identity', async () => {
	const ready = deferred();
	const shared = { value: 1 };
	const job = {};
	const result = await unevalStream({ shared, job }, (value, js) => value === job && ({
		type: 'async-value',
		source: ready.promise,
		construct: () => js`({values:null,get:null})`,
		resolve: ({ target }, payload) => js`${target}.values=[${shared},${shared},${payload}];${target}.get=()=>${shared}`,
		reject: () => js``
	}), { id: 'descriptor-operation-holes' });
	const target = client();
	const root = target.head(result.head);
	ready.resolve(shared);
	for await (const block of result.tail) target.block(block);
	assert.is(root.job.values[0], root.shared);
	assert.is(root.job.values[0], root.job.values[1]);
	assert.is(root.job.values[0], root.job.values[2]);
	assert.is(root.job.get(), root.shared);
});

test('reserves distinct capture indices for nested constructor descriptors', async () => {
	class Job { constructor(name) { this.name = name; this.ready = deferred(); } }
	const inner = new Job('inner');
	const outer = new Job('outer');
	outer.child = inner;
	const result = await unevalStream(outer, (value, js) => value instanceof Job && ({
		type: 'async-value', source: value.ready.promise,
		construct: (capture) => js`({name:${value.name},control:${capture(js`[]`)},child:${value.child ?? null}})`,
		resolve: () => js``, reject: () => js``
	}), { id: 'nested-constructor-indices' });
	assert.match(result.head, /\.p\[0\]/);
	assert.match(result.head, /\.p\[1\]/);
	assert.is((result.head.match(/\.p\[\d+\]/g) ?? []).length, 2);
	const root = client().head(result.head);
	assert.is(root.child.name, 'inner');
	outer.ready.resolve();
	inner.ready.resolve();
	for await (const _block of result.tail) {}
});

test('serializes next complete reject and error holes', async () => {
	for (const phase of ['reject', 'next', 'complete', 'error']) {
		const gate = deferred();
		const hole = { phase };
		const job = {};
		const sequence = phase === 'next' || phase === 'complete' || phase === 'error';
		const source = sequence ? {
			[Symbol.asyncIterator]() { return this; },
			next() { return gate.promise; }
		} : gate.promise;
		const result = await unevalStream(job, (value, js) => value === job && ({
			type: sequence ? 'async-sequence' : 'async-value', source,
			construct: () => js`({value:null})`,
			resolve: () => js``,
			reject: ({ target }) => js`${target}.value=${hole}`,
			next: ({ target }) => js`${target}.value=${hole}`,
			complete: ({ target }) => js`${target}.value=${hole}`,
			error: ({ target }) => js`${target}.value=${hole}`
		}), { id: `descriptor-${phase}-hole` });
		const target = client();
		const root = target.head(result.head);
		if (phase === 'reject' || phase === 'error') gate.reject('reason');
		else gate.resolve({ done: phase === 'complete', value: 1 });
		const block = await result.tail.next();
		target.block(block.value);
		assert.is(root.value.phase, phase);
		if (phase === 'next') await result.tail.return();
	}
});

test('reports invalid operation data then lowers a valid fallback hole', async () => {
	const ready = deferred();
	const fallback = { ok: true };
	const reports = [];
	const job = {};
	const result = await unevalStream(job, (value, js) => value === job && ({
		type: 'async-value', source: ready.promise,
		construct: () => js`({value:null})`,
		resolve: () => js`${() => {}}`,
		reject: ({ target }) => js`${target}.value=${fallback}`
	}), { id: 'descriptor-fallback-hole', onerror: (error) => reports.push(error) });
	const target = client();
	const root = target.head(result.head);
	ready.resolve(1);
	target.block((await result.tail.next()).value);
	assert.is(reports.length, 1);
	assert.match(reports[0].message, /resolve\(\), template hole 1: received a function/);
	assert.is(root.value.ok, true);
});

test('starts nested operation descriptors only after committed output', async () => {
	class Job { constructor(ready) { this.ready = ready; } }
	const outer = deferred();
	const nested = deferred();
	const root_job = new Job(outer);
	const nested_job = new Job(nested);
	let then_reads = 0;
	const replacer = (value, js) => value instanceof Job && ({
		type: 'async-value',
		source: { get then() { then_reads++; return value.ready.promise.then.bind(value.ready.promise); } },
		construct: (capture) => js`({control:${capture(js`[]`)},value:null})`,
		resolve: ({ target }, payload) => js`${target}.value=${payload}`,
		reject: () => js``
	});
	const result = await unevalStream(root_job, replacer, { id: 'nested-operation-source' });
	const target = client();
	const root = target.head(result.head);
	assert.is(then_reads, 1);
	outer.resolve(nested_job);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.is(then_reads, 1);
	const block = await result.tail.next();
	target.block(block.value);
	assert.is(then_reads, 2);
	nested.resolve({ done: true });
	for await (const block of result.tail) target.block(block);
	assert.is(root.value.value.done, true);
});

test('rolls back a nested descriptor before an invalid operation hole', async () => {
	class Job {}
	const ready = deferred();
	const nested = new Job();
	let then_reads = 0;
	let cancels = 0;
	const root_job = {};
	const reports = [];
	const result = await unevalStream(root_job, (value, js) => {
		if (value === nested) return {
			type: 'async-value',
			source: { get then() { then_reads++; return () => {}; } },
			construct: () => js`({})`, resolve: () => js``, reject: () => js``,
			cancel() { cancels++; }
		};
		if (value === root_job) return {
			type: 'async-value', source: ready.promise,
			construct: () => js`({error:null})`,
			resolve: () => js`${nested};${() => {}}`,
			reject: ({ target }, error) => js`${target}.error=${error}`
		};
	}, { id: 'operation-transaction', onerror: (error) => reports.push(error) });
	const target = client();
	const root = target.head(result.head);
	ready.resolve(1);
	target.block((await result.tail.next()).value);
	assert.is(reports.length, 1);
	assert.match(root.error.message, /failed to serialize asynchronous value/);
	assert.is(then_reads, 0);
	assert.is(cancels, 0);
});

test('rejects atomic descriptor cycles and permits container-mediated cycles', async () => {
	class Job { constructor() { this.child = this; this.ready = new Promise(() => {}); } }
	const atomic = new Job();
	const error = await rejected(unevalStream(atomic, (value, js) => value instanceof Job && ({
		type: 'async-value', source: value.ready,
		construct: () => js`({child:${value.child}})`, resolve: () => js``, reject: () => js``
	})));
	assert.match(error.message, /atomic custom cycle/);

	const mixed = new Job();
	const holder = { child: mixed };
	mixed.child = holder;
	const result = await unevalStream(mixed, (value, js) => value instanceof Job && ({
		type: 'async-value', source: value.ready,
		construct: () => js`({child:${value.child}})`, resolve: () => js``, reject: () => js``
	}));
	const root = client().head(result.head);
	assert.is(root.child.child, root);
	await result.tail.return();
});

test.run();
