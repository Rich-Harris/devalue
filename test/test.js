import * as util from 'util';
import * as vm from 'vm';
import * as assert from 'uvu/assert';
import * as uvu from 'uvu';
import { devalue, parse, stringify } from '../index.js';

const fixtures = {
	basics: [
		{
			name: 'number',
			value: 42,
			js: '42',
			json: '[42]'
		},
		{
			name: 'negative number',
			value: -42,
			js: '-42',
			json: '[-42]'
		},
		{
			name: 'negative zero',
			value: -0,
			js: '-0',
			json: '-6'
		},
		{
			name: 'positive decimal',
			value: 0.1,
			js: '.1',
			json: '[0.1]'
		},
		{
			name: 'negative decimal',
			value: -0.1,
			js: '-.1',
			json: '[-0.1]'
		},
		{
			name: 'string',
			value: 'woo!!!',
			js: '"woo!!!"',
			json: '["woo!!!"]'
		},
		{
			name: 'boolean',
			value: true,
			js: 'true',
			json: '[true]'
		},
		{
			name: 'Number',
			value: new Number(42),
			js: 'Object(42)',
			json: '[["Object",42]]'
		},
		{
			name: 'String',
			value: new String('yar'),
			js: 'Object("yar")',
			json: '[["Object","yar"]]'
		},
		{
			name: 'Boolean',
			value: new Boolean(false),
			js: 'Object(false)',
			json: '[["Object",false]]'
		},
		{
			name: 'undefined',
			value: undefined,
			js: 'void 0',
			json: '-1'
		},
		{
			name: 'null',
			value: null,
			js: 'null',
			json: '[null]'
		},
		{
			name: 'NaN',
			value: NaN,
			js: 'NaN',
			json: '-3'
		},
		{
			name: 'Infinity',
			value: Infinity,
			js: 'Infinity',
			json: '-4'
		},
		{
			name: 'RegExp',
			value: /regexp/gim,
			js: 'new RegExp("regexp", "gim")',
			json: '[["RegExp","regexp","gim"]]'
		},
		{
			name: 'Date',
			value: new Date(1e12),
			js: 'new Date(1000000000000)',
			json: '[["Date","2001-09-09T01:46:40.000Z"]]'
		},
		{
			name: 'Array',
			value: ['a', 'b', 'c'],
			js: '["a","b","c"]',
			json: '[[1,2,3],"a","b","c"]'
		},
		{
			name: 'Array (empty)',
			value: [],
			js: '[]',
			json: '[[]]'
		},
		{
			name: 'Array (sparse)',
			value: [, 'b', ,],
			js: '[,"b",,]',
			json: '[[-2,1,-2],"b"]'
		},
		{
			name: 'Object',
			value: { foo: 'bar', 'x-y': 'z' },
			js: '{foo:"bar","x-y":"z"}',
			json: '[{"foo":1,"x-y":2},"bar","z"]'
		},
		{
			name: 'Set',
			value: new Set([1, 2, 3]),
			js: 'new Set([1,2,3])',
			json: '[["Set",[1,2,3]],1,2,3]'
		},
		{
			name: 'Map',
			value: new Map([['a', 'b']]),
			js: 'new Map([["a","b"]])',
			json: '[["Map",[1,2]],"a","b"]'
		},
		{
			name: 'BigInt',
			value: BigInt('1'),
			js: '1n',
			json: '[["BigInt","1"]]'
		}
	],

	strings: [
		{
			name: 'newline',
			value: 'a\nb',
			js: JSON.stringify('a\nb'),
			json: '["a\\nb"]'
		},
		{
			name: 'double quotes',
			value: '"yar"',
			js: JSON.stringify('"yar"'),
			json: '["\\"yar\\""]'
		},
		{
			name: 'lone low surrogate',
			value: 'a\uDC00b',
			js: '"a\\uDC00b"',
			json: '["a\\uDC00b"]'
		},
		{
			name: 'lone high surrogate',
			value: 'a\uD800b',
			js: '"a\\uD800b"',
			json: '["a\\uD800b"]'
		},
		{
			name: 'two low surrogates',
			value: 'a\uDC00\uDC00b',
			js: '"a\\uDC00\\uDC00b"',
			json: '["a\\uDC00\\uDC00b"]'
		},
		{
			name: 'two high surrogates',
			value: 'a\uD800\uD800b',
			js: '"a\\uD800\\uD800b"',
			json: '["a\\uD800\\uD800b"]'
		},
		{
			name: 'surrogate pair',
			value: '𝌆',
			js: JSON.stringify('𝌆'),
			json: `[${JSON.stringify('𝌆')}]`
		},
		{
			name: 'surrogate pair in wrong order',
			value: 'a\uDC00\uD800b',
			js: '"a\\uDC00\\uD800b"',
			json: '["a\\uDC00\\uD800b"]'
		},
		{
			name: 'nul',
			value: '\0',
			js: '"\\0"',
			json: '["\\0"]'
		},
		{
			name: 'backslash',
			value: '\\',
			js: JSON.stringify('\\'),
			json: '["\\\\"]'
		}
	],

	cycles: [
		((map) => {
			map.set('self', map);
			return {
				name: 'Map (cyclical)',
				value: map,
				js: '(function(a){a.set("self", a);return a}(new Map))',
				json: '[["Map",[1,0]],"self"]'
			};
		})(new Map()),

		((set) => {
			set.add(set);
			set.add(42);
			return {
				name: 'Set (cyclical)',
				value: set,
				js: '(function(a){a.add(a).add(42);return a}(new Set))',
				json: '[["Set",[0,1]],42]'
			};
		})(new Set()),

		((arr) => {
			arr[0] = arr;
			return {
				name: 'Array (cyclical)',
				value: arr,
				js: '(function(a){a[0]=a;return a}(Array(1)))',
				json: '[[0]]'
			};
		})([]),

		((obj) => {
			obj.self = obj;
			return {
				name: 'Object (cyclical)',
				value: obj,
				js: '(function(a){a.self=a;return a}({}))',
				json: '[{"self":0}]'
			};
		})({}),

		((obj) => {
			obj.self = obj;
			return {
				name: 'Object with null prototype (cyclical)',
				value: obj,
				js: '(function(a){a.self=a;return a}(Object.create(null)))',
				json: '[["null","self",0]]'
			};
		})(Object.create(null)),

		((first, second) => {
			first.second = second;
			second.first = first;
			return {
				name: 'Object (cyclical)',
				value: [first, second],
				js: '(function(a,b){a.second=b;b.first=a;return [a,b]}({},{}))',
				json: '[[1,2],{"second":2},{"first":1}]'
			};
		})({}, {})
	],

	repetition: [
		{
			name: 'String (repetition)',
			value: ['a string', 'a string'],
			js: '(function(a){return [a,a]}("a string"))',
			json: '[[1,1],"a string"]'
		}
	],

	XSS: [
		{
			name: 'Dangerous string',
			value: `</script><script src='https://evil.com/script.js'>alert('pwned')</script><script>`,
			js: `"\\u003C\\u002Fscript\\u003E\\u003Cscript src='https:\\u002F\\u002Fevil.com\\u002Fscript.js'\\u003Ealert('pwned')\\u003C\\u002Fscript\\u003E\\u003Cscript\\u003E"`,
			json: `["\\u003C\\u002Fscript\\u003E\\u003Cscript src='https:\\u002F\\u002Fevil.com\\u002Fscript.js'\\u003Ealert('pwned')\\u003C\\u002Fscript\\u003E\\u003Cscript\\u003E"]`
		},
		{
			name: 'Dangerous key',
			value: { '<svg onload=alert("xss_works")>': 'bar' },
			js: '{"\\u003Csvg onload=alert(\\"xss_works\\")\\u003E":"bar"}',
			json: '[{"\\u003Csvg onload=alert(\\"xss_works\\")\\u003E":1},"bar"]'
		},
		{
			name: 'Dangerous regex',
			value: /[</script><script>alert('xss')//]/,
			js: `new RegExp("[\\u003C\\u002Fscript\\u003E\\u003Cscript\\u003Ealert('xss')\\u002F\\u002F]", "")`,
			json: `[["RegExp","[\\u003C\\u002Fscript\\u003E\\u003Cscript\\u003Ealert('xss')\\u002F\\u002F]"]]`
		}
	],

	misc: [
		{
			name: 'Object without prototype',
			value: Object.create(null),
			js: 'Object.create(null)',
			json: '[["null"]]'
		},
		{
			name: 'cross-realm POJO',
			value: vm.runInNewContext('({})'),
			js: '{}',
			json: '[{}]'
		}
	]
};

for (const [name, tests] of Object.entries(fixtures)) {
	const test = uvu.suite(`devalue: ${name}`);
	for (const t of tests) {
		test(t.name, () => {
			const actual = devalue(t.value);
			const expected = t.js;
			assert.equal(actual, expected);
		});
	}
	test.run();
}

for (const [name, tests] of Object.entries(fixtures)) {
	const test = uvu.suite(`stringify: ${name}`);
	for (const t of tests) {
		test(t.name, () => {
			const actual = stringify(t.value);
			const expected = t.json;
			assert.equal(actual, expected);
		});
	}
	test.run();
}

for (const [name, tests] of Object.entries(fixtures)) {
	const test = uvu.suite(`parse: ${name}`);
	for (const t of tests) {
		test(t.name, () => {
			const actual = parse(t.json);
			const expected = t.value;
			assert.equal(actual, expected);
		});
	}
	test.run();
}

for (const fn of [devalue, stringify]) {
	uvu.test(`${fn.name} throws for non-POJOs`, () => {
		class Foo {}
		const foo = new Foo();
		assert.throws(() => fn(foo));
	});

	uvu.test(`${fn.name} throws for symbolic keys`, () => {
		assert.throws(() => fn({ [Symbol()]: null }));
	});

	uvu.test(`${fn.name} populates error.keys and error.path`, () => {
		try {
			fn({
				foo: {
					array: [function invalid() {}]
				}
			});
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify a function');
			assert.equal(e.path, '.foo.array[0]');
		}

		try {
			class Whatever {}
			fn({
				foo: {
					map: new Map([['key', new Whatever()]])
				}
			});
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify arbitrary non-POJOs');
			assert.equal(e.path, '.foo.map.get("key")');
		}
	});
}

uvu.test('does not create duplicate parameter names', () => {
	const foo = new Array(20000).fill(0).map((_, i) => i);
	const bar = foo.map((_, i) => ({ [i]: foo[i] }));
	const serialized = devalue([foo, ...bar]);

	eval(serialized);
});

uvu.test.run();
