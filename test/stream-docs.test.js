import { readFileSync } from 'node:fs';
import { suite } from 'uvu';
import * as assert from 'uvu/assert';
import { unevalStream } from '../index.js';

const test = suite('unevalStream documentation');

function deferred() {
	let resolve;
	const promise = new Promise((fulfil) => {
		resolve = fulfil;
	});
	return { promise, resolve };
}

test('the documented concatenation form evaluates real tail statements before returning the root', async () => {
	const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
	assert.ok(readme.includes('const root = new Function(`const root=(${head});${blocks.join(\'\')};return root`)();'));

	const later = deferred();
	const { head, tail } = await unevalStream({ quick: 'data', slow: later.promise }, undefined, { id: 'docs-concatenation' });
	later.resolve('arrived after head');
	const blocks = [];
	for await (const block of tail) blocks.push(block);
	assert.ok(blocks.length > 0);

	const root = new Function(`const root=(${head});${blocks.join('')};return root`)();
	assert.is(root.quick, 'data');
	assert.is(await root.slow, 'arrived after head');
});

test.run();
