import vm from 'node:vm';

const NativeMap = globalThis.Map;
const NativeSet = globalThis.Set;
let copied_entries = 0;
let copied_containers = 0;

class InstrumentedMap extends NativeMap {
	constructor(iterable) {
		super(iterable);
		if (iterable instanceof NativeMap) {
			copied_containers++;
			copied_entries += iterable.size;
		}
	}
}

class InstrumentedSet extends NativeSet {
	constructor(iterable) {
		super(iterable);
		if (iterable instanceof NativeSet) {
			copied_containers++;
			copied_entries += iterable.size;
		}
	}
}

async function run(count, unevalStream) {
	copied_entries = 0;
	copied_containers = 0;
	const promises = Array.from({ length: count }, (_, index) => Promise.resolve(index));
	const result = await unevalStream(promises, undefined, { id: `scalar-scaling-${count}` });
	const context = vm.createContext({});
	context.globalThis = context;
	const root = vm.runInContext(`(${result.head})`, context);
	let bytes = result.head.length;
	for await (const block of result.tail) {
		bytes += block.length;
		vm.runInContext(block, context);
	}
	const values = await Promise.all(Array.from(root));
	if (values.length !== count || values.some((value, index) => value !== index)) {
		throw new Error(`scalar fixture did not consume ${count} generated Promise outcomes`);
	}
	return { count, copied_entries, copied_containers, bytes };
}

try {
	globalThis.Map = InstrumentedMap;
	globalThis.Set = InstrumentedSet;
	const { unevalStream } = await import('../../index.js');
	const counts = process.argv.slice(2).map(Number);
	if (counts.length === 0 || counts.some((count) => !Number.isSafeInteger(count) || count < 1)) {
		throw new TypeError('pass one or more positive integer fixture sizes');
	}
	const results = [];
	for (const count of counts) results.push(await run(count, unevalStream));
	console.log(JSON.stringify({ node: process.version, fixture: 'resolved native Promise<number>[]', results }));
} finally {
	globalThis.Map = NativeMap;
	globalThis.Set = NativeSet;
}
