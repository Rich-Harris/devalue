import * as vm from 'vm';
import * as assert from 'uvu/assert';
import * as uvu from 'uvu';
import { devalue } from './devalue.js';

/**
 * @typedef {(name: string, input: any, expected: string) => void} TestFunction
 */

/**
 * @param {string} name
 * @param {(test: TestFunction) => void} fn
 */
function compare(name, fn) {
	const test = uvu.suite(name);
	fn((name, input, expected) => {
		test(name, () => {
			const actual = devalue(input);
			assert.equal(actual, expected);
		});
	});
	test.run();
}

compare('basics', (t) => {
	t('number', 42, '42');
	t('negative number', -42, '-42');
	t('negative zero', -0, '-0');
	t('positive decimal', 0.1, '.1');
	t('negative decimal', -0.1, '-.1');
	t('string', 'woo!!!', '"woo!!!"');
	t('boolean', true, 'true');
	t('Number', new Number(42), 'Object(42)');
	t('String', new String('yar'), 'Object("yar")');
	t('Boolean', new Boolean(false), 'Object(false)');
	t('undefined', undefined, 'void 0');
	t('null', null, 'null');
	t('NaN', NaN, 'NaN');
	t('Infinity', Infinity, 'Infinity');
	t('RegExp', /regexp/gim, 'new RegExp("regexp", "gim")');
	t('Date', new Date(1e12), 'new Date(1000000000000)');
	t('Array', ['a', 'b', 'c'], '["a","b","c"]');
	t('Array (empty)', [], '[]');
	t('Array (sparse)', [, 'b', ,], '[,"b",,]');
	t('Object', { foo: 'bar', 'x-y': 'z' }, '{foo:"bar","x-y":"z"}');
	t('Set', new Set([1, 2, 3]), 'new Set([1,2,3])');
	t('Map', new Map([['a', 'b']]), 'new Map([["a","b"]])');
	t('BigInt', BigInt('1'), '1n');
});

compare('strings', (t) => {
	t('newline', 'a\nb', JSON.stringify('a\nb'));
	t('double quotes', '"yar"', JSON.stringify('"yar"'));
	t('lone low surrogate', 'a\uDC00b', '"a\\uDC00b"');
	t('lone high surrogate', 'a\uD800b', '"a\\uD800b"');
	t('two low surrogates', 'a\uDC00\uDC00b', '"a\\uDC00\\uDC00b"');
	t('two high surrogates', 'a\uD800\uD800b', '"a\\uD800\\uD800b"');
	t('surrogate pair', '𝌆', JSON.stringify('𝌆'));
	t('surrogate pair in wrong order', 'a\uDC00\uD800b', '"a\\uDC00\\uD800b"');
	t('nul', '\0', '"\\0"');
	t('backslash', '\\', JSON.stringify('\\'));
});

compare('cycles', (t) => {
	let map = new Map();
	map.set('self', map);
	t('Map (cyclical)', map, `(function(a){a.set("self", a);return a}(new Map))`);

	let set = new Set();
	set.add(set);
	set.add(42);
	t('Set (cyclical)', set, `(function(a){a.add(a).add(42);return a}(new Set))`);

	/** @type {any[]} */
	let arr = [];
	arr[0] = arr;
	t('Array (cyclical)', arr, `(function(a){a[0]=a;return a}(Array(1)))`);

	/** @type {Record<string, any>} */
	let obj = {};
	obj.self = obj;
	t('Object (cyclical)', obj, `(function(a){a.self=a;return a}({}))`);

	/** @type {Record<string, any>} */
	let objFromNull = Object.create(null);
	objFromNull.self = objFromNull;
	t(
		'Object (cyclical)',
		objFromNull,
		`(function(a){a.self=a;return a}(Object.create(null)))`
	);

	/** @type {Record<string, any>} */
	let first = {};

	/** @type {Record<string, any>} */
	let second = {};

	first.second = second;
	second.first = first;
	t(
		'Object (cyclical)',
		[first, second],
		`(function(a,b){a.second=b;b.first=a;return [a,b]}({},{}))`
	);
});

compare('repetition', (t) => {
	let str = 'a string';
	t(
		'String (repetition)',
		[str, str],
		`(function(a){return [a,a]}("a string"))`
	);
});

compare('XSS', (t) => {
	t(
		'Dangerous string',
		`</script><script src='https://evil.com/script.js'>alert('pwned')</script><script>`,
		`"\\u003C\\u002Fscript\\u003E\\u003Cscript src='https:\\u002F\\u002Fevil.com\\u002Fscript.js'\\u003Ealert('pwned')\\u003C\\u002Fscript\\u003E\\u003Cscript\\u003E"`
	);
	t(
		'Dangerous key',
		{ '<svg onload=alert("xss_works")>': 'bar' },
		'{"\\u003Csvg onload=alert(\\"xss_works\\")\\u003E":"bar"}'
	);
	t(
		'Dangerous regex',
		/[</script><script>alert('xss')//]/,
		`new RegExp("[\\u003C\\u002Fscript\\u003E\\u003Cscript\\u003Ealert('xss')\\u002F\\u002F]", "")`
	);
});

compare('misc', (t) => {
	t('Object without prototype', Object.create(null), 'Object.create(null)');
	t('cross-realm POJO', vm.runInNewContext('({})'), '{}');
});

uvu.test('throws for non-POJOs', () => {
	class Foo {}
	const foo = new Foo();
	assert.throws(() => devalue(foo));
});

uvu.test('throws for symbolic keys', () => {
	assert.throws(() => devalue({ [Symbol()]: null }));
});

uvu.test('does not create duplicate parameter names', () => {
	const foo = new Array(20000).fill(0).map((_, i) => i);
	const bar = foo.map((_, i) => ({ [i]: foo[i] }));
	const serialized = devalue([foo, ...bar]);

	eval(serialized);
});

uvu.test.run();
