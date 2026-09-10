import vm from 'node:vm';
import { suite } from 'uvu';
import * as assert from 'uvu/assert';
import { unevalStream } from '../index.js';

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

test.run();
