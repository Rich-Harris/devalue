import { getEventListeners } from 'node:events';
import { suite } from 'uvu';
import * as assert from 'uvu/assert';
import { unevalStream } from '../index.js';

const test = suite('unevalStream lifecycle');

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((a, b) => {
		resolve = a;
		reject = b;
	});
	return { promise, resolve, reject };
}

const delay = () => new Promise((resolve) => setTimeout(resolve, 0));

async function rejected(promise) {
	let did_reject = false;
	let reason;
	try {
		await promise;
	} catch (error) {
		did_reject = true;
		reason = error;
	}
	assert.is(did_reject, true);
	return reason;
}

function listeners(signal) {
	return getEventListeners(signal, 'abort').length;
}

function sequence_descriptor(value, js, cancel) {
	return {
		type: 'async-sequence',
		source: value.source,
		construct: () => js`({events:[]})`,
		next: ({ target }, item) => js`${target}.events.push(${item})`,
		complete: () => js``,
		error: () => js``,
		cancel
	};
}

test('detaches abort listeners on every successful completion path', async () => {
	{
		const controller = new AbortController();
		const before = listeners(controller.signal);
		await unevalStream({ value: 1 }, undefined, { signal: controller.signal });
		assert.is(listeners(controller.signal), before);
	}

	{
		const controller = new AbortController();
		let cancels = 0;
		class Job {}
		const result = await unevalStream(new Job(), (_value, js) => ({
			type: 'async-value',
			source: Promise.resolve(1),
			construct: () => js`0`,
			resolve: () => js``,
			reject: () => js``,
			cancel() { cancels++; }
		}), { signal: controller.signal });
		assert.is(listeners(controller.signal), 0);
		controller.abort(new Error('late'));
		assert.is(cancels, 0);
		assert.equal(await result.tail.next(), { done: true, value: undefined });
	}

	{
		const controller = new AbortController();
		const pending = deferred();
		const result = await unevalStream(pending.promise, undefined, { signal: controller.signal });
		assert.is(listeners(controller.signal), 1);
		pending.resolve(1);
		const final = await result.tail.next();
		assert.is(final.done, false);
		// Delivery of the final block, not a gratuitous extra next(), finalizes the server session.
		assert.is(listeners(controller.signal), 0);
		controller.abort(new Error('late'));
		assert.equal(await result.tail.next(), { done: true, value: undefined });
	}

	{
		const controller = new AbortController();
		const source = { async *[Symbol.asyncIterator]() { yield 1; yield 2; } };
		const result = await unevalStream(source, undefined, { signal: controller.signal });
		for await (const _block of result.tail) {}
		assert.is(listeners(controller.signal), 0);
	}
});

test('preserves exact falsy abort reasons', async () => {
	for (const reason of [null, 0, false, '']) {
		const pre = new AbortController();
		pre.abort(reason);
		assert.is(await rejected(unevalStream({}, undefined, { signal: pre.signal })), reason);

		const controller = new AbortController();
		const result = await unevalStream(new Promise(() => {}), undefined, { signal: controller.signal });
		const next = result.tail.next();
		controller.abort(reason);
		assert.is(await rejected(next), reason);
	}
});

test('does not wait for an abandoned pull when return is absent or completes', async () => {
	for (const has_return of [false, true]) {
		const pull = deferred();
		let returns = 0;
		const source = {
			[Symbol.asyncIterator]() { return this; },
			next() { return pull.promise; }
		};
		if (has_return) source.return = () => { returns++; return { done: true }; };
		const result = await unevalStream(source);
		const waiting = result.tail.next();
		try {
			const watchdog = new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup deadlocked')), 1000));
			assert.equal(await Promise.race([result.tail.return(), watchdog]), { done: true, value: undefined });
			assert.equal(await waiting, { done: true, value: undefined });
			assert.is(returns, has_return ? 1 : 0);
		} finally {
			pull.resolve({ done: true });
		}
	}
});

test('notifies every source before awaiting cleanup and is reentry-safe', async () => {
	const controller = new AbortController();
	const close_gate = deferred();
	const calls = [];
	class Sequence {
		constructor(name) {
			this.name = name;
			this.pull = deferred();
			this.source = {
				[Symbol.asyncIterator]: () => this.source,
				next: () => this.pull.promise,
				return: () => {
					calls.push(`return:${this.name}`);
					return this.name === 'first' ? close_gate.promise : { done: true };
				}
			};
		}
	}
	const values = [new Sequence('first'), new Sequence('second')];
	const result = await unevalStream(values, (value, js) => value instanceof Sequence && sequence_descriptor(value, js, () => {
		calls.push(`cancel:${value.name}`);
		controller.abort(new Error('cleanup reentry'));
	}));
	const returning = result.tail.return();
	assert.equal(calls, ['return:first', 'cancel:first', 'return:second', 'cancel:second']);
	close_gate.resolve({ done: true });
	assert.equal(await returning, { done: true, value: undefined });
	assert.equal(calls, ['return:first', 'cancel:first', 'return:second', 'cancel:second']);
	for (const value of values) value.pull.resolve({ done: true });
});

test('return getter reentry invokes return and cancel at most once', async () => {
	const calls = [];
	const pull = deferred();
	let reenter = () => {};
	const iterator = {
		next() { return pull.promise; },
		get return() {
			calls.push('get return');
			reenter();
			return () => { calls.push('return'); return { done: true }; };
		}
	};
	const source = { [Symbol.asyncIterator]() { return iterator; } };
	const value = { source };
	const result = await unevalStream(value, (candidate, js) => candidate === value && sequence_descriptor(candidate, js, () => { calls.push('cancel'); }));
	reenter = () => { void result.tail.return(); };
	assert.equal(await result.tail.return(), { done: true, value: undefined });
	assert.equal(calls, ['get return', 'return', 'cancel']);
	pull.resolve({ done: true });
});

test('abort during initial traversal leaves every provisional descriptor untouched', async () => {
	const controller = new AbortController();
	const calls = [];
	class Job {
		constructor(name) { this.name = name; }
	}
	const values = [new Job('committed'), new Job('provisional')];
	const replacer = (value, js) => value instanceof Job && ({
		type: 'async-value',
		source: new Promise(() => {}),
		construct() {
			if (value.name === 'provisional') controller.abort('stop');
			return js`0`;
		},
		resolve: () => js``,
		reject: () => js``,
		cancel() { calls.push(value.name); }
	});
	// The root capture is one transaction, so neither source is committed until it completes.
	assert.is(await rejected(unevalStream(values, replacer, { signal: controller.signal })), 'stop');
	assert.equal(calls, []);
});

test('abort during outcome traversal cancels prior sources but not the rolled-back descriptor', async () => {
	const controller = new AbortController();
	const outcome = deferred();
	const calls = [];
	class Nested {}
	class Outer {}
	const outer = new Outer();
	const result = await unevalStream(outer, (value, js) => {
		if (value === outer) return {
			type: 'async-value', source: outcome.promise, construct: () => js`0`,
			resolve: () => js``, reject: () => js``, cancel() { calls.push('outer'); }
		};
		if (value instanceof Nested) return {
			type: 'async-value', source: new Promise(() => {}),
			construct() { controller.abort('stop'); return js`0`; },
			resolve: () => js``, reject: () => js``, cancel() { calls.push('nested'); }
		};
	}, { signal: controller.signal });
	const waiting = result.tail.next();
	outcome.resolve(new Nested());
	assert.is(await rejected(waiting), 'stop');
	assert.equal(calls, ['outer']);
});

test('abort during operation generation stops later callbacks', async () => {
	const controller = new AbortController();
	const first = deferred();
	const second = deferred();
	const calls = [];
	class Job {
		constructor(name, source) { this.name = name; this.source = source; }
	}
	const jobs = [new Job('first', first), new Job('second', second)];
	const result = await unevalStream(jobs, (value, js) => value instanceof Job && ({
		type: 'async-value', source: value.source.promise, construct: () => js`0`,
		resolve() {
			calls.push(value.name);
			if (value.name === 'first') controller.abort('stop');
			return js``;
		},
		reject: () => js``,
		cancel() {}
	}), { signal: controller.signal });
	const waiting = result.tail.next();
	first.resolve(1);
	second.resolve(2);
	assert.is(await rejected(waiting), 'stop');
	assert.equal(calls, ['first']);
});

test('selects cleanup failures in source and operation order', async () => {
	const return_failure = { kind: 'return' };
	const cancel_failure = { kind: 'cancel' };
	const later_failure = { kind: 'later' };
	const reports = [];
	class Sequence {
		constructor(name) {
			this.name = name;
			this.source = {
				[Symbol.asyncIterator]: () => this.source,
				next: () => new Promise(() => {}),
				return: () => Promise.reject(name === 'first' ? return_failure : later_failure)
			};
		}
	}
	const values = [new Sequence('first'), new Sequence('second')];
	const result = await unevalStream(values, (value, js) => value instanceof Sequence && sequence_descriptor(value, js, () => {
		if (value.name === 'first') throw cancel_failure;
	}), { onerror: (error) => reports.push(error) });
	assert.is(await rejected(result.tail.return()), return_failure);
	assert.equal(reports, [cancel_failure, later_failure]);
});

test('explicit cancellation reuses a failed-sequence close already in flight', async () => {
	const close_gate = deferred();
	let returns = 0;
	let cancels = 0;
	const iterable = {
		[Symbol.asyncIterator]() { return this; },
		next() { return { done: false, value: () => {} }; },
		return() { returns++; return close_gate.promise; }
	};
	class Sequence { constructor() { this.source = iterable; } }
	const value = new Sequence();
	const pending = new Promise(() => {});
	const result = await unevalStream([value, pending], (candidate, js) => candidate === value && sequence_descriptor(candidate, js, () => { cancels++; }));
	assert.is(returns, 1);
	const returning = result.tail.return();
	assert.is(returns, 1);
	assert.is(cancels, 1);
	close_gate.resolve({ done: true });
	assert.equal(await returning, { done: true, value: undefined });
});

for (const phase of ['head', 'tail']) {
	test(`failed sequence close does not block ${phase} delivery`, async () => {
		const next_gate = deferred();
		const close_gate = deferred();
		const healthy = deferred();
		const reports = [];
		const close_failure = new Error(`late ${phase} close`);
		const iterable = {
			[Symbol.asyncIterator]() { return this; },
			next() { return next_gate.promise; },
			return() { return close_gate.promise; }
		};
		class Sequence { constructor() { this.source = iterable; } }
		const value = new Sequence();
		if (phase === 'head') {
			next_gate.resolve({ done: false, value: () => {} });
			healthy.resolve(1);
		}
		const result = await unevalStream([value, healthy.promise], (candidate, js) => candidate === value && sequence_descriptor(candidate, js), {
			onerror: (error) => reports.push(error)
		});
		if (phase === 'tail') {
			next_gate.resolve({ done: false, value: () => {} });
			healthy.resolve(1);
			const watchdog = new Promise((_, reject) => setTimeout(() => reject(new Error('delivery blocked on return')), 1000));
			assert.is((await Promise.race([result.tail.next(), watchdog])).done, false);
		}
		// The unserializable outcome is reported first; return failure is observed later.
		assert.is(reports.length, 1);
		close_gate.reject(close_failure);
		await delay();
		assert.is(reports.length, 2);
		assert.is(reports[1], close_failure);
		assert.equal(await result.tail.next(), { done: true, value: undefined });
	});
}

test.run();
