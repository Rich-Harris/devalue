import vm from 'node:vm';

const NativeMap = globalThis.Map;
let map_gets = 0;

class InstrumentedMap extends NativeMap {
	get(key) {
		map_gets++;
		return super.get(key);
	}
}

class Wrapper {
	constructor(value) {
		this.value = value;
	}
}

function deferred() {
	let resolve;
	const promise = new Promise((fulfil) => { resolve = fulfil; });
	return { promise, resolve };
}

async function run(count, unevalStream) {
	let node = { leaf: 1 };
	const nodes = [];
	for (let i = 0; i < count; i++) {
		nodes.push(node);
		node = { child: node };
	}
	const pending = deferred();
	const input = {
		wrappers: nodes.map((value) => new Wrapper(value)),
		pending: pending.promise
	};
	map_gets = 0;
	const result = await unevalStream(input, (value, js) => value instanceof Wrapper && js`({value:${value.value}})`, {
		id: 'retained-scaling'
	});
	const measured_gets = map_gets;
	const slots = (result.head.match(/\.s\[\d+\]=/g) ?? []).length;
	const context = vm.createContext({});
	context.globalThis = context;
	const root = vm.runInContext(`(${result.head})`, context);
	for (let i = 1; i < root.wrappers.length; i++) {
		if (root.wrappers[i].value.child !== root.wrappers[i - 1].value) {
			throw new Error(`wrapper chain identity failed at ${i}`);
		}
	}
	pending.resolve(nodes[Math.floor(count / 2)]);
	let bytes = result.head.length;
	for await (const block of result.tail) {
		bytes += block.length;
		vm.runInContext(block, context);
	}
	if (await root.pending !== root.wrappers[Math.floor(count / 2)].value) {
		throw new Error('later Promise outcome did not reuse the retained wrapper child');
	}
	return { count, map_gets: measured_gets, slots, bytes };
}

try {
	globalThis.Map = InstrumentedMap;
	const { unevalStream } = await import('../../index.js');
	const counts = process.argv.slice(2).map(Number);
	if (counts.length === 0 || counts.some((count) => !Number.isSafeInteger(count) || count < 1)) {
		throw new TypeError('pass one or more positive integer fixture sizes');
	}
	const results = [];
	for (const count of counts) results.push(await run(count, unevalStream));
	console.log(JSON.stringify({
		node: process.version,
		fixture: 'ascending overlapping opaque chain with one pending Promise',
		counting: 'Map.get calls from immediately before unevalStream through its initial serialization',
		results
	}));
} finally {
	globalThis.Map = NativeMap;
}
