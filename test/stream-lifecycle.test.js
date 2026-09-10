import { getEventListeners } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

function settled(promise) {
	return promise.then(
		(value) => ({ ok: true, value }),
		(reason) => ({ ok: false, reason })
	);
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

test('keeps cleanup diagnostics isolated from disposed source getters', () => {
	const fixture = fileURLToPath(new URL('../fixtures/stream/cleanup-diagnostics.mjs', import.meta.url));
	const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', fixture], {
		encoding: 'utf8',
		timeout: 10_000
	});
	assert.is(child.error, undefined, child.error?.stack);
	assert.is(child.signal, null, child.stderr || child.stdout);
	assert.is(child.status, 0, child.stderr || child.stdout);
	assert.equal(JSON.parse(child.stdout), { fixture: 'cleanup diagnostics', cases: 5 });
});

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

test('return and cancel getter failures are observed once in operation order', async () => {
	const return_failure = { kind: 'return getter' };
	const cancel_failure = { kind: 'cancel getter' };
	const reports = [];
	let return_gets = 0;
	let cancel_gets = 0;
	const iterator = {
		next: () => new Promise(() => {}),
		get return() {
			return_gets++;
			throw return_failure;
		}
	};
	const source = { [Symbol.asyncIterator]() { return iterator; } };
	const value = { source };
	const descriptor = sequence_descriptor(value, undefined);
	Object.defineProperty(descriptor, 'cancel', {
		get() {
			cancel_gets++;
			if (cancel_gets === 1) return () => {};
			throw cancel_failure;
		}
	});
	const result = await unevalStream(value, (candidate, js) => {
		if (candidate !== value) return;
		descriptor.construct = () => js`({events:[]})`;
		descriptor.next = ({ target }, item) => js`${target}.events.push(${item})`;
		descriptor.complete = () => js``;
		descriptor.error = () => js``;
		return descriptor;
	}, { onerror: (error) => reports.push(error) });
	assert.is(await rejected(result.tail.return()), return_failure);
	assert.equal(reports, [cancel_failure]);
	assert.is(return_gets, 1);
	assert.is(cancel_gets, 2);
	assert.equal(await result.tail.return(), { done: true, value: undefined });
	assert.is(return_gets, 1);
	assert.is(cancel_gets, 2);
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

for (const phase of ['resolve', 'next', 'complete']) {
	test(`does not invoke ${phase} fallback after onerror aborts`, async () => {
		const controller = new AbortController();
		const gate = deferred();
		const reason = { phase, kind: 'abort from onerror' };
		const calls = [];
		let pulls = 0;
		let returns = 0;
		let cancels = 0;
		const sequence = phase !== 'resolve';
		const source = sequence ? {
			[Symbol.asyncIterator]() { return this; },
			next() { pulls++; return gate.promise; },
			return() { returns++; return { done: true }; }
		} : gate.promise;
		const value = {};
		const result = await unevalStream(value, (candidate, js) => candidate === value && ({
			type: sequence ? 'async-sequence' : 'async-value',
			source,
			construct: () => js`0`,
			resolve() { calls.push('resolve'); return null; },
			reject() { calls.push('fallback'); return js``; },
			next() { calls.push('next'); return null; },
			complete() { calls.push('complete'); return null; },
			error() { calls.push('fallback'); return js``; },
			cancel() { cancels++; }
		}), {
			signal: controller.signal,
			onerror(error) {
				calls.push('report');
				assert.instance(error, TypeError);
				controller.abort(reason);
			}
		});
		const waiting = settled(result.tail.next());
		if (sequence) gate.resolve({ done: phase === 'complete', value: 1 });
		else gate.resolve(1);
		const outcome = await waiting;
		assert.is(outcome.ok, false);
		assert.is(outcome.reason, reason);
		assert.equal(calls, [phase, 'report']);
		assert.is(cancels, 1);
		assert.is(pulls, sequence ? 1 : 0);
		assert.is(returns, sequence ? 1 : 0);
	});
}

test('still invokes a valid fallback when onerror does not terminate the session', async () => {
	const gate = deferred();
	const calls = [];
	const value = {};
	const result = await unevalStream(value, (candidate, js) => candidate === value && ({
		type: 'async-value', source: gate.promise, construct: () => js`0`,
		resolve() { calls.push('resolve'); return null; },
		reject() { calls.push('fallback'); return js``; }
	}), { onerror: () => calls.push('report') });
	gate.resolve(1);
	assert.is((await result.tail.next()).done, false);
	assert.equal(calls, ['resolve', 'report', 'fallback']);
	assert.equal(await result.tail.next(), { done: true, value: undefined });
});

test('does not queue an invalid captured outcome after onerror aborts', async () => {
	const controller = new AbortController();
	const gate = deferred();
	const reason = { kind: 'invalid outcome abort' };
	let operations = 0;
	let cancels = 0;
	const value = {};
	const result = await unevalStream(value, (candidate, js) => candidate === value && ({
		type: 'async-value', source: gate.promise, construct: () => js`0`,
		resolve() { operations++; return js``; },
		reject() { operations++; return js``; },
		cancel() { cancels++; }
	}), {
		signal: controller.signal,
		onerror(error) {
			assert.match(error.message, /Cannot stringify a function/);
			controller.abort(reason);
		}
	});
	const waiting = settled(result.tail.next());
	gate.resolve(() => {});
	const outcome = await waiting;
	assert.is(outcome.ok, false);
	assert.is(outcome.reason, reason);
	assert.is(operations, 0);
	assert.is(cancels, 1);
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

for (const settlement of ['return-first', 'cancel-first']) {
	test(`selects acquisition-reentry cleanup failures by discovery order (${settlement})`, async () => {
		const outcome = deferred();
		const return_gate = deferred();
		const cancel_gate = deferred();
		const return_failure = { kind: 'return' };
		const cancel_failure = { kind: 'cancel' };
		const reports = [];
		const calls = [];
		const acquired = deferred();
		let reentrant_return;
		let result;
		let returns = 0;
		let first_cancels = 0;
		let second_cancels = 0;
		class Sequence {
			constructor(name) {
				this.name = name;
				this.source = {
					[Symbol.asyncIterator]: () => {
						calls.push(`acquire:${name}`);
						if (name === 'first') {
							reentrant_return = settled(result.tail.return());
							acquired.resolve();
						}
						return this.source;
					},
					next: () => new Promise(() => {}),
					return: () => {
						returns++;
						calls.push(`return:${name}`);
						return return_gate.promise;
					}
				};
			}
		}
		const values = [new Sequence('first'), new Sequence('second')];
		result = await unevalStream(outcome.promise, (value, js) => value instanceof Sequence && sequence_descriptor(value, js, () => {
			calls.push(`cancel:${value.name}`);
			if (value.name === 'first') first_cancels++;
			else {
				second_cancels++;
				return cancel_gate.promise;
			}
		}), { onerror: (error) => reports.push(error) });
		const next = settled(result.tail.next());
		let timer;
		const watchdog = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error('acquisition-reentry cleanup deadlocked')), 1000);
		});
		try {
			outcome.resolve(values);
			await Promise.race([acquired.promise, watchdog]);
			assert.ok(reentrant_return);
			assert.is(second_cancels, 1);
			assert.is(returns, 1);
			assert.is(first_cancels, 1);
			if (settlement === 'return-first') {
				return_gate.reject(return_failure);
				await Promise.resolve();
				cancel_gate.reject(cancel_failure);
			} else {
				cancel_gate.reject(cancel_failure);
				await Promise.resolve();
				return_gate.reject(return_failure);
			}
			const next_result = await Promise.race([next, watchdog]);
			const return_result = await Promise.race([reentrant_return, watchdog]);
			assert.is(next_result.ok, false);
			assert.is(return_result.ok, false);
			assert.is(next_result.reason, return_failure);
			assert.is(return_result.reason, return_failure);
			assert.equal(reports, [cancel_failure]);
			assert.is(returns, 1);
			assert.is(first_cancels, 1);
			assert.is(second_cancels, 1);
		} finally {
			clearTimeout(timer);
			return_gate.resolve({ done: true });
			cancel_gate.resolve();
		}
	});
}

test('preserves a falsy abort reason during iterator acquisition', async () => {
	const controller = new AbortController();
	const outcome = deferred();
	const return_failure = { kind: 'return' };
	const cancel_failure = { kind: 'cancel' };
	const reports = [];
	class Sequence {
		constructor(name) {
			this.name = name;
			this.source = {
				[Symbol.asyncIterator]: () => {
					if (name === 'first') controller.abort(0);
					return this.source;
				},
				next: () => new Promise(() => {}),
				return: () => Promise.reject(return_failure)
			};
		}
	}
	const values = [new Sequence('first'), new Sequence('second')];
	const result = await unevalStream(outcome.promise, (value, js) => value instanceof Sequence && sequence_descriptor(value, js, () => {
		if (value.name === 'second') throw cancel_failure;
	}), { signal: controller.signal, onerror: (error) => reports.push(error) });
	const next = rejected(result.tail.next());
	outcome.resolve(values);
	assert.is(await next, 0);
	assert.equal(reports, [return_failure, cancel_failure]);
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
