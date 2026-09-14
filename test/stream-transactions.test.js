import vm from 'node:vm';
import { suite } from 'uvu';
import * as assert from 'uvu/assert';
import { DevalueError, unevalStream } from '../index.js';

const test = suite('unevalStream transactions');

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

const delay = () => new Promise((resolve) => setTimeout(resolve, 5));

test('rolls back a failed operation suffix before committing valid siblings', async () => {
	class Job {
		constructor(name, ready) {
			this.name = name;
			this.ready = ready;
		}
	}
	const failed_gate = deferred();
	const healthy_gate = deferred();
	const failed_nested_gate = deferred();
	const committed_nested_gate = deferred();
	const failed = new Job('failed', failed_gate);
	const healthy = new Job('healthy', healthy_gate);
	const failed_nested = new Job('failed nested', failed_nested_gate);
	const committed_nested = new Job('committed nested', committed_nested_gate);
	const shared = { value: 42 };
	const later_child = { retained: true };
	const later_outcome = { child: later_child, shared };
	const starts = [];
	const cancels = [];
	const reports = [];
	const source = (job) => ({
		get then() {
			starts.push(job.name);
			return job.ready.promise.then.bind(job.ready.promise);
		}
	});
	const result = await unevalStream({ shared, failed, healthy }, (value, js) => value instanceof Job && ({
		type: 'async-value',
		source: source(value),
		construct: (capture) => value === failed_nested
			? js`({child:${later_child}})`
			: js`({name:${value.name},control:${capture(js`[]`)},value:null,nested:null})`,
		resolve: ({ target }, payload) => {
			if (value === failed) return js`${target}.nested=${failed_nested};${() => {}}`;
			if (value === healthy) return js`${target}.value=${payload};${target}.nested=${committed_nested}`;
			return js``;
		},
		reject: ({ target }) => value === failed ? js`${target}.value=${shared}` : js``,
		cancel() { cancels.push(value.name); }
	}), { id: 'transaction-suffix', onerror: (error) => reports.push(error) });
	const target = client();
	const root = target.head(result.head);
	assert.equal(starts, ['failed', 'healthy']);
	failed_gate.resolve(1);
	healthy_gate.resolve(later_outcome);
	await delay();
	const block = (await result.tail.next()).value;
	target.block(block);
	assert.is(reports.length, 1);
	assert.equal(starts, ['failed', 'healthy', 'committed nested']);
	assert.is(root.failed.value, root.shared);
	assert.is(root.healthy.value.child.retained, true);
	assert.is(root.healthy.value.shared, root.shared);
	assert.is(root.healthy.nested.name, 'committed nested');
	assert.ok(!starts.includes('failed nested'));
	assert.not.ok(cancels.includes('failed nested'));
	assert.match(block, /\.p\[2\]/);
	assert.not.match(block, /\.p\[3\]/);
	assert.not.match(block, /\.s\[/);
	assert.is(target.context.__d['transaction-suffix'].a.length, 3);
	await result.tail.return();
	assert.equal(cancels, ['failed', 'healthy', 'committed nested']);
});

test('keeps nested commits provisional when a later terminal callback aborts the batch', async () => {
	class Job {
		constructor(name, ready) {
			this.name = name;
			this.ready = ready;
		}
	}
	const first_gate = deferred();
	const fatal_gate = deferred();
	const nested_gate = deferred();
	const first = new Job('first', first_gate);
	const fatal = new Job('fatal', fatal_gate);
	const nested = new Job('nested', nested_gate);
	const starts = [];
	const cancels = [];
	let nested_constructs = 0;
	const result = await unevalStream({ first, fatal }, (value, js) => value instanceof Job && ({
		type: 'async-value',
		source: {
			get then() {
				starts.push(value.name);
				return value.ready.promise.then.bind(value.ready.promise);
			}
		},
		construct: () => {
			if (value === nested) nested_constructs++;
			return js`({value:null})`;
		},
		resolve: ({ target }) => js`${target}.value=${nested}`,
		reject: () => value === fatal ? null : js``,
		cancel() { cancels.push(value.name); }
	}), { id: 'transaction-outer-rollback' });
	const target = client();
	const root = target.head(result.head);
	first_gate.resolve(1);
	fatal_gate.reject(new Error('fatal outcome'));
	await delay();
	const error = await rejected(result.tail.next());
	assert.match(error.message, /fallback|reject\(\).*js tagged template/);
	assert.is(nested_constructs, 1);
	assert.equal(starts, ['first', 'fatal']);
	assert.equal(cancels, ['first', 'fatal']);
	assert.is(root.first.value, null);
	assert.is(root.fatal.value, null);
	assert.is(target.context.__d['transaction-outer-rollback'].a.length, 1);
	assert.is(target.context.__d['transaction-outer-rollback'].p.length, 0);
	assert.ok(!starts.includes('nested'));
	assert.not.ok(cancels.includes('nested'));
});

test('continues cleanly after external and owned graph failures', async () => {
	class Job {
		constructor(name, ready) {
			this.name = name;
			this.ready = ready;
		}
	}
	const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
	const external_job = new Job('external', gates[0]);
	const graph_job = new Job('graph', gates[1]);
	const healthy_job = new Job('healthy', gates[2]);
	const provisional = new Job('provisional', gates[3]);
	const nested = new Job('nested', gates[4]);
	const shared = { value: 42 };
	const external_value = {};
	const external_root = {};
	const external = new DevalueError('external failure', ['.external'], external_value, external_root);
	Object.freeze(external);
	const external_hole = { provisional };
	Object.defineProperty(external_hole, 'prop', { enumerable: true, get() { throw external; } });
	const bad = () => {};
	const graph_hole = { deep: { bad } };
	const starts = [];
	const cancels = [];
	const reports = [];
	const result = await unevalStream({ shared, jobs: [external_job, graph_job, healthy_job] }, (value, js) => value instanceof Job && ({
		type: 'async-value',
		source: {
			get then() {
				starts.push(value.name);
				return value.ready.promise.then.bind(value.ready.promise);
			}
		},
		construct: () => js`({name:${value.name},value:null})`,
		resolve: ({ target }) => {
			if (value === external_job) return js`${external_hole}`;
			if (value === graph_job) return js`${graph_hole}`;
			if (value === healthy_job) return js`${target}.value={shared:${shared},again:${shared},nested:${nested}}`;
			return js`${target}.value="done"`;
		},
		reject: ({ target }, error) => js`${target}.value=${error}`,
		cancel() { cancels.push(value.name); }
	}), { id: 'owned-error-rollback', onerror: (error) => reports.push(error) });
	const target = client();
	const root = target.head(result.head);
	assert.equal(starts, ['external', 'graph', 'healthy']);

	gates[0].resolve(1);
	target.block((await result.tail.next()).value);
	assert.is(reports[0].cause, external);
	assert.is(external.path, '.external');
	assert.is(external.value, external_value);
	assert.is(external.root, external_root);
	assert.ok(!starts.includes('provisional'));
	assert.ok(!cancels.includes('provisional'));

	gates[1].resolve(2);
	target.block((await result.tail.next()).value);
	assert.is(reports[1].cause.value, bad);
	assert.is(reports[1].cause.path, '.deep.bad');

	gates[2].resolve(3);
	const healthy_block = (await result.tail.next()).value;
	target.block(healthy_block);
	assert.equal(starts, ['external', 'graph', 'healthy', 'nested']);
	assert.is(root.jobs[2].value.shared, root.shared);
	assert.is(root.jobs[2].value.again, root.shared);
	assert.is(root.jobs[2].value.nested.name, 'nested');
	assert.match(healthy_block, /\.a\[1\]/);
	assert.not.match(healthy_block, /\.a\[2\]/);
	assert.is(target.context.__d['owned-error-rollback'].a.length, 2);

	gates[4].resolve(4);
	target.block((await result.tail.next()).value);
	assert.is(root.jobs[2].value.nested.value, 'done');
	assert.is(reports.length, 2);
	await result.tail.return();
	assert.equal(cancels, []);
});

test('keeps head-retained opaque descendants usable after an operation rollback', async () => {
	class Wrapper {
		constructor(value) {
			this.value = value;
		}
	}
	class Job {
		constructor(ready, fails) {
			this.ready = ready;
			this.fails = fails;
		}
	}
	const failed_gate = deferred();
	const healthy_gate = deferred();
	const failed = new Job(failed_gate, true);
	const healthy = new Job(healthy_gate, false);
	const leaf = { retained: true };
	const parent = { child: leaf };
	const reports = [];
	const result = await unevalStream({
		wrappers: [new Wrapper(leaf), new Wrapper(parent)],
		failed,
		healthy
	}, (value, js) => {
		if (value instanceof Wrapper) return js`({value:${value.value}})`;
		if (!(value instanceof Job)) return;
		return {
			type: 'async-value',
			source: value.ready.promise,
			construct: () => js`({value:null})`,
			resolve: ({ target }) => value.fails ? js`${{ invalid: () => {} }}` : js`${target}.value=${leaf}`,
			reject: ({ target }) => js`${target}.value=${leaf}`
		};
	}, { id: 'opaque-operation-rollback', onerror: (error) => reports.push(error) });
	const target = client();
	const root = target.head(result.head);
	failed_gate.resolve(1);
	healthy_gate.resolve(2);
	const block = (await result.tail.next()).value;
	target.block(block);
	assert.is(reports.length, 1);
	assert.is(root.failed.value, root.wrappers[0].value);
	assert.is(root.healthy.value, root.wrappers[0].value);
	assert.is(root.wrappers[1].value.child, root.wrappers[0].value);
	assert.match(block, /\.s\[0\]/);
	assert.equal(await result.tail.next(), { done: true, value: undefined });
});

test.run();
