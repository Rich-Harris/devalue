import vm from 'node:vm';
import * as assert from 'node:assert/strict';
import { unevalStream } from '../../index.js';

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((a, b) => {
		resolve = a;
		reject = b;
	});
	return { promise, resolve, reject };
}

function client() {
	const context = vm.createContext({});
	context.globalThis = context;
	return {
		head(source) {
			return vm.runInContext(`(${source})`, context);
		},
		block(source) {
			return vm.runInContext(source, context);
		}
	};
}

const host_turn = () => new Promise((resolve) => setImmediate(resolve));
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

// A rejection folded into the head is observed before application code receives it.
{
	const reason = { kind: 'folded' };
	const result = await unevalStream({ reason, promise: Promise.reject(reason) }, undefined, { id: 'fixture-folded' });
	const target = client();
	const root = target.head(result.head);
	await host_turn();
	let caught;
	try {
		await root.promise;
	} catch (error) {
		caught = error;
	}
	assert.equal(caught, root.reason);
}

// A rejection delivered by a later block remains rejected with the shared reason and
// can be handled through Promise.all after an otherwise-unhandled host turn.
{
	const pending = deferred();
	const reason = { kind: 'tail' };
	const result = await unevalStream({ reason, promise: pending.promise }, undefined, { id: 'fixture-tail' });
	const target = client();
	const root = target.head(result.head);
	pending.reject(reason);
	target.block((await result.tail.next()).value);
	await host_turn();
	let caught;
	try {
		await Promise.all([root.promise]);
	} catch (error) {
		caught = error;
	}
	assert.equal(caught, root.reason);
}

// A generic client rejection caused by an unserializable asynchronous result is also
// observed immediately without changing the Error later seen by application await.
{
	const pending = deferred();
	const result = await unevalStream(pending.promise, undefined, { id: 'fixture-generic' });
	const target = client();
	const root = target.head(result.head);
	pending.resolve(() => {});
	target.block((await result.tail.next()).value);
	await host_turn();
	let caught;
	try {
		await root;
	} catch (error) {
		caught = error;
	}
	assert.match(caught.message, /failed to serialize asynchronous value/);
}

await host_turn();
assert.deepEqual(unhandled, []);
