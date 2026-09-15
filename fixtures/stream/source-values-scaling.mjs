import { js } from '../../src/javascript-source.js';
import { source_values } from '../../src/stream-source.js';

const intrinsic_push = Array.prototype.push;

function run(count) {
	const expected = Array.from({ length: count }, (_, index) => ({ index }));
	let source = js`0`;
	for (const value of expected) source = js`${source},${value}`;

	let appended = 0;
	let values;
	Array.prototype.push = function (...items) {
		appended += items.length;
		return Reflect.apply(intrinsic_push, this, items);
	};
	try {
		values = source_values(source);
	} finally {
		Array.prototype.push = intrinsic_push;
	}

	if (values.length !== count) throw new Error(`expected ${count} holes, received ${values.length}`);
	for (let i = 0; i < count; i++) {
		if (values[i] !== expected[i]) throw new Error(`hole identity/order failed at ${i}`);
	}
	return { count, appended, holes: values.length };
}

const counts = process.argv.slice(2).map(Number);
if (counts.length === 0 || counts.some((count) => !Number.isSafeInteger(count) || count < 1)) {
	throw new TypeError('pass one or more positive integer fixture sizes');
}

console.log(JSON.stringify({
	node: process.version,
	fixture: 'left-nested JavaScriptSource with one ordinary object hole per fragment',
	counting: 'Array.prototype.push arguments during source_values(source)',
	results: counts.map(run)
}));
