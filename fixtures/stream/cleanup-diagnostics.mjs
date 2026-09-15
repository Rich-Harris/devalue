import assert from 'node:assert/strict';
import { unevalStream } from '../../index.js';

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((fulfil, fail) => {
		resolve = fulfil;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function settled(promise) {
	return promise.then(
		(value) => ({ ok: true, value }),
		(reason) => ({ ok: false, reason })
	);
}

async function with_timeout(label, promise, milliseconds = 2_000) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function abort_with_closed_source(mode) {
	const controller = new AbortController();
	const source_value = new Promise(() => {});
	const cleanup_failure = { mode, kind: 'cleanup' };
	const diagnostic_failure = { mode, kind: 'diagnostic source' };
	const reports = [];
	let closed = false;
	let cancels = 0;
	const value = {};
	const descriptor = {
		type: 'async-value',
		get source() {
			if (closed) throw diagnostic_failure;
			return source_value;
		},
		construct: () => ({ raw: '' }),
		resolve: () => ({ raw: '' }),
		reject: () => ({ raw: '' }),
		cancel() {
			cancels++;
			closed = true;
			throw cleanup_failure;
		}
	};
	const onerror = mode === 'absent' ? undefined : (error, context) => {
		reports.push([error, context]);
		if (mode === 'throwing') throw new Error('ignored diagnostic callback failure');
	};
	const result = await unevalStream(value, (candidate, js) => {
		if (candidate !== value) return;
		descriptor.construct = () => js`0`;
		descriptor.resolve = () => js``;
		descriptor.reject = () => js``;
		return descriptor;
	}, { signal: controller.signal, onerror });
	const waiting = settled(result.tail.next());
	controller.abort(0);
	const outcome = await with_timeout(`abort cleanup (${mode})`, waiting);
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, 0);
	assert.equal(cancels, 1);
	if (mode === 'absent') {
		assert.equal(reports.length, 0);
	} else {
		assert.equal(reports.length, 1);
		assert.equal(reports[0][0], cleanup_failure);
		assert.equal(reports[0][1], source_value);
	}
}

async function return_with_closed_sources() {
	const failures = [{ source: 1 }, { source: 2 }];
	const reports = [];
	const values = failures.map((failure) => {
		let closed = false;
		const diagnostic_failure = { failure, kind: 'diagnostic source' };
		const iterable = {
			[Symbol.asyncIterator]() { return this; },
			next() { return new Promise(() => {}); },
			return() {
				closed = true;
				return Promise.reject(failure);
			}
		};
		return {
			iterable,
			descriptor: {
				type: 'async-sequence',
				get source() {
					if (closed) throw diagnostic_failure;
					return iterable;
				}
			}
		};
	});
	const result = await unevalStream(values, (candidate, js) => {
		const value = values.find((value) => value === candidate);
		if (!value) return;
		return Object.assign(value.descriptor, {
			construct: () => js`0`,
			next: () => js``,
			complete: () => js``,
			error: () => js``
		});
	}, { onerror: (error, context) => reports.push([error, context]) });
	const outcome = await with_timeout('ordered return cleanup', settled(result.tail.return()));
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, failures[0]);
	assert.equal(reports.length, 1);
	assert.equal(reports[0][0], failures[1]);
	assert.equal(reports[0][1], values[1].iterable);
}

async function failed_sequence_close_uses_retained_context() {
	const healthy = deferred();
	const close_failure = { kind: 'failed sequence close' };
	const reports = [];
	let closed = false;
	const iterable = {
		[Symbol.asyncIterator]() { return this; },
		next() { return { done: false, value: () => {} }; },
		return() {
			closed = true;
			return Promise.reject(close_failure);
		}
	};
	const value = {};
	const descriptor = {
		type: 'async-sequence',
		get source() {
			if (closed) throw new Error('source context was reread after close');
			return iterable;
		}
	};
	const result = await unevalStream([value, healthy.promise], (candidate, js) => {
		if (candidate !== value) return;
		return Object.assign(descriptor, {
			construct: () => js`0`,
			next: () => js``,
			complete: () => js``,
			error: () => js``
		});
	}, { onerror: (error, context) => reports.push([error, context]) });
	await Promise.resolve();
	assert.equal(reports.length, 2);
	assert.equal(reports[1][0], close_failure);
	assert.equal(reports[1][1], iterable);
	healthy.resolve(1);
	assert.equal((await with_timeout('healthy sibling block', result.tail.next())).done, false);
	assert.deepEqual(await result.tail.next(), { done: true, value: undefined });
}

for (const mode of ['absent', 'recording', 'throwing']) await abort_with_closed_source(mode);
await return_with_closed_sources();
await failed_sequence_close_uses_retained_context();

console.log(JSON.stringify({ fixture: 'cleanup diagnostics', cases: 5 }));
