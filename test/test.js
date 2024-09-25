import * as vm from 'vm';
import * as assert from 'uvu/assert';
import * as uvu from 'uvu';
import { uneval, unflatten, parse, stringify } from '../index.js';

class Custom {
	constructor(value) {
		this.value = value;
	}
}

const node_version = +process.versions.node.split('.')[0];

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
			name: 'invalid Date',
			value: new Date(''),
			js: 'new Date(NaN)',
			json: '[["Date",""]]',
			validate: (value) => {
				assert.ok(isNaN(value.valueOf()));
			}
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
			json: '[["Set",1,2,3],1,2,3]'
		},
		{
			name: 'Map',
			value: new Map([['a', 'b']]),
			js: 'new Map([["a","b"]])',
			json: '[["Map",1,2],"a","b"]'
		},
		{
			name: 'BigInt',
			value: BigInt('1'),
			js: '1n',
			json: '[["BigInt","1"]]'
		},
		{
			name: 'Uint8Array',
			value: new Uint8Array([1, 2, 3]),
			js: 'new Uint8Array([1,2,3])',
			json: '[["Uint8Array","AQID"]]'
		},
		{
			name: 'ArrayBuffer',
			value: new Uint8Array([1, 2, 3]).buffer,
			js: 'new Uint8Array([1,2,3]).buffer',
			json: '[["ArrayBuffer","AQID"]]'
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
			js: '"a\uDC00b"',
			json: '["a\uDC00b"]'
		},
		{
			name: 'lone high surrogate',
			value: 'a\uD800b',
			js: '"a\uD800b"',
			json: '["a\uD800b"]'
		},
		{
			name: 'two low surrogates',
			value: 'a\uDC00\uDC00b',
			js: '"a\uDC00\uDC00b"',
			json: '["a\uDC00\uDC00b"]'
		},
		{
			name: 'two high surrogates',
			value: 'a\uD800\uD800b',
			js: '"a\uD800\uD800b"',
			json: '["a\uD800\uD800b"]'
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
			js: '"a\uDC00\uD800b"',
			json: '["a\uDC00\uD800b"]'
		},
		{
			name: 'nul',
			value: '\0',
			js: '"\\u0000"',
			json: '["\\u0000"]'
		},
		{
			name: 'control character',
			value: '\u0001',
			js: '"\\u0001"',
			json: '["\\u0001"]'
		},
		{
			name: 'control character extremum',
			value: '\u001F',
			js: '"\\u001f"',
			json: '["\\u001f"]'
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
				json: '[["Map",1,0],"self"]',
				validate: (value) => {
					assert.is(value.get('self'), value);
				}
			};
		})(new Map()),

		((set) => {
			set.add(set);
			set.add(42);
			return {
				name: 'Set (cyclical)',
				value: set,
				js: '(function(a){a.add(a).add(42);return a}(new Set))',
				json: '[["Set",0,1],42]',
				validate: (value) => {
					assert.is(value.size, 2);
					assert.ok(value.has(42));
					assert.ok(value.has(value));
				}
			};
		})(new Set()),

		((arr) => {
			arr[0] = arr;
			return {
				name: 'Array (cyclical)',
				value: arr,
				js: '(function(a){a[0]=a;return a}(Array(1)))',
				json: '[[0]]',
				validate: (value) => {
					assert.is(value.length, 1);
					assert.is(value[0], value);
				}
			};
		})([]),

		((obj) => {
			obj.self = obj;
			return {
				name: 'Object (cyclical)',
				value: obj,
				js: '(function(a){a.self=a;return a}({}))',
				json: '[{"self":0}]',
				validate: (value) => {
					assert.is(value.self, value);
				}
			};
		})({}),

		((obj) => {
			obj.self = obj;
			return {
				name: 'Object with null prototype (cyclical)',
				value: obj,
				js: '(function(a){a.self=a;return a}(Object.create(null)))',
				json: '[["null","self",0]]',
				validate: (value) => {
					assert.is(Object.getPrototypeOf(value), null);
					assert.is(value.self, value);
				}
			};
		})(Object.create(null)),

		((first, second) => {
			first.second = second;
			second.first = first;
			return {
				name: 'Object (cyclical)',
				value: [first, second],
				js: '(function(a,b){a.second=b;b.first=a;return [a,b]}({},{}))',
				json: '[[1,2],{"second":2},{"first":1}]',
				validate: (value) => {
					assert.is(value[0].second, value[1]);
					assert.is(value[1].first, value[0]);
				}
			};
		})({}, {})
	],

	repetition: [
		{
			name: 'String (repetition)',
			value: ['a string', 'a string'],
			js: '["a string","a string"]',
			json: '[[1,1],"a string"]'
		},

		{
			name: 'null (repetition)',
			value: [null, null],
			js: '[null,null]',
			json: '[[1,1],null]'
		},

		((object) => {
			return {
				name: 'Object (repetition)',
				value: [object, object],
				js: '(function(a){return [a,a]}({}))',
				json: '[[1,1],{}]'
			};
		})({})
	],

	XSS: [
		{
			name: 'Dangerous string',
			value: `</script><script src='https://evil.com/script.js'>alert('pwned')</script><script>`,
			js: `"\\u003C/script>\\u003Cscript src='https://evil.com/script.js'>alert('pwned')\\u003C/script>\\u003Cscript>"`,
			json: `["\\u003C/script>\\u003Cscript src='https://evil.com/script.js'>alert('pwned')\\u003C/script>\\u003Cscript>"]`
		},
		{
			name: 'Dangerous key',
			value: { '<svg onload=alert("xss_works")>': 'bar' },
			js: '{"\\u003Csvg onload=alert(\\"xss_works\\")>":"bar"}',
			json: '[{"\\u003Csvg onload=alert(\\"xss_works\\")>":1},"bar"]'
		},
		{
			name: 'Dangerous regex',
			value: /[</script><script>alert('xss')//]/,
			js: `new RegExp("[\\u003C/script>\\u003Cscript>alert('xss')//]", "")`,
			json: `[["RegExp","[\\u003C/script>\\u003Cscript>alert('xss')//]"]]`
		}
	],

	misc: [
		{
			name: 'Object without prototype',
			value: Object.create(null),
			js: 'Object.create(null)',
			json: '[["null"]]',
			validate: (value) => {
				assert.equal(Object.getPrototypeOf(value), null);
				assert.equal(Object.keys(value).length, 0);
			}
		},
		{
			name: 'cross-realm POJO',
			value: vm.runInNewContext('({})'),
			js: '{}',
			json: '[{}]',
			validate: (value) => {
				assert.equal(Object.getPrototypeOf(value), Object.prototype);
				assert.equal(Object.keys(value).length, 0);
			}
		},
		{
			name: 'non-enumerable symbolic key',
			value: (() => {
				const obj = { x: 1 };
				Object.defineProperty(obj, Symbol('key'), {
					value: 'value',
					enumerable: false
				});
				return obj;
			})(),
			js: '{x:1}',
			json: '[{"x":1},1]'
		}
	],

	custom: ((instance) => [
		{
			name: 'Custom type',
			value: [instance, instance],
			js: '(function(a){return [a,a]}(new Custom({answer:42})))',
			json: '[[1,1],["Custom",2],{"answer":3},42]',
			replacer: (value) => {
				if (value instanceof Custom) {
					return `new Custom(${uneval(value.value)})`;
				}
			},
			// test for https://github.com/Rich-Harris/devalue/pull/80
			reducers: Object.assign(Object.create({ polluted: true }), {
				Custom: (x) => x instanceof Custom && x.value
			}),
			revivers: {
				Custom: (x) => new Custom(x)
			},
			validate: ([obj1, obj2]) => {
				assert.is(obj1, obj2);
				assert.ok(obj1 instanceof Custom);
				assert.equal(obj1.value.answer, 42);
			}
		}
	])(new Custom({ answer: 42 }))
};

for (const [name, tests] of Object.entries(fixtures)) {
	const test = uvu.suite(`uneval: ${name}`);
	for (const t of tests) {
		test(t.name, () => {
			const actual = uneval(t.value, t.replacer);
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
			const actual = stringify(t.value, t.reducers);
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
			const actual = parse(t.json, t.revivers);
			const expected = t.value;

			if (t.validate) {
				t.validate(actual);
			} else {
				assert.equal(actual, expected);
			}
		});
	}
	test.run();
}

for (const [name, tests] of Object.entries(fixtures)) {
	const test = uvu.suite(`unflatten: ${name}`);
	for (const t of tests) {
		test(t.name, () => {
			const actual = unflatten(JSON.parse(t.json), t.revivers);
			const expected = t.value;

			if (t.validate) {
				t.validate(actual);
			} else {
				assert.equal(actual, expected);
			}
		});
	}
	test.run();
}

const invalid = [
	{
		name: 'empty string',
		json: '',
		message: 'Unexpected end of JSON input'
	},
	{
		name: 'invalid JSON',
		json: '][',
		message:
			node_version >= 20
				? `Unexpected token ']', "][" is not valid JSON`
				: 'Unexpected token ] in JSON at position 0'
	},
	{
		name: 'hole',
		json: '-2',
		message: 'Invalid input'
	},
	{
		name: 'string',
		json: '"hello"',
		message: 'Invalid input'
	},
	{
		name: 'number',
		json: '42',
		message: 'Invalid input'
	},
	{
		name: 'boolean',
		json: 'true',
		message: 'Invalid input'
	},
	{
		name: 'null',
		json: 'null',
		message: 'Invalid input'
	},
	{
		name: 'object',
		json: '{}',
		message: 'Invalid input'
	},
	{
		name: 'empty array',
		json: '[]',
		message: 'Invalid input'
	}
];

for (const { name, json, message } of invalid) {
	uvu.test(`parse error: ${name}`, () => {
		assert.throws(
			() => parse(json),
			(error) => {
				const match = error.message === message;
				if (!match) {
					console.error(`Expected: ${message}, got: ${error.message}`);
				}
				return match;
			}
		);
	});
}

for (const fn of [uneval, stringify]) {
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
					['string-key']: new Map([['key', new Whatever()]])
				}
			});
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify arbitrary non-POJOs');
			assert.equal(e.path, '.foo["string-key"].get("key")');
		}
	});

	uvu.test(`${fn.name} populates error.path after maps (#64)`, () => {
		try {
			fn({
				map: new Map([['key', 'value']]),
				object: {
					invalid() {}
				}
			});
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify a function');
			assert.equal(e.path, '.object.invalid');
		}
	});
}

uvu.test('does not create duplicate parameter names', () => {
	const foo = new Array(20000).fill(0).map((_, i) => i);
	const bar = foo.map((_, i) => ({ [i]: foo[i] }));
	const serialized = uneval([foo, ...bar]);

	eval(serialized);
});

uvu.test.run();
