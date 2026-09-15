import vm from 'node:vm';
import { js } from '../../src/javascript-source.js';

const NativeMap = globalThis.Map;
let map_gets = 0;

class InstrumentedMap extends NativeMap {
	get(key) {
		map_gets++;
		return super.get(key);
	}
}

function deferred() {
	let resolve;
	const promise = new Promise((fulfil) => { resolve = fulfil; });
	return { promise, resolve };
}

async function run(count, unevalStream) {
	// Ascending overlap: nodes[i] transitively contains nodes[0..i-1] as its chain.
	const nodes = [];
	let chain;
	for (let i = 0; i < count; i++) {
		const node = { index: i, child: chain };
		nodes.push(node);
		chain = node;
	}
	const pending = deferred();
	const job = {};
	const result = await unevalStream(job, (value, js) => value === job && ({
		type: 'async-value',
		source: pending.promise,
		construct: () => js`({children:[]})`,
		resolve: (reference) => {
			// Every ascending root is an ordinary hole in this single descriptor
			// operation; each is a newly emitted identity at the same boundary.
			let operation;
			for (let i = 0; i < count; i++) {
				const push = js`${reference.target}.children.push(${nodes[i]})`;
				operation = i === 0 ? push : js`${operation};${push}`;
			}
			return operation;
		},
		reject: () => js``
	}), { id: `operation-holes-scaling-${count}` });
	const context = vm.createContext({});
	context.globalThis = context;
	const root = vm.runInContext(`(${result.head})`, context);
	map_gets = 0;
	pending.resolve(undefined);
	const block = await result.tail.next();
	const measured_gets = map_gets;
	if (block.done) throw new Error('expected one generated block');
	vm.runInContext(block.value, context);
	for (let i = 0; i < count; i++) {
		if (root.children[i].child !== (i === 0 ? undefined : root.children[i - 1])) {
			throw new Error(`descriptor root chain identity failed at ${i}`);
		}
	}
	return { count, map_gets: measured_gets, holes: count, bytes: result.head.length + block.value.length };
}

async function run_overlapping(count, unevalStream) {
	// A first operation lowers every ascending chain node as a new ordinary root,
	// then a second operation in a later batch lowers one new wrapper root that
	// re-reaches the whole chain. Correct per-operation scratch re-traverses the
	// chain; a scratch map leaked across event boundaries would prune it instead.
	const nodes = [];
	let chain;
	for (let i = 0; i < count; i++) {
		const node = { index: i, child: chain };
		nodes.push(node);
		chain = node;
	}
	const wrapper = { child: nodes[count - 1] };
	const gates = [deferred(), deferred()];
	const first = {};
	const second = {};
	const result = await unevalStream({ first, second }, (value, js) => value === first || value === second ? {
		type: 'async-value',
		source: value === first ? gates[0].promise : gates[1].promise,
		construct: () => js`({children:[],value:null})`,
		resolve: (reference) => {
			if (value === first) {
				let operation;
				for (let i = 0; i < count; i++) {
					const push = js`${reference.target}.children.push(${nodes[i]})`;
					operation = i === 0 ? push : js`${operation};${push}`;
				}
				return operation;
			}
			return js`${reference.target}.value=${wrapper}`;
		},
		reject: () => js``
	} : undefined, { id: `operation-holes-overlapping-${count}` });
	const context = vm.createContext({});
	context.globalThis = context;
	const root = vm.runInContext(`(${result.head})`, context);
	map_gets = 0;
	gates[0].resolve(undefined);
	const first_block = await result.tail.next();
	const event1 = map_gets;
	if (first_block.done) throw new Error('expected a first generated block');
	map_gets = 0;
	gates[1].resolve(undefined);
	const second_block = await result.tail.next();
	const event2 = map_gets;
	if (second_block.done) throw new Error('expected a second generated block');
	vm.runInContext(first_block.value, context);
	vm.runInContext(second_block.value, context);
	for (let i = 0; i < count; i++) {
		if (root.first.children[i].child !== (i === 0 ? undefined : root.first.children[i - 1])) {
			throw new Error(`first-batch descriptor root chain identity failed at ${i}`);
		}
	}
	if (root.second.value.child !== root.first.children[count - 1]) {
		throw new Error('second-batch wrapper did not re-reach the first-batch chain identity');
	}
	return { count, event1: { map_gets: event1, holes: count }, event2: { map_gets: event2, holes: 1 } };
}

try {
	globalThis.Map = InstrumentedMap;
	const { unevalStream } = await import('../../index.js');
	const args = process.argv.slice(2);
	const events_mode = args.includes('--events');
	const counts = args.filter((arg) => arg !== '--events').map(Number);
	if (counts.length === 0 || counts.some((count) => !Number.isSafeInteger(count) || count < 1)) {
		throw new TypeError('pass one or more positive integer fixture sizes');
	}
	const results = [];
	for (const count of counts) {
		results.push(events_mode ? await run_overlapping(count, unevalStream) : await run(count, unevalStream));
	}
	console.log(JSON.stringify({
		node: process.version,
		fixture: events_mode
			? 'ascending overlapping ordinary-identity roots, then a second-batch wrapper re-reaching the chain'
			: 'ascending overlapping ordinary-identity roots in one async descriptor operation',
		counting: events_mode
			? 'Map.get calls per event window from resolution through generated block'
			: 'Map.get calls from resolution through generated block',
		results
	}));
} finally {
	globalThis.Map = NativeMap;
}