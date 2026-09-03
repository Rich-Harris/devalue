import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { suite } from 'uvu';
import * as assert from 'uvu/assert';
import { unevalStream } from '../index.js';

const test = suite('unevalStream');

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((a, b) => {
		resolve = a;
		reject = b;
	});
	return { promise, resolve, reject };
}

function client(extra = {}) {
	const context = vm.createContext({ ...extra });
	context.globalThis = context;
	context.__window = context;
	return {
		context,
		head(source) {
			return vm.runInContext(`(${source})`, context);
		},
		block(source) {
			return vm.runInContext(source, context);
		}
	};
}

async function drain(result, target = client()) {
	const root = target.head(result.head);
	const blocks = [];
	for await (const block of result.tail) {
		blocks.push(block);
		target.block(block);
	}
	return { root, blocks, client: target };
}

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function rejects(promise, match) {
	let error;
	try {
		await promise;
	} catch (caught) {
		error = caught;
	}
	assert.ok(error);
	if (match instanceof RegExp) assert.match(error.message, match);
	else if (match !== undefined) assert.is(error, match);
}

test('serializes synchronous primitives and graphs', async () => {
	const cycle = { value: 1 };
	cycle.self = cycle;
	const { root, blocks } = await drain(await unevalStream({ cycle, repeated: cycle }));
	assert.is(root.cycle, root.repeated);
	assert.is(root.cycle.self, root.cycle);
	assert.equal(blocks, []);
});

test('no async values create no client session', async () => {
	const target = client();
	const result = await unevalStream({ value: 1 });
	assert.equal({ ...target.head(result.head) }, { value: 1 });
	assert.is(target.context.__d, undefined);
	assert.equal(await result.tail.next(), { done: true, value: undefined });
});

test('preserves sparse arrays, maps, sets, buffers, and views', async () => {
	const array = Array(8);
	array[3] = 'x';
	const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
	const view = new Uint16Array(buffer, 0, 2);
	const key = {};
	const { root } = await drain(await unevalStream({ array, map: new Map([[key, view]]), set: new Set([key]), buffer }));
	assert.is(root.array.length, 8);
	assert.ok(!(0 in root.array));
	assert.is(root.array[3], 'x');
	const revived_key = Array.from(root.map.keys())[0];
	assert.is(Array.from(root.set)[0], revived_key);
	assert.is(root.map.get(revived_key).buffer, root.buffer);
});

test('preserves identity from head into a promise outcome', async () => {
	const pending = deferred();
	const shared = { value: 1 };
	const result = await unevalStream({ shared, pending: pending.promise }, undefined, { id: 'head-tail' });
	const target = client();
	const root = target.head(result.head);
	pending.resolve(shared);
	const next = await result.tail.next();
	target.block(next.value);
	assert.is(await root.pending, root.shared);
});

test('preserves identity between separate promise outcomes', async () => {
	const a = deferred();
	const b = deferred();
	const shared = { value: 1 };
	const result = await unevalStream([a.promise, b.promise], undefined, { id: 'tail-tail' });
	const target = client();
	const root = target.head(result.head);
	a.resolve(shared);
	b.resolve(shared);
	for await (const block of result.tail) target.block(block);
	assert.is(await root[0], await root[1]);
});

test('recognizes only branded native promises across realms and subclasses', async () => {
	const foreign = vm.runInNewContext('Promise.resolve(2)');
	class SubPromise extends Promise {}
	const values = [Promise.resolve(1), foreign, SubPromise.resolve(3)];
	const { root } = await drain(await unevalStream(values, undefined, { id: 'promise-brands' }));
	assert.equal(await Promise.all(Array.from(root)), [1, 2, 3]);

	const spoof = { [Symbol.toStringTag]: 'Promise', then() {} };
	await rejects(unevalStream(spoof), /Cannot stringify/);
});

test('preserves serializable rejection reason identity across regions', async () => {
	const first = deferred();
	const second = deferred();
	const reason = { message: 'shared' };
	const result = await unevalStream({ reason, first: first.promise, second: second.promise }, undefined, { id: 'reason-identity' });
	const target = client();
	const root = target.head(result.head);
	first.reject(reason);
	await delay(5);
	target.block((await result.tail.next()).value);
	let first_reason;
	try { await root.first; } catch (error) { first_reason = error; }
	second.reject(reason);
	target.block((await result.tail.next()).value);
	let second_reason;
	try { await root.second; } catch (error) { second_reason = error; }
	assert.is(first_reason, root.reason);
	assert.is(second_reason, root.reason);
});

test('batches promise settlements observed in one flush window', async () => {
	const a = deferred();
	const b = deferred();
	const result = await unevalStream([a.promise, b.promise], undefined, { id: 'batch' });
	const target = client();
	target.head(result.head);
	a.resolve(1);
	b.resolve(2);
	const first = await result.tail.next();
	target.block(first.value);
	assert.equal(await result.tail.next(), { done: true, value: undefined });
});

test('collects settlements until the current batch is consumed', async () => {
	const a = deferred();
	const b = deferred();
	const result = await unevalStream([a.promise, b.promise], undefined, { id: 'frozen' });
	const target = client();
	target.head(result.head);
	a.resolve(1);
	await delay(5);
	b.resolve(2);
	await delay(5);
	const first = await result.tail.next();
	const second = await result.tail.next();
	assert.ok(!first.done && second.done);
	target.block(first.value);
});

test('rejects an unserializable asynchronous fulfillment', async () => {
	const pending = deferred();
	const result = await unevalStream(pending.promise, undefined, { id: 'invalid' });
	const target = client();
	const root = target.head(result.head);
	const rejected = rejects(root, /failed to serialize asynchronous value/);
	pending.resolve(() => {});
	const block = await result.tail.next();
	target.block(block.value);
	await rejected;
});

test('rolls back nested async values from a failed event', async () => {
	const pending = deferred();
	const nested = deferred();
	const result = await unevalStream(pending.promise, undefined, { id: 'rollback' });
	const target = client();
	const root = target.head(result.head);
	const rejected = rejects(root);
	pending.resolve({ nested: nested.promise, invalid: () => {} });
	const block = await result.tail.next();
	target.block(block.value);
	await rejected;
	nested.resolve(1);
	assert.equal(await result.tail.next(), { done: true, value: undefined });
});

test('rolls back provisional source state without touching its lifecycle', async () => {
	const outer = deferred();
	const nested = deferred();
	let then_reads = 0;
	let cancels = 0;
	class Job {}
	const job = new Job();
	const source = { get then() { then_reads++; return nested.promise.then.bind(nested.promise); } };
	const replacer = (value, js) => value === job && ({
		type: 'async-value', source, construct: () => js`({})`,
		resolve: () => js``, reject: () => js``,
		cancel() { cancels++; return Promise.reject(new Error('cleanup')); }
	});
	const result = await unevalStream(outer.promise, replacer, { id: 'transaction-rollback' });
	const target = client();
	const root = target.head(result.head);
	const rejected = rejects(root);
	outer.resolve({ job, invalid: () => {} });
	target.block((await result.tail.next()).value);
	await rejected;
	await delay();
	assert.is(then_reads, 0);
	assert.is(cancels, 0);
	assert.equal(await result.tail.next(), { done: true, value: undefined });
});

test('preserves map key identity through a collection sidecar', async () => {
	const pending = deferred();
	const key = {};
	const result = await unevalStream({ map: new Map([[key, 1]]), pending: pending.promise }, undefined, { id: 'map' });
	assert.not.match(result.head, /Array\.from\(/);
	const target = client();
	const root = target.head(result.head);
	pending.resolve(key);
	const block = await result.tail.next();
	assert.not.match(block.value, /Array\.from\(/);
	target.block(block.value);
	assert.is(await root.pending, Array.from(root.map.keys())[0]);
});

test('preserves set member identity through a collection sidecar', async () => {
	const pending = deferred();
	const member = {};
	const result = await unevalStream({ set: new Set([member]), pending: pending.promise }, undefined, { id: 'set' });
	const target = client();
	const root = target.head(result.head);
	pending.resolve(member);
	target.block((await result.tail.next()).value);
	assert.is(await root.pending, Array.from(root.set)[0]);
});

test('preserves a typed view backing buffer across regions', async () => {
	const pending = deferred();
	const view = new Uint8Array([1, 2]);
	const result = await unevalStream({ view, pending: pending.promise }, undefined, { id: 'buffer' });
	const target = client();
	const root = target.head(result.head);
	pending.resolve(view.buffer);
	target.block((await result.tail.next()).value);
	assert.is(await root.pending, root.view.buffer);
});

test('preserves custom child identity from the shared replacer session', async () => {
	class Wrapper { constructor(value) { this.value = value; } }
	const shared = {};
	let calls = 0;
	const result = await unevalStream(
		{ shared, wrapped: new Wrapper(shared) },
		(value, js) => {
			if (!(value instanceof Wrapper)) return;
			calls++;
			return js`({value:${value.value}})`;
		}
	);
	const { root } = await drain(result);
	assert.is(calls, 1);
	assert.is(root.shared, root.wrapped.value);
});

test('plans legacy custom emission synchronously and invokes replacers once', async () => {
	class Wrapper { constructor(value) { this.value = value; } }
	const pending = deferred();
	const child = { count: 1, values: [1] };
	let calls = 0;
	let yielded = false;
	queueMicrotask(() => { yielded = true; });
	const result_promise = unevalStream(
		{ child, wrapped: new Wrapper(child), pending: pending.promise },
		(value, js) => {
			if (!(value instanceof Wrapper)) return;
			calls++;
			assert.ok(!yielded);
			return js`({value:${value.value}})`;
		},
		{ id: 'custom-plan' }
	);
	assert.is(calls, 1);
	const result = await result_promise;
	const target = client();
	const root = target.head(result.head);
	assert.is(root.wrapped.value, root.child);
	assert.is(root.child.count, 1);
	assert.is(root.child.values[0], 1);
	assert.is(calls, 1);
	await result.tail.return();
});

test('composes a custom object dependency exactly once', async () => {
	class Wrapper { constructor(value) { this.value = value; } }
	let calls = 0;
	const { root } = await drain(await unevalStream(new Wrapper({ x: 1 }), (value, js) => {
		if (!(value instanceof Wrapper)) return;
		calls++;
		return js`({value:${value.value}})`;
	}));
	assert.is(calls, 1);
	assert.equal({ ...root.value }, { x: 1 });
});

test('emits object children reachable only through custom source', async () => {
	class Wrapper { constructor(value) { this.value = value; } }
	const { root } = await drain(await unevalStream(
		new Wrapper({ x: 1 }),
		(value, js) => value instanceof Wrapper && js`({value:${value.value}})`
	));
	assert.equal({ ...root.value }, { x: 1 });
});

test('preserves identity when one custom child source is repeated', async () => {
	class Wrapper { constructor(value) { this.value = value; } }
	const { root } = await drain(await unevalStream(new Wrapper({}), (value, js) => {
		if (!(value instanceof Wrapper)) return;
		const child = js`${value.value}`;
		return js`[${child},${child}]`;
	}));
	assert.is(root[0], root[1]);
});

test('serializes primitive holes in custom source', async () => {
	class Wrapper { constructor(value) { this.value = value; } }
	const { root } = await drain(await unevalStream(new Wrapper(undefined), (value, js) => {
		if (!(value instanceof Wrapper)) return;
		return js`[${value.value}]`;
	}));
	assert.is(root[0], undefined);
});

test('preserves replacement metacharacters in descriptor capture expressions', async () => {
	for (const text of ['$&', '$`', "$'", '$$']) {
		const result = await unevalStream({}, (_value, js) => ({
			type: 'async-value',
			source: Promise.resolve(1),
			construct: (capture) => capture(js`${text}`),
			resolve: () => js``,
			reject: () => js``
		}));
		const { root } = await drain(result);
		assert.is(root, text);
	}
});

test('rejects Symbol children passed to a custom replacer', async () => {
	class Wrapper { constructor(value) { this.value = value; } }
	await rejects(
		unevalStream(new Wrapper(Symbol('child')), (value, js) => value instanceof Wrapper && js`[${value.value}]`),
		/Cannot stringify a Symbol primitive/
	);
});

test('ignores unused custom object children without retaining stream state', async () => {
	class Wrapper { constructor(value) { this.value = value; } }
	class Job {}
	const job = new Job();
	let then_reads = 0;
	let cancels = 0;
	const source = { get then() { then_reads++; return () => {}; } };
	const replacer = (value, js) => {
		if (value instanceof Wrapper) {
			for (let i = 0; i < 100; i++) js`${i % 2 ? job : Promise.resolve(i)}`;
			return js`({value:1})`;
		}
		if (value === job) return {
			type: 'async-value', source, construct: () => js`({})`,
			resolve: () => js``, reject: () => js``, cancel() { cancels++; }
		};
	};
	const result = await unevalStream(new Wrapper(job), replacer, { id: 'unused-child' });
	assert.not.match(result.head, /globalThis\.__d/);
	assert.is(client().head(result.head).value, 1);
	assert.not.match(result.head, /pending|slots|__d/);
	assert.is(then_reads, 0);
	assert.is(cancels, 0);
	assert.equal(await result.tail.next(), { done: true, value: undefined });
});

test('reconstructs mixed custom and plain object cycles', async () => {
	class Wrapper { constructor() { this.value = undefined; } }
	const wrapper = new Wrapper();
	const object = { wrapper };
	wrapper.value = object;
	const { root } = await drain(await unevalStream(
		wrapper,
		(value, js) => value instanceof Wrapper && js`({value:${value.value}})`
	));
	assert.is(root.value.wrapper, root);
});

test('constructs custom child views after their buffers and before their target', async () => {
	class Wrapper { constructor(value) { this.value = value; } }
	const buffer = new ArrayBuffer(8);
	const view = new Uint8Array(buffer, 2, 3);
	const { root } = await drain(await unevalStream(new Wrapper(view), (value, js) => {
		if (!(value instanceof Wrapper)) return;
		const child = js`${value.value}`;
		return js`({view:${child},buffer:${child}.buffer})`;
	}));
	assert.is(Object.prototype.toString.call(root.view), '[object Uint8Array]');
	assert.is(root.view.buffer, root.buffer);
	assert.is(root.view.byteOffset, 2);
	assert.is(root.view.length, 3);
});

test('does not replace protocol alias text that resembles a custom token', async () => {
	class Wrapper { constructor(value) { this.value = value; } }
	const text = '"0"';
	const { root } = await drain(await unevalStream(new Wrapper({}), (value, js) => {
		if (!(value instanceof Wrapper)) return;
		return js`({text:${text},value:${value.value}})`;
	}, { id: 'collision' }));
	assert.is(root.text, text);
});

test('rejects atomic custom cycles clearly', async () => {
	class Wrapper { constructor() { this.value = this; } }
	const wrapper = new Wrapper();
	await rejects(
		unevalStream(wrapper, (value, js) => value instanceof Wrapper && js`({value:${value.value}})`),
		/atomic custom cycle/
	);
});

test('rejects atomic custom cycles discovered in Promise outcomes', async () => {
	class Wrapper { constructor() { this.value = this; } }
	const pending = deferred();
	const result = await unevalStream(pending.promise, (value, js) =>
		value instanceof Wrapper && js`({value:${value.value}})`
	, { id: 'async-custom-cycle' });
	const target = client();
	const root = target.head(result.head);
	const rejected = rejects(root, /failed to serialize asynchronous value/);
	pending.resolve(new Wrapper());
	target.block((await result.tail.next()).value);
	await rejected;
	assert.equal(await result.tail.next(), { done: true, value: undefined });
	assert.ok(!Object.hasOwn(target.context.__d, 'async-custom-cycle'));
	assert.is(Object.getPrototypeOf(target.context.__d), null);
});

test('discards nested async sources when custom-cycle validation fails', async () => {
	class Wrapper { constructor() { this.value = this; } }
	class Job { constructor() { this.started = false; } }
	const pending = deferred();
	const job = new Job();
	const result = await unevalStream(pending.promise, (value, js) => {
		if (value instanceof Wrapper) return js`({value:${value.value}})`;
		if (value instanceof Job) return {
			type: 'async-value',
			source: value,
			construct: () => js`({})`,
			then: () => { value.started = true; },
			resolve: () => js``,
			reject: () => js``
		};
	}, { id: 'failed-cycle-source' });
	const target = client();
	const root = target.head(result.head);
	const rejected = rejects(root, /failed to serialize asynchronous value/);
	pending.resolve({ job, invalid: new Wrapper() });
	target.block((await result.tail.next()).value);
	await rejected;
	assert.is(job.started, false);
	assert.equal(await result.tail.next(), { done: true, value: undefined });
});

test('adapts a nonthenable custom async value', async () => {
	class Job { constructor(completion) { this.completion = completion; } }
	const pending = deferred();
	const replacer = (value, js) => value instanceof Job && ({
		type: 'async-value', source: value.completion,
		construct: () => js`({value:void 0,error:void 0,resolve(v){this.value=v},reject(e){this.error=e}})`,
		resolve: ({ target }, payload) => js`${target}.resolve(${payload})`,
		reject: ({ target }, reason) => js`${target}.reject(${reason})`
	});
	const result = await unevalStream(new Job(pending.promise), replacer, { id: 'job' });
	const target = client();
	const root = target.head(result.head);
	pending.resolve({ ok: true });
	target.block((await result.tail.next()).value);
	assert.equal({ ...root.value }, { ok: true });
});

test('normalizes a misbehaving custom thenable', async () => {
	const source = { then(resolve, reject) { resolve(1); reject(2); throw new Error('late'); } };
	const replacer = (_value, js) => ({
		type: 'async-value', source, construct: () => js`({values:[],set(v){this.values.push(v)}})`,
		resolve: ({ target }, value) => js`${target}.set(${value})`, reject: ({ target }, value) => js`${target}.set(${value})`
	});
	const { root } = await drain(await unevalStream({}, replacer, { id: 'thenable' }));
	assert.equal(Array.from(root.values), [1]);
});

test('keeps distinct custom values distinct when they share a source', async () => {
	const pending = deferred();
	class Job {}
	const replacer = (value, js) => value instanceof Job && ({
		type: 'async-value', source: pending.promise, construct: () => js`({value:void 0})`,
		resolve: ({ target }, source) => js`${target}.value=${source}`,
		reject: ({ target }, source) => js`${target}.value=${source}`
	});
	const result = await unevalStream([new Job(), new Job()], replacer, { id: 'distinct' });
	const target = client();
	const root = target.head(result.head);
	assert.ok(root[0] !== root[1]);
	pending.resolve(1);
	for await (const block of result.tail) target.block(block);
	assert.is(root[0].value, 1);
	assert.is(root[1].value, 1);
});

function sequence_replacer(source) {
	return (value, js) => value === source && ({
		type: 'async-sequence', source,
		construct: () => js`({events:[],next(v){this.events.push(["next",v])},complete(v){this.events.push(["complete",v])},error(v){this.events.push(["error",v])}})`,
		next: ({ target }, value) => js`${target}.next(${value})`,
		complete: ({ target }, value) => js`${target}.complete(${value})`,
		error: ({ target }, value) => js`${target}.error(${value})`
	});
}

test('feeds async iterable yields and return value into the client target', async () => {
	const source = { async *[Symbol.asyncIterator]() { yield 1; yield 2; return 3; } };
	const { root } = await drain(await unevalStream(source, sequence_replacer(source), { id: 'sequence' }));
	assert.equal(JSON.parse(JSON.stringify(root.events)), [['next', 1], ['next', 2], ['complete', 3]]);
});

test('natively reconstructs async iterables as buffered iterators', async () => {
	const shared = { value: 1 };
	const source = { async *[Symbol.asyncIterator]() { yield shared; yield 2; return shared; } };
	const result = await unevalStream({ shared, source }, undefined, { id: 'native-sequence' });
	const target = client();
	const root = target.head(result.head);
	assert.is(root.source[Symbol.asyncIterator](), root.source);
	assert.equal(Reflect.ownKeys(root.source).filter((key) => typeof key === 'string').sort(), ['next', 'return', 'throw']);
	assert.is(root.source._n, undefined);
	assert.is(root.source._c, undefined);
	assert.is(root.source._e, undefined);
	const first = root.source.next();
	const second = root.source.next();
	const third = root.source.next();
	for await (const block of result.tail) target.block(block);
	const a = await first;
	const b = await second;
	const c = await third;
	assert.is(a.done, false);
	assert.is(a.value, root.shared);
	assert.is(b.done, false);
	assert.is(b.value, 2);
	assert.is(c.done, true);
	assert.is(c.value, root.shared);
});

test('reads the native async iterator getter once after descriptor commit', async () => {
	let reads = 0;
	let replaced = false;
	const source = {
		get [Symbol.asyncIterator]() {
			reads++;
			assert.ok(replaced);
			return async function* () { yield 1; };
		}
	};
	const { root } = await drain(await unevalStream(source, (value) => {
		if (value === source) replaced = true;
	}));
	assert.is(reads, 1);
	assert.equal({ ...await root.next() }, { done: false, value: 1 });
});

test('buffers native async iterable events before client next', async () => {
	const source = { async *[Symbol.asyncIterator]() { yield 1; return 2; } };
	const { root } = await drain(await unevalStream(source, undefined, { id: 'native-buffer' }));
	assert.equal({ ...await root.next() }, { done: false, value: 1 });
	assert.equal({ ...await root.next() }, { done: true, value: 2 });
});

test('delivers buffered native yields before source errors', async () => {
	const reason = 'source failure';
	const source = { async *[Symbol.asyncIterator]() { yield 1; throw reason; } };
	const { root } = await drain(await unevalStream(source, undefined, { id: 'native-buffer-error' }));
	assert.equal({ ...await root.next() }, { done: false, value: 1 });
	await rejects(root.next(), reason);
});

test('settles multiple pending native next calls on terminal events', async () => {
	for (const terminal of ['complete', 'error']) {
		const ready = deferred();
		const reason = 'terminal';
		const source = {
			async *[Symbol.asyncIterator]() {
				await ready.promise;
				if (terminal === 'error') throw reason;
				return 7;
			}
		};
		const result = await unevalStream(source, undefined, { id: `native-pending-${terminal}` });
		const target = client();
		const root = target.head(result.head);
		const pending = [root.next(), root.next(), root.next()];
		const rejected = terminal === 'error' ? pending.map((item) => rejects(item, reason)) : [];
		ready.resolve();
		for await (const block of result.tail) target.block(block);
		if (terminal === 'complete') {
			const settled = await Promise.all(pending);
			for (const item of settled) assert.equal({ ...item }, { done: true, value: 7 });
			assert.ok(settled[0] !== settled[1] && settled[1] !== settled[2]);
		} else {
			await Promise.all(rejected);
		}
	}
});

test('reports native async iterable failures and unserializable yields', async () => {
	for (const source of [
		{ async *[Symbol.asyncIterator]() { throw new Error('source failure'); } },
		{ async *[Symbol.asyncIterator]() { yield () => {}; } }
	]) {
		const result = await unevalStream(source);
		const target = client();
		const root = target.head(result.head);
		const failed = rejects(root.next());
		for await (const block of result.tail) target.block(block);
		await failed;
	}
});

test('server cancellation closes a native async generator', async () => {
	let finalized = false;
	const source = { async *[Symbol.asyncIterator]() { try { yield 1; yield 2; } finally { finalized = true; } } };
	const result = await unevalStream(source, undefined, { id: 'native-cancel' });
	await result.tail.return();
	assert.ok(finalized);
});

test('native client return and throw are local and ignore later updates', async () => {
	for (const method of ['return', 'throw']) {
		const ready = deferred();
		let returned = 0;
		const source = {
			[Symbol.asyncIterator]() { return this; },
			async next() { await ready.promise; return { done: false, value: 1 }; },
			return() { returned++; return { done: true }; }
		};
		const result = await unevalStream(source, undefined, { id: `native-local-${method}` });
		const target = client();
		const root = target.head(result.head);
		const pending = root.next();
		const reason = new Error('local');
		if (method === 'return') {
			assert.equal({ ...await root.return(7) }, { done: true, value: 7 });
			assert.equal({ ...await pending }, { done: true, value: 7 });
		} else {
			await rejects(root.throw(reason), reason);
			await rejects(pending, reason);
		}
		assert.is(returned, 0);
		ready.resolve();
		const block = await result.tail.next();
		if (!block.done) target.block(block.value);
		await result.tail.return();
		assert.is(returned, 1);
	}
});

test('replacer overrides native async iterable handling', async () => {
	const source = { async *[Symbol.asyncIterator]() { yield 1; } };
	const { root, blocks } = await drain(await unevalStream(source, (value, js) => value === source && js`({overridden:true})`));
	assert.is(root.overridden, true);
	assert.equal(blocks, []);
});

test('turns malformed native async iterable protocols into client errors', async () => {
	const sources = [
		{ get [Symbol.asyncIterator]() { throw new Error('getter'); } },
		{ [Symbol.asyncIterator]: 1 },
		{ [Symbol.asyncIterator]() { return null; } },
		{ [Symbol.asyncIterator]() { return {}; } },
		{ [Symbol.asyncIterator]() { return { next() { return null; } }; } }
	];
	for (const source of sources) {
		const result = await unevalStream(source);
		const target = client();
		const root = target.head(result.head);
		const failed = rejects(root.next());
		for await (const block of result.tail) target.block(block);
		await failed;
	}
});

test('reads a throwing native async iterator getter once and reports it to the client', async () => {
	let reads = 0;
	let replaced = false;
	const source = {
		get [Symbol.asyncIterator]() {
			reads++;
			assert.ok(replaced);
			throw new Error('getter');
		}
	};
	const result = await unevalStream(source, (value) => {
		if (value === source) replaced = true;
	});
	assert.is(reads, 1);
	const target = client();
	const root = target.head(result.head);
	const failed = rejects(root.next());
	for await (const block of result.tail) target.block(block);
	await failed;
	assert.is(reads, 1);
});

test('preserves sequence return-value identity', async () => {
	const shared = { value: 1 };
	const source = { async *[Symbol.asyncIterator]() { yield shared; return shared; } };
	const { root } = await drain(await unevalStream({ shared, source }, sequence_replacer(source), { id: 'sequence-return-identity' }));
	assert.is(root.source.events[0][1], root.shared);
	assert.is(root.source.events[1][1], root.shared);
});

test('keeps distinct sequence descriptors sharing an iterator source distinct', async () => {
	class Sequence {}
	const iterator = {
		count: 0,
		next() { return Promise.resolve(++this.count <= 2 ? { done: false, value: this.count } : { done: true, value: 'done' }); }
	};
	const source = { [Symbol.asyncIterator]() { return iterator; } };
	const replacer = (value, js) => value instanceof Sequence && ({
		type: 'async-sequence', source,
		construct: () => js`({events:[]})`,
		next: ({ target }, value) => js`${target}.events.push(${value})`,
		complete: ({ target }, value) => js`${target}.events.push(${value})`,
		error: ({ target }, value) => js`${target}.events.push(${value})`
	});
	const { root } = await drain(await unevalStream([new Sequence(), new Sequence()], replacer, { id: 'shared-iterator' }));
	assert.ok(root[0] !== root[1]);
	assert.equal(Array.from(root[0].events), [1, 'done']);
	assert.equal(Array.from(root[1].events), [2, 'done']);
});

test('includes at most one sequence item in each batch', async () => {
	let pulls = 0;
	const source = { [Symbol.asyncIterator]() { return this; }, async next() { pulls++; return pulls < 3 ? { done: false, value: pulls } : { done: true }; } };
	const result = await unevalStream(source, sequence_replacer(source), { id: 'coalesce' });
	const target = client();
	const root = target.head(result.head);
	assert.is(pulls, 2);
	assert.equal(JSON.parse(JSON.stringify(root.events)), [['next', 1]]);
	for await (const block of result.tail) target.block(block);
	assert.equal(JSON.parse(JSON.stringify(root.events)), [['next', 1], ['next', 2], ['complete', null]]);
});

test('backpressures an async sequence until flushed blocks are consumed', async () => {
	let pulls = 0;
	const gates = [];
	const source = {
		[Symbol.asyncIterator]() { return this; },
		next() {
			pulls++;
			const gate = deferred();
			gates.push(gate);
			return gate.promise;
		}
	};
	const result = await unevalStream(source, sequence_replacer(source), { id: 'pressure' });
	const target = client();
	target.head(result.head);
	assert.is(pulls, 1);
	// an observed item is not re-pulled until its batch is consumed
	gates[0].resolve({ done: false, value: 1 });
	await delay(5);
	assert.is(pulls, 1);
	target.block((await result.tail.next()).value);
	await delay(5);
	assert.is(pulls, 2);
	gates[1].resolve({ done: false, value: 2 });
	target.block((await result.tail.next()).value);
	await delay(5);
	assert.is(pulls, 3);
	gates[2].resolve({ done: true });
	target.block((await result.tail.next()).value);
	assert.equal(await result.tail.next(), { done: true, value: undefined });
});

test('cancels an async sequence before tail iteration starts', async () => {
	let returned = 0;
	const pending = deferred();
	const source = { [Symbol.asyncIterator]() { return this; }, next() { return pending.promise; }, return() { returned++; return { done: true }; } };
	const result = await unevalStream(source, sequence_replacer(source), { id: 'cancel' });
	const returned_result = result.tail.return();
	pending.resolve({ done: true });
	await returned_result;
	assert.is(returned, 1);
});

test('calls sequence return while next is outstanding', async () => {
	const pending = deferred();
	let pulling = false;
	let returned = 0;
	const source = {
		[Symbol.asyncIterator]() { return this; },
		next() {
			assert.ok(!pulling);
			pulling = true;
			return pending.promise.finally(() => { pulling = false; });
		},
		return() {
			assert.ok(pulling);
			returned++;
			pending.resolve({ done: false, value: 1 });
			return { done: true };
		}
	};
	const result = await unevalStream(source, sequence_replacer(source), { id: 'pending-next-return' });
	const next = result.tail.next();
	const returned_result = result.tail.return();
	assert.equal(await next, { done: true, value: undefined });
	assert.equal(await returned_result, { done: true, value: undefined });
	assert.is(returned, 1);
	assert.equal(await result.tail.next(), { done: true, value: undefined });
});

test('isolates concurrent stream sessions', async () => {
	const a = deferred();
	const b = deferred();
	const first = await unevalStream(a.promise, undefined, { id: 'a' });
	const second = await unevalStream(b.promise, undefined, { id: 'b' });
	const target = client();
	const ar = target.head(first.head);
	const br = target.head(second.head);
	a.resolve(1); b.resolve(2);
	target.block((await first.tail.next()).value);
	target.block((await second.tail.next()).value);
	assert.is(await ar, 1);
	assert.is(await br, 2);
});

test('accepts dangerous session ids as own properties', async () => {
	for (const id of ['__proto__', 'constructor']) {
		const pending = deferred();
		const result = await unevalStream(pending.promise, undefined, { id });
		const target = client();
		const root = target.head(result.head);
		assert.ok(Object.hasOwn(target.context.__d, id));
		assert.is(Object.getPrototypeOf(target.context.__d), null);
		pending.resolve(id);
		target.block((await result.tail.next()).value);
		assert.is(await root, id);
	}
});

test('cleans the client session in the final evaluated block', async () => {
	const pending = deferred();
	const result = await unevalStream(pending.promise, undefined, { id: 'cleanup' });
	const target = client();
	target.head(result.head);
	pending.resolve(1);
	target.block((await result.tail.next()).value);
	assert.ok(!Object.hasOwn(target.context.__d, 'cleanup'));
	assert.is(Object.getPrototypeOf(target.context.__d), null);
});

test('rejects concurrent tail next calls', async () => {
	const pending = deferred();
	const result = await unevalStream(pending.promise, undefined, { id: 'concurrent' });
	client().head(result.head);
	const first = result.tail.next();
	await rejects(result.tail.next(), /concurrent tail\.next\(\)/);
	pending.resolve(1);
	await first;
});

test('rejects pre-aborted signals before invoking a replacer', async () => {
	const controller = new AbortController();
	const reason = new Error('aborted');
	controller.abort(reason);
	let calls = 0;
	await rejects(unevalStream({}, () => { calls++; }, { signal: controller.signal }), reason);
	assert.is(calls, 0);
});

test('rejects aborts raised during descriptor construction', async () => {
	const controller = new AbortController();
	const reason = new Error('aborted during construct');
	let cancels = 0;
	await rejects(unevalStream({}, (_value, js) => ({
		type: 'async-value',
		source: new Promise(() => {}),
		construct() {
			controller.abort(reason);
			return js`0`;
		},
		resolve: () => js``,
		reject: () => js``,
		cancel() { cancels++; }
	}), { signal: controller.signal }), reason);
	assert.is(cancels, 0);
});

test('tail return cancels an outstanding next', async () => {
	let cancels = 0;
	const result = await unevalStream({}, (_value, js) => ({
		type: 'async-value', source: new Promise(() => {}), construct: () => js`0`,
		resolve: () => js``, reject: () => js``, cancel() { cancels++; }
	}));
	const next = result.tail.next();
	assert.equal(await result.tail.return(), { done: true, value: undefined });
	assert.equal(await next, { done: true, value: undefined });
	assert.is(cancels, 1);
});

test('tail return can close a permanently pending sequence pull', async () => {
	const pending = deferred();
	let pulling = false;
	let returned = 0;
	const source = {
		[Symbol.asyncIterator]() { return this; },
		next() {
			pulling = true;
			return pending.promise.finally(() => { pulling = false; });
		},
		return() {
			assert.ok(pulling);
			returned++;
			pending.resolve({ done: true });
			return { done: true };
		}
	};
	const result = await unevalStream(source, sequence_replacer(source));
	const next = result.tail.next();
	const returned_result = result.tail.return();
	assert.equal(await returned_result, { done: true, value: undefined });
	assert.equal(await next, { done: true, value: undefined });
	assert.is(returned, 1);
});

test('reports structural output guardrails', async () => {
	const pending = deferred();
	const deep = { a: { b: { c: {} } } };
	const result = await unevalStream({ deep, pending: pending.promise }, undefined, { id: 'sizes' });
	pending.resolve([deep.a.b.c, deep.a.b.c, deep.a.b.c]);
	const block = (await result.tail.next()).value;
	const message = `raw=${block.length} gzip=${gzipSync(block).length}`;
	assert.not.match(result.head + block, /Array\.from\(/, message);
	assert.is((block.match(/globalThis\.__d\["sizes"\]\.b\(\(s,n\)=>\{/g) ?? []).length, 1, message);
	assert.not.match(result.head, /TypeError|invalid stream namespace|missing stream session|stream id collision|Object\.hasOwn|hasOwnProperty|Reflect\.ownKeys/, message);
	assert.ok(block.length < 300, message);
});

test('guards primitive pending Promise protocol size', async () => {
	const pending = deferred();
	const result = await unevalStream(pending.promise, undefined, { id: 'size' });
	const target = client();
	const root = target.head(result.head);
	pending.resolve(1);
	const block = (await result.tail.next()).value;
	const message = `head=${result.head.length} tail=${block.length}`;
	assert.match(result.head, /\{__proto__:null\}/, message);
	assert.match(result.head, /s=n\["size"\]=\{a:\[\],s:\[\],c:\[\],p:\[\]\}/, message);
	assert.match(block, /s\.p\[0\]\[0\]\(1\);delete s\.p\[0\];delete n\["size"\]/, message);
	assert.not.match(result.head + block, /\.(?:anchors|slots|collections|pending)\b/, message);
	assert.not.match(result.head, /TypeError|invalid stream namespace|missing stream session|stream id collision|Object\.hasOwn|hasOwnProperty|Reflect\.ownKeys/, message);
	assert.ok(result.head.length < 220, message);
	assert.ok(block.length < 100, message);
	target.block(block);
	assert.is(await root, 1);
});

test('guards native sequence adapter structure and size', async () => {
	const ready = deferred();
	const source = { async *[Symbol.asyncIterator]() { await ready.promise; yield 1; return 2; } };
	const result = await unevalStream(source, undefined, { id: 'native-size' });
	// the queue runtime is defined once in the block prelude, ahead of its first use
	const runtime = result.head.match(/s\.f=.*?\}\}\}/)?.[0];
	assert.ok(runtime, result.head);
	const construct = result.head.match(/s\.f\(g=>\{[^}]*\}\)/)?.[0];
	assert.ok(construct, result.head);
	const message = `runtime=${runtime.length} head=${result.head.length}`;
	assert.ok(result.head.indexOf(runtime) < result.head.indexOf(construct), message);
	assert.not.match(runtime, /Promise\.(?:resolve|reject)/, message);
	assert.is((runtime.match(/new Promise/g) ?? []).length, 1, message);
	assert.match(construct, /s\.p\[0\]=g\}/, message);
	assert.not.match(construct, /s\.p\[0\]=\(/, message);
	assert.ok(runtime.length + construct.length < 650, message);
	// the queue runtime is shared: both sequences call s.f but its definition ships once
	const two = await unevalStream(
		{ a: { async *[Symbol.asyncIterator]() {} }, b: { async *[Symbol.asyncIterator]() {} } },
		undefined,
		{ id: 'native-shared' }
	);
	assert.is((two.head.match(/s\.f\(/g) ?? []).length, 2, two.head);
	assert.is((two.head.match(/while\(w\.length/g) ?? []).length, 1, two.head);
	const target = client();
	target.head(result.head);
	ready.resolve();
	// Each iterator pull gets its own batch, including the terminal result.
	const item = (await result.tail.next()).value;
	assert.match(item, /s\.p\[0\]\(0,1\)/, message);
	target.block(item);
	const complete = (await result.tail.next()).value;
	assert.match(complete, /s\.p\[0\]\(1,2\)/, message);
	target.block(complete);
	assert.equal(await result.tail.next(), { done: true, value: undefined });

	const fail = deferred();
	const failed = await unevalStream({ async *[Symbol.asyncIterator]() { await fail.promise; throw new Error('x'); } }, undefined, { id: 'native-size-error' });
	target.head(failed.head);
	fail.resolve();
	const errored = (await failed.tail.next()).value;
	assert.match(errored, /s\.p\[0\]\(2,/, message);
});

test('validates replacer results and descriptor shapes synchronously', async () => {
	for (const value of [true, 1, {}, { nope: true }]) {
		await rejects(unevalStream({}, () => value), /Invalid unevalStream replacer result/);
	}
	for (const [type, missing] of [['async-value', 'resolve'], ['async-sequence', 'next']]) {
		const descriptor = type === 'async-value'
			? { type, source: {}, construct: () => ({}), resolve() {}, reject() {} }
			: { type, source: {}, construct: () => ({}), next() {}, complete() {}, error() {} };
		delete descriptor[missing];
		await rejects(unevalStream({}, () => descriptor), new RegExp(`Invalid ${type} ${missing}`));
	}
});

test('rejects multiple descriptor capture calls and invokes construct once', async () => {
	let constructs = 0;
	const replacer = (_value, js) => ({
		type: 'async-value', source: new Promise(() => {}),
		construct(capture) { constructs++; capture(js`1`); capture(js`2`); return js`0`; },
		resolve: () => js``, reject: () => js``
	});
	await rejects(unevalStream({}, replacer), /capture may only be called once/);
	assert.is(constructs, 1);
});

test('reads a custom then exactly once and binds its receiver', async () => {
	let reads = 0;
	const source = {
		get then() {
			reads++;
			return function (resolve) { assert.is(this, source); resolve(7); };
		}
	};
	const replacer = (_value, js) => ({
		type: 'async-value', source, construct: () => js`({value:0})`,
		resolve: ({ target }, value) => js`${target}.value=${value}`,
		reject: ({ target }, value) => js`${target}.value=${value}`
	});
	const { root } = await drain(await unevalStream({}, replacer, { id: 'then-read' }));
	assert.is(root.value, 7);
	assert.is(reads, 1);
});

test('turns custom then lookup and call failures into client rejection events', async () => {
	for (const source of [
		{ get then() { throw new Error('lookup'); } },
		{ then: 1 },
		{ then() { throw new Error('call'); } }
	]) {
		const job = {};
		const replacer = (value, js) => value === job && ({
			type: 'async-value', source, construct: () => js`({error:void 0})`,
			resolve: ({ target }, value) => js`${target}.value=${value}`,
			reject: ({ target }, value) => js`${target}.error=${value}`
		});
		const { root } = await drain(await unevalStream(job, replacer));
		assert.ok(root.error && typeof root.error.message === 'string');
	}
});

test('adopts nested thenables for custom async values', async () => {
	const source = { then(resolve) { resolve({ then(resolve) { resolve(42); } }); } };
	const replacer = (_value, js) => ({
		type: 'async-value', source, construct: () => js`({value:0})`,
		resolve: ({ target }, value) => js`${target}.value=${value}`,
		reject: ({ target }, value) => js`${target}.value=${value}`
	});
	const { root } = await drain(await unevalStream({}, replacer));
	assert.is(root.value, 42);
});

test('walks async outcomes when observed to discover nested async sources', async () => {
	const outer = deferred();
	const inner = deferred();
	const value = { inner: inner.promise };
	const result = await unevalStream(outer.promise, undefined, { id: 'event-walk' });
	const target = client();
	const root = target.head(result.head);
	outer.resolve(value);
	await delay(5);
	target.block((await result.tail.next()).value);
	const resolved = await root;
	inner.resolve(42);
	target.block((await result.tail.next()).value);
	assert.is(await resolved.inner, 42);
});

test('isolates a failed event from valid work in the same batch', async () => {
	const a = deferred();
	const b = deferred();
	const result = await unevalStream([a.promise, b.promise], undefined, { id: 'isolated-batch' });
	const target = client();
	const root = target.head(result.head);
	const bad = rejects(root[0], /failed to serialize asynchronous value/);
	a.resolve(() => {});
	b.resolve(9);
	target.block((await result.tail.next()).value);
	await bad;
	assert.is(await root[1], 9);
});

test('preserves cycles and nested promises first discovered in outcomes', async () => {
	const outer = deferred();
	const inner = deferred();
	const cycle = { inner: inner.promise };
	cycle.self = cycle;
	const result = await unevalStream(outer.promise, undefined, { id: 'nested-outcome' });
	const target = client();
	const root = target.head(result.head);
	outer.resolve(cycle);
	target.block((await result.tail.next()).value);
	const revived = await root;
	assert.is(revived.self, revived);
	inner.resolve(cycle);
	target.block((await result.tail.next()).value);
	assert.is(await revived.inner, revived);
});

test('overrides native promise handling through the replacer', async () => {
	const pending = deferred();
	const replacer = (value, js) => value === pending.promise && js`({overridden:true})`;
	const result = await unevalStream(pending.promise, replacer);
	const { root, blocks } = await drain(result);
	assert.is(root.overridden, true);
	assert.equal(blocks, []);
});

test('reports operation fallback and fatal error boundaries', async () => {
	const pending = deferred();
	const replacer = (_value, js) => ({
		type: 'async-value', source: pending.promise, construct: () => js`({error:void 0})`,
		resolve() { throw new Error('resolve generation'); },
		reject: ({ target }, reason) => js`${target}.error=${reason}`
	});
	const result = await unevalStream({}, replacer, { id: 'operation-fallback' });
	const target = client();
	const root = target.head(result.head);
	pending.resolve(1);
	target.block((await result.tail.next()).value);
	assert.match(root.error.message, /failed to serialize asynchronous value/);

	const fatal = deferred();
	const broken = (_value, js) => ({
		type: 'async-value', source: fatal.promise, construct: () => js`0`,
		resolve: () => 1, reject: () => 1
	});
	const failed = await unevalStream({}, broken, { id: 'operation-fatal' });
	client().head(failed.head);
	fatal.resolve(1);
	await rejects(failed.tail.next(), /Invalid async descriptor operation/);
});

test('reports serialization failures through onerror without affecting the stream', async () => {
	const reports = [];
	const pending = deferred();
	const fn = () => {};
	const result = await unevalStream(pending.promise, undefined, {
		id: 'onerror',
		onerror(error, value) { reports.push([error, value]); }
	});
	const target = client();
	const root = target.head(result.head);
	const rejected = rejects(root, /failed to serialize asynchronous value/);
	pending.resolve(fn);
	target.block((await result.tail.next()).value);
	await rejected;
	assert.is(reports.length, 1);
	assert.match(reports[0][0].message, /Cannot stringify a function/);
	assert.is(reports[0][1], fn);

	// operation-generation fallbacks report too, and a throwing onerror is ignored
	const fallback = deferred();
	const failures = [];
	const replacer = (_value, js) => ({
		type: 'async-value', source: fallback.promise, construct: () => js`({})`,
		resolve() { throw new Error('resolve generation'); },
		reject: () => js``
	});
	const second = await unevalStream({}, replacer, {
		id: 'onerror-fallback',
		onerror(error) { failures.push(error); throw new Error('listener'); }
	});
	client().head(second.head);
	fallback.resolve(1);
	assert.ok(!(await second.tail.next()).done);
	assert.is(failures.length, 1);
	assert.match(failures[0].message, /resolve generation/);
	assert.equal(await second.tail.next(), { done: true, value: undefined });
});

test('emits values settled in one macrotask as one batch', async () => {
	let resolvers = [];
	const promises = Array.from({ length: 10 }, () => new Promise((resolve) => resolvers.push(resolve)));
	const result = await unevalStream(promises, undefined, { id: 'macrotask-batch' });
	const target = client();
	const root = target.head(result.head);
	for (const [i, resolve] of resolvers.entries()) resolve({ i, padding: 'x'.repeat(64) });
	const blocks = [];
	for await (const block of result.tail) {
		blocks.push(block);
		target.block(block);
	}
	assert.is(blocks.length, 1);
	const values = await Promise.all(Array.from(root));
	assert.equal(values.map((value) => value.i), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('treats non-string custom error operations as fatal', async () => {
	const ready = deferred();
	const replacer = (_value, js) => ({
		type: 'async-sequence',
		source: { async *[Symbol.asyncIterator]() { await ready.promise; throw new Error('source'); } },
		construct: () => js`({})`, next: () => js``, complete: () => js``, error: () => null
	});
	const result = await unevalStream({}, replacer, { id: 'non-string-error' });
	client().head(result.head);
	ready.resolve();
	await rejects(result.tail.next(), /Invalid async descriptor operation/);
});

test('rolls back a whole batch when a later terminal operation is fatal', async () => {
	const first = deferred();
	const second = deferred();
	let cancels = 0;
	class Job { constructor(source, broken) { this.source = source; this.broken = broken; } }
	const replacer = (value, js) => value instanceof Job && ({
		type: 'async-value', source: value.source.promise,
		construct: () => js`({values:[]})`,
		resolve: ({ target }, payload) => js`${target}.values.push(${payload})`,
		reject: value.broken ? () => 1 : ({ target }, payload) => js`${target}.values.push(${payload})`,
		cancel() { cancels++; }
	});
	const result = await unevalStream([new Job(first, false), new Job(second, true)], replacer, { id: 'batch-transaction' });
	const target = client();
	const root = target.head(result.head);
	first.resolve({ ok: true });
	second.reject(new Error('broken'));
	await rejects(result.tail.next(), /Invalid async descriptor operation/);
	assert.equal(Array.from(root[0].values), []);
	assert.equal(Array.from(root[1].values), []);
	assert.is(cancels, 2);
	await rejects(result.tail.next(), /Invalid async descriptor operation/);
});

test('validates async iterator acquisition and result protocol failures', async () => {
	const sources = [
		{ get [Symbol.asyncIterator]() { throw new Error('getter'); } },
		{ [Symbol.asyncIterator]() { throw new Error('call'); } },
		{ [Symbol.asyncIterator]() { return null; } },
		{ [Symbol.asyncIterator]() { return {}; } },
		{ [Symbol.asyncIterator]() { return { next() { throw new Error('next'); } }; } },
		{ [Symbol.asyncIterator]() { return { next() { return null; } }; } },
		{ [Symbol.asyncIterator]() { return { next() { return { get done() { throw new Error('done'); } }; } }; } },
		{ [Symbol.asyncIterator]() { return { next() { return { done: false, get value() { throw new Error('value'); } }; } }; } }
	];
	for (const source of sources) {
		const { root } = await drain(await unevalStream(source, sequence_replacer(source)));
		assert.is(root.events.length, 1);
		assert.is(root.events[0][0], 'error');
	}
});

test('freezes available sequence events into head and leaves later ones for tail', async () => {
	const gates = [deferred(), deferred(), deferred()];
	let pull = 0;
	const source = {
		[Symbol.asyncIterator]() { return this; },
		next() { return gates[pull++].promise; }
	};
	gates[0].resolve({ done: false, value: 1 });
	const result = await unevalStream(source, sequence_replacer(source), { id: 'frozen-sequence' });
	const target = client();
	const root = target.head(result.head);
	assert.equal(JSON.parse(JSON.stringify(root.events)), [['next', 1]]);
	gates[1].resolve({ done: false, value: 2 });
	const next = await result.tail.next();
	assert.ok(!next.done);
	target.block(next.value);
	assert.equal(JSON.parse(JSON.stringify(root.events)), [['next', 1], ['next', 2]]);
	gates[2].resolve({ done: true });
	await result.tail.return();
});

test('closes a sequence once after an unserializable yield', async () => {
	let returns = 0;
	const source = {
		[Symbol.asyncIterator]() { return this; },
		next() { return { done: false, value: () => {} }; },
		return() { returns++; return { done: true }; }
	};
	const { root } = await drain(await unevalStream(source, sequence_replacer(source)));
	assert.is(root.events[0][0], 'error');
	await delay();
	assert.is(returns, 1);
});

test('cancels all committed sources when a pre-head sequence close fails', async () => {
	const calls = [];
	const close_failure = new Error('close');
	class Source {
		constructor(name, sequence = false) {
			this.name = name;
			this.sequence = sequence;
		}
	}
	const sequence = new Source('sequence', true);
	const value = new Source('value');
	const replacer = (source, js) => source instanceof Source && (source.sequence ? {
		type: 'async-sequence',
		source: {
			[Symbol.asyncIterator]() { return this; },
			next() { return { done: false, value: () => {} }; },
			return() { calls.push('return'); throw close_failure; }
		},
		construct: () => js`0`, next: () => js``, complete: () => js``, error: () => js``,
		cancel() { calls.push('sequence'); }
	} : {
		type: 'async-value', source: new Promise(() => {}), construct: () => js`0`,
		resolve: () => js``, reject: () => js``, cancel() { calls.push('value'); }
	});
	await rejects(unevalStream([sequence, value], replacer), close_failure);
	assert.equal(calls, ['return', 'sequence', 'value']);
});

test('cancels all sources and reports the first cleanup failure', async () => {
	const calls = [];
	class Job { constructor(name) { this.name = name; } }
	const replacer = (value, js) => value instanceof Job && ({
		type: 'async-value', source: new Promise(() => {}), construct: () => js`0`,
		resolve: () => js``, reject: () => js``,
		async cancel() { calls.push(value.name); throw new Error(value.name); }
	});
	const result = await unevalStream([new Job('first'), new Job('second')], replacer);
	await rejects(result.tail.return(), /first/);
	assert.equal(calls, ['first', 'second']);
	await rejects(result.tail.next(), /first/);
});

test('aborts a pending tail consumer and ignores late source work', async () => {
	const controller = new AbortController();
	const pending = deferred();
	let cancelled = 0;
	class Job {}
	const replacer = (_value, js) => ({
		type: 'async-value', source: pending.promise, construct: () => js`0`,
		resolve: () => js``, reject: () => js``, cancel() { cancelled++; }
	});
	const reason = new Error('stop');
	const result = await unevalStream(new Job(), replacer, { signal: controller.signal });
	const next = result.tail.next();
	controller.abort(reason);
	await rejects(next, reason);
	assert.is(cancelled, 1);
	pending.resolve(1);
	await delay();
	await rejects(result.tail.next(), reason);
});

test('allows duplicate caller ids to overwrite unsupported concurrent sessions', async () => {
	const pending = deferred();
	const first = await unevalStream(pending.promise, undefined, { id: 'collision' });
	const second = await unevalStream(pending.promise, undefined, { id: 'collision' });
	const target = client();
	target.head(first.head);
	const original = target.context.__d.collision;
	target.head(second.head);
	assert.ok(target.context.__d.collision !== original);
	await first.tail.return();
	await second.tail.return();
});

test('removes completed entries but preserves the empty table and concurrent sessions', async () => {
	const lone = deferred();
	const single = await unevalStream(lone.promise, undefined, { id: 'lone' });
	const target = client();
	target.head(single.head);
	lone.resolve(1);
	target.block((await single.tail.next()).value);
	assert.ok(!Object.hasOwn(target.context.__d, 'lone'));
	assert.is(Object.getPrototypeOf(target.context.__d), null);

	const first = deferred();
	const second = deferred();
	const a = await unevalStream(first.promise, undefined, { id: 'shared-a' });
	const b = await unevalStream(second.promise, undefined, { id: 'shared-b' });
	target.head(a.head);
	target.head(b.head);
	first.resolve(1);
	target.block((await a.tail.next()).value);
	assert.ok(Object.hasOwn(target.context.__d, 'shared-b'));
	second.resolve(2);
	target.block((await b.tail.next()).value);
	assert.ok(!Object.hasOwn(target.context.__d, 'shared-b'));
	assert.is(Object.getPrototypeOf(target.context.__d), null);
});

test('isolates dangerous ids in the null-prototype session table', async () => {
	const pending = deferred();
	const result = await unevalStream(pending.promise, undefined, { id: 'inherited' });
	const target = client();
	target.head(result.head);
	assert.ok(Object.hasOwn(target.context.__d, 'inherited'));
	assert.is(Object.getPrototypeOf(target.context.__d), null);
	await result.tail.return();
});

test('supports assignable custom table member scopes and retains them after cleanup', async () => {
	const pending = deferred();
	const result = await unevalStream(pending.promise, undefined, { id: 'custom', scope: 'globalThis.state.streams' });
	const target = client({ state: {} });
	const root = target.head(result.head);
	assert.is(Object.getPrototypeOf(target.context.state.streams), null);
	assert.ok(Object.hasOwn(target.context.state.streams, 'custom'));
	pending.resolve(1);
	target.block((await result.tail.next()).value);
	assert.is(await root, 1);
	assert.ok(!Object.hasOwn(target.context.state.streams, 'custom'));
	assert.is(Object.getPrototypeOf(target.context.state.streams), null);
});

test('escapes ids keys values and rejection reasons in generated protocol source', async () => {
	const text = '</script>\n\u2028';
	const pending = deferred();
	const result = await unevalStream({ [text]: pending.promise }, undefined, { id: text });
	assert.not.match(result.head, /<\/script>/);
	const target = client();
	const root = target.head(result.head);
	pending.reject(text);
	const rejection = rejects(root[text], text);
	const block = (await result.tail.next()).value;
	assert.not.match(block, /<\/script>/);
	target.block(block);
	await rejection;
});

test('makes exhausted tails one-shot and returns itself as async iterator', async () => {
	const pending = deferred();
	const result = await unevalStream(pending.promise, undefined, { id: 'one-shot-tail' });
	assert.is(result.tail[Symbol.asyncIterator](), result.tail);
	client().head(result.head);
	pending.resolve(1);
	assert.ok(!(await result.tail.next()).done);
	assert.equal(await result.tail.next(), { done: true, value: undefined });
	assert.equal(await result.tail.next(), { done: true, value: undefined });
	assert.equal(await result.tail.return(), { done: true, value: undefined });
});

test('matches synchronous parity for supported scalar and container categories', async () => {
	const null_object = Object.assign(Object.create(null), { value: 1 });
	const values = {
		boxed: [Object(1), Object('x'), Object(true), Object(2n)],
		date: new Date(123), regexp: /a+/gi,
		url: new URL('https://example.com/a?b=1'), params: new URLSearchParams('a=1&a=2'),
		null_object, empty_set: new Set(), empty_map: new Map()
	};
	const { root } = await drain(await unevalStream(values), client({ URL, URLSearchParams }));
	assert.is(Object.getPrototypeOf(root.null_object), null);
	assert.is(root.date.getTime(), 123);
	assert.is(root.regexp.source, 'a+');
	assert.is(root.regexp.flags, 'gi');
	assert.is(root.url.href, values.url.href);
	assert.is(root.params.toString(), 'a=1&a=2');
	assert.is(root.boxed[0].valueOf(), 1);
	assert.is(root.boxed[1].valueOf(), 'x');
	assert.is(root.boxed[2].valueOf(), true);
	assert.is(root.boxed[3].valueOf(), 2n);
	assert.is(root.empty_set.size, 0);
	assert.is(root.empty_map.size, 0);
});

test('matches parity for typed arrays DataView subviews and repeated views', async () => {
	const buffer = new ArrayBuffer(16);
	new Uint8Array(buffer).set([1, 2, 3, 4]);
	const view = new Uint16Array(buffer, 2, 3);
	const data = new DataView(buffer, 1, 5);
	const { root } = await drain(await unevalStream({ buffer, view, repeated: view, data }));
	assert.is(root.view, root.repeated);
	assert.is(root.view.buffer, root.buffer);
	assert.is(root.data.buffer, root.buffer);
	assert.is(root.view.byteOffset, 2);
	assert.is(root.data.byteLength, 5);
	assert.equal(Array.from(new Uint8Array(root.buffer)), Array.from(new Uint8Array(buffer)));
});

test('rejects unsupported graphs at the initial error boundary', async () => {
	const symbolic = { [Symbol('x')]: 1 };
	const proto = Object.create(null);
	Object.defineProperty(proto, '__proto__', { value: 1, enumerable: true });
	for (const value of [() => {}, Symbol('x'), new WeakMap(), symbolic, proto]) {
		await rejects(unevalStream(value), /Cannot stringify/);
	}
});

test('guards large payload structure without descendant slots or repeated aliases', async () => {
	const pending = deferred();
	const payload = { rows: Array.from({ length: 100 }, (_, i) => ({ i, value: `value-${i}` })) };
	const result = await unevalStream({ pending: pending.promise }, undefined, { id: 'large-guardrail' });
	client().head(result.head);
	pending.resolve(payload);
	const block = (await result.tail.next()).value;
	const message = `raw=${block.length} gzip=${gzipSync(block).length}`;
	// a single-use outcome folds its anchor assignment into the settlement operation
	assert.is((block.match(/s\.a\[/g) ?? []).length, 1, message);
	assert.match(block, /\(s\.a\[1\]=\{/, message);
	assert.is((block.match(/globalThis\.__d\["large-guardrail"\]\.b\(\(s,n\)=>\{/g) ?? []).length, 1, message);
	assert.not.match(block, /s\.s\[/, message);
	assert.not.match(block, /Array\.from\(/, message);
});

test('anchors implicitly via the push helper once it pays for itself', async () => {
	const items = Array.from({ length: 12 }, (_, i) => ({ i }));
	const result = await unevalStream(
		(async function* () {
			for (let i = 0; i < 12; i += 1) {
				await delay();
				yield { self: items[i], prev: i > 0 ? items[i - 1] : null };
			}
		})(),
		undefined,
		{ id: 'implicit-anchors' }
	);
	const target = client();
	const root = target.head(result.head);
	let source = result.head;
	for await (const block of result.tail) {
		source += block;
		target.block(block);
	}
	// the first five anchors are explicit assignments; later anchors ride the helper
	assert.is((source.match(/s\.a\[\d+\]=/g) ?? []).length, 6, source); // head root + 5
	assert.ok((source.match(/s\.v\(/g) ?? []).length >= 7, source);
	assert.match(source, /s\.v=v=>\(s\.a\.push\(v\),v\)/, source);
	// identity is preserved across both anchor forms
	const seen = [];
	for await (const entry of root) seen.push(entry);
	assert.is(seen.length, 12);
	for (let i = 1; i < 12; i += 1) assert.is(seen[i].prev, seen[i - 1].self);
});

test('selects the shortest stable structured path', async () => {
	const pending = deferred();
	const shared = {};
	const root_value = {
		veryLongPropertyName: { anotherLongPropertyName: shared },
		x: shared,
		pending: pending.promise
	};
	const result = await unevalStream(root_value, undefined, { id: 'shortest-path' });
	const target = client();
	const root = target.head(result.head);
	pending.resolve(shared);
	const block = (await result.tail.next()).value;
	assert.match(block, /s\.a\[0\]\.x/);
	assert.not.match(block, /veryLongPropertyName/);
	target.block(block);
	assert.is(await root.pending, root.x);
});

test('promotes a repeatedly used long path only when profitable', async () => {
	const pending = deferred();
	const shared = {};
	const result = await unevalStream({ deeplyNestedPropertyName: { anotherLongPropertyName: shared }, pending: pending.promise }, undefined, { id: 'profitable-slot' });
	const target = client();
	const root = target.head(result.head);
	pending.resolve([shared, shared, shared]);
	const block = (await result.tail.next()).value;
	assert.match(block, /s\.s\[0\]=s\.a\[0\]\.deeplyNestedPropertyName/);
	target.block(block);
	assert.is((await root.pending)[0], root.deeplyNestedPropertyName.anotherLongPropertyName);
});

test('does not promote a repeated short path when unprofitable', async () => {
	const pending = deferred();
	const shared = {};
	const result = await unevalStream({ x: shared, pending: pending.promise }, undefined, { id: 'unprofitable-slot' });
	const target = client();
	const root = target.head(result.head);
	pending.resolve([shared, shared]);
	const block = (await result.tail.next()).value;
	assert.not.match(block, /s\.s\[/);
	assert.is((block.match(/s\.a\[0\]\.x/g) ?? []).length, 2);
	target.block(block);
	assert.is((await root.pending)[0], root.x);
});

test('composes descriptor references without replacing similar source text', async () => {
	const pending = deferred();
	const marker = '"0"';
	const result = await unevalStream(pending.promise, (value, js) => value === pending.promise && ({
		type: 'async-value',
		source: pending.promise,
		construct: (capture) => js`new Promise((a,b)=>{${capture(js`[a,b]`)}})`,
		resolve: ({ control }, payload) => js`globalThis.marker=${marker};${control}[0](${payload})`,
		reject: ({ control }, reason) => js`${control}[1](${reason})`
	}));
	const target = client();
	const promise = target.head(result.head);
	pending.resolve(1);
	const block = (await result.tail.next()).value;
	target.block(block);
	assert.is(globalThis.marker, undefined);
	assert.is(target.context.marker, marker);
	assert.is(await promise, 1);
});

test('preserves Map and Set element identity across asynchronous regions', async () => {
	const a = deferred();
	const b = deferred();
	const c = deferred();
	const inner = { x: 1 };
	const result = await unevalStream({ a: a.promise, b: b.promise, c: c.promise }, undefined, { id: 'async-collections' });
	const target = client();
	const root = target.head(result.head);
	a.resolve(new Map([['k', inner]]));
	await delay(5);
	target.block((await result.tail.next()).value);
	b.resolve(new Set([inner]));
	await delay(5);
	target.block((await result.tail.next()).value);
	c.resolve(inner);
	await delay(5);
	target.block((await result.tail.next()).value);
	const revived = await root.c;
	assert.is((await root.a).get('k'), revived);
	assert.is(Array.from(await root.b)[0], revived);
});

test('preserves custom replacer child identity across asynchronous regions', async () => {
	class Wrap {
		constructor(value) {
			this.value = value;
		}
	}
	const a = deferred();
	const b = deferred();
	const inner = { x: 1 };
	const result = await unevalStream(
		{ a: a.promise, b: b.promise },
		(value, js) => (value instanceof Wrap ? js`{wrapped:${value.value}}` : undefined),
		{ id: 'async-custom-child' }
	);
	const target = client();
	const root = target.head(result.head);
	a.resolve(new Wrap(inner));
	await delay(5);
	target.block((await result.tail.next()).value);
	b.resolve(inner);
	await delay(5);
	target.block((await result.tail.next()).value);
	assert.is((await root.a).wrapped, await root.b);
});

test('folds the initial macrotask batch into the head', async () => {
	async function* fast() {
		for (let i = 0; i < 2000; i += 1) yield { i, pad: 'x'.repeat(64) };
	}
	const result = await unevalStream(fast(), undefined, { id: 'head-batch' });
	const target = client();
	const root = target.head(result.head);
	const seen = [];
	const drained = (async () => {
		for await (const value of { [Symbol.asyncIterator]: () => root }) seen.push(value);
	})();
	for await (const block of result.tail) {
		target.block(block);
	}
	await drained;
	assert.is(seen.length, 2000);
	assert.ok(seen.every((value, i) => value.i === i));
});

test('defines the sequence runtime before hoisted declarations that use it', async () => {
	async function* first() {
		yield 1;
	}
	async function* second() {
		yield 2;
	}
	const seq1 = first();
	const seq2 = second();
	// seq1 is discovered first but emitted inline deep in the tree; seq2 is repeated,
	// so it hoists into a declaration that runs before the root literal
	const result = await unevalStream({ a: { x: seq1 }, b: seq2, b2: seq2 }, undefined, { id: 'runtime-order' });
	const { root, client: target } = await drain(result);
	assert.is(root.b, root.b2);
	assert.is((await root.a.x.next()).value, 1);
	assert.is((await root.b.next()).value, 2);
});

test('shares the pending promise construct helper', async () => {
	const single = await unevalStream(new Promise(() => {}), undefined, { id: 'single-promise' });
	assert.is((single.head.match(/s\.w=/g) ?? []).length, 1, single.head);
	assert.is((single.head.match(/s\.w\(/g) ?? []).length, 1, single.head);
	await single.tail.return();

	const multiple = await unevalStream(
		[new Promise(() => {}), new Promise(() => {}), new Promise(() => {})],
		undefined,
		{ id: 'multi-promise' }
	);
	assert.is((multiple.head.match(/s\.w=/g) ?? []).length, 1, multiple.head);
	assert.is((multiple.head.match(/s\.w\(/g) ?? []).length, 3, multiple.head);
	assert.ok(multiple.head.indexOf('s.w=') < multiple.head.indexOf('s.w(0)'), multiple.head);
	await multiple.tail.return();
});

test('shares the settlement helper across blocks once profitable', async () => {
	const settlers = [];
	const promises = Array.from({ length: 3 }, () => new Promise((resolve) => settlers.push(resolve)));
	const result = await unevalStream(promises, undefined, { id: 'settle-helper' });
	const target = client();
	const root = target.head(result.head);
	const blocks = [];
	for (const [i, settle] of settlers.entries()) {
		settle({ i });
		await delay(5);
		blocks.push((await result.tail.next()).value);
	}
	for (const block of blocks) target.block(block);
	assert.is((blocks.join('').match(/s\.r=/g) ?? []).length, 1, blocks.join('\n'));
	assert.match(blocks[2], /s\.r\(2,0,/, blocks[2]);
	assert.equal(JSON.parse(JSON.stringify(await Promise.all(Array.from(root)))), [{ i: 0 }, { i: 1 }, { i: 2 }]);
	assert.is(target.context.__d && Object.keys(target.context.__d).length, 0);
});

test('folds a single-use outcome anchor into its settlement operation', async () => {
	const pending = deferred();
	const result = await unevalStream(pending.promise, undefined, { id: 'inline-anchor' });
	const target = client();
	const root = target.head(result.head);
	pending.resolve({ value: 42 });
	const block = (await result.tail.next()).value;
	assert.match(block, /\(s\.a\[1\]=\{value:42\}\)/, block);
	assert.is((block.match(/s\.a\[1\]/g) ?? []).length, 1, block);
	target.block(block);
	assert.equal({ ...(await root) }, { value: 42 });
});

test.run();
