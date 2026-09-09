import * as vm from 'vm';
import * as assert from 'uvu/assert';
import * as uvu from 'uvu';
import * as consts from '../src/constants.js';
import { uneval, unflatten, parse, stringify, stringifyAsync } from '../index.js';

globalThis.Temporal ??= (await import('@js-temporal/polyfill')).Temporal;

class Foo {
	constructor(value) {
		this.value = value;
	}
}

class Bar {
	constructor(value) {
		this.value = value;
	}
}

function NullObject() {}
NullObject.prototype = Object.create(null);

const node_version = +process.versions.node.split('.')[0];

const fixtures = {
	primitives: [
		{
			name: 'number: positive integer',
			value: 42,
			js: '42',
			json: '[42]'
		},
		{
			name: 'number: negative integer',
			value: -5,
			js: '-5',
			json: '[-5]'
		},
		{
			name: 'number: positive decimal',
			value: 0.1,
			js: '.1',
			json: '[0.1]'
		},
		{
			name: 'number: negative decimal',
			value: -0.1,
			js: '-.1',
			json: '[-0.1]'
		},
		{
			name: 'number: NaN',
			value: NaN,
			js: 'NaN',
			json: `${consts.NAN}`
		},
		{
			name: 'number: +Infinity',
			value: Infinity,
			js: 'Infinity',
			json: `${consts.POSITIVE_INFINITY}`
		},
		{
			name: 'number: -Infinity',
			value: -Infinity,
			js: '-Infinity',
			json: `${consts.NEGATIVE_INFINITY}`
		},
		{
			name: 'number: zero',
			value: 0,
			js: '0',
			json: '[0]'
		},
		{
			name: 'number: negative zero',
			value: -0,
			js: '-0',
			json: `${consts.NEGATIVE_ZERO}`,
			validate(value) {
				assert.ok(Object.is(value, -0));
			}
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
			name: 'bigint',
			value: 1n,
			js: '1n',
			json: '[["BigInt","1"]]'
		},
		{
			name: 'undefined',
			value: undefined,
			js: 'void 0',
			json: `${consts.UNDEFINED}`
		},
		{
			name: 'null',
			value: null,
			js: 'null',
			json: '[null]'
		}
		// symbols are not supported; see further tests
	],

	boxed_primitives: [
		{
			name: 'Number: positive integer',
			value: new Number(42),
			js: 'Object(42)',
			json: '[["Object",1],42]'
		},
		{
			name: 'Number: negative integer',
			value: new Number(-2),
			js: 'Object(-2)',
			json: '[["Object",1],-2]'
		},
		{
			name: 'Number: positive decimal',
			value: new Number(0.1),
			js: 'Object(.1)',
			json: '[["Object",1],0.1]'
		},
		{
			name: 'Number: negative decimal',
			value: new Number(-0.1),
			js: 'Object(-.1)',
			json: '[["Object",1],-0.1]'
		},
		{
			name: 'Number: NaN',
			value: new Number(NaN),
			js: 'Object(NaN)',
			json: `[["Object",${consts.NAN}]]`
		},
		{
			name: 'Number: +Infinity',
			value: new Number(Infinity),
			js: 'Object(Infinity)',
			json: `[["Object",${consts.POSITIVE_INFINITY}]]`
		},
		{
			name: 'Number: -Infinity',
			value: new Number(-Infinity),
			js: 'Object(-Infinity)',
			json: `[["Object",${consts.NEGATIVE_INFINITY}]]`
		},
		{
			name: 'Number: zero',
			value: new Number(0),
			js: 'Object(0)',
			json: '[["Object",1],0]'
		},
		{
			name: 'Number: negative zero',
			value: new Number(-0),
			js: 'Object(-0)',
			json: `[["Object",${consts.NEGATIVE_ZERO}]]`,
			validate(value) {
				assert.type(value, 'object');
				assert.ok(Object.is(value.valueOf(), -0));
			}
		},
		{
			name: 'String',
			value: new String('woo!!!'),
			js: 'Object("woo!!!")',
			json: '[["Object",1],"woo!!!"]'
		},
		{
			name: 'Boolean',
			value: new Boolean(true),
			js: 'Object(true)',
			json: '[["Object",1],true]'
		},
		{
			name: 'BigInt',
			value: Object(1n),
			js: 'Object(1n)',
			json: '[["Object",1],["BigInt","1"]]'
		}
		// it's not possible to box undefined or null
		// boxed symbols are not supported; see further tests
	],

	basics: [
		{
			name: 'RegExp',
			value: /regexp/gim,
			js: 'new RegExp("regexp","gim")',
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
			name: 'Array where negative zero appears after normal zero',
			value: [0, -0],
			js: '[0,-0]',
			json: `[[1,${consts.NEGATIVE_ZERO}],0]`
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
			json: `[[${consts.HOLE},1,${consts.HOLE}],"b"]`
		},
		((arr) => {
			arr[1000000] = 'x';
			return {
				name: 'Array (very sparse)',
				value: arr,
				js: `Object.assign(Array(1000001),{1000000:"x"})`,
				json: `[[${consts.SPARSE},1000001,1000000,1],"x"]`,
				validate: (value) => {
					assert.is(value.length, 1000001);
					assert.is(value[1000000], 'x');
					assert.ok(!(0 in value));
					assert.ok(!(999999 in value));
				}
			};
		})([]),
		((arr) => {
			arr[10] = 'a';
			arr[20] = 'b';
			return {
				name: 'Array (very sparse, multiple values)',
				value: arr,
				js: `[,,,,,,,,,,"a",,,,,,,,,,"b"]`,
				json: `[[${consts.SPARSE},21,10,1,20,2],"a","b"]`,
				validate: (value) => {
					assert.is(value.length, 21);
					assert.is(value[10], 'a');
					assert.is(value[20], 'b');
					assert.ok(!(0 in value));
					assert.ok(!(9 in value));
					assert.ok(!(11 in value));
				}
			};
		})([]),
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
			name: 'Uint8Array',
			value: new Uint8Array([1, 2, 3]),
			js: 'new Uint8Array([1,2,3])',
			json: '[["Uint8Array",1],["ArrayBuffer","AQID"]]'
		},
		{
			// `Buffer.alloc` does not allocate from Node's shared pool, so the buffer
			// backing this view is exactly four bytes and the expectations are stable
			name: 'Node Buffer',
			value: Buffer.alloc(4, 65),
			js: 'new Uint8Array([65,65,65,65])',
			json: '[["Uint8Array",1],["ArrayBuffer","QUFBQQ=="]]',
			validate: (value) => assert.equal(value, new Uint8Array([65, 65, 65, 65]))
		},
		{
			name: 'Float64Array with negative zero',
			value: new Float64Array([-0, 1.5]),
			js: 'new Float64Array([-0,1.5])',
			json: '[["Float64Array",1],["ArrayBuffer","AAAAAAAAAIAAAAAAAAD4Pw=="]]',
			validate: (value) => {
				assert.ok(Object.is(value[0], -0));
				assert.equal(value[1], 1.5);
			}
		},
		{
			name: 'BigInt64Array',
			value: new BigInt64Array([1n, -2n, 3n]),
			js: 'new BigInt64Array([1n,-2n,3n])',
			json: '[["BigInt64Array",1],["ArrayBuffer","AQAAAAAAAAD+/////////wMAAAAAAAAA"]]'
		},
		{
			name: 'BigUint64Array',
			value: new BigUint64Array([1n, 2n, 3n]),
			js: 'new BigUint64Array([1n,2n,3n])',
			json: '[["BigUint64Array",1],["ArrayBuffer","AQAAAAAAAAACAAAAAAAAAAMAAAAAAAAA"]]'
		},
		{
			name: 'ArrayBuffer',
			value: new Uint8Array([1, 2, 3]).buffer,
			js: 'new Uint8Array([1,2,3]).buffer',
			json: '[["ArrayBuffer","AQID"]]'
		},
		{
			name: 'DataView',
			value: new DataView(new Uint8Array([1, 2, 3]).buffer),
			js: 'new DataView(new Uint8Array([1,2,3]).buffer)',
			json: '[["DataView",1],["ArrayBuffer","AQID"]]'
		},
		{
			name: 'DataView subview',
			value: new DataView(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer, 2, 4),
			js: 'new DataView(new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer,2,4)',
			json: '[["DataView",1,2,4],["ArrayBuffer","AAECAwQFBgcICQ=="]]'
		},
		{
			name: 'URL',
			value: new URL('https://user:password@example.com/<script>/path?foo=bar#hash'),
			js: 'new URL("https://user:password@example.com/%3Cscript%3E/path?foo=bar#hash")',
			json: '[["URL","https://user:password@example.com/%3Cscript%3E/path?foo=bar#hash"]]'
		},
		{
			name: 'URLSearchParams',
			value: new URLSearchParams('foo=1&foo=2&baz=<+>'),
			js: 'new URLSearchParams("foo=1&foo=2&baz=%3C+%3E")',
			json: '[["URLSearchParams","foo=1&foo=2&baz=%3C+%3E"]]'
		},
		{
			name: 'Sliced typed array',
			value: new Uint16Array([10, 20, 30, 40]).subarray(1, 3),
			js: 'new Uint16Array([10,20,30,40]).subarray(1,3)',
			json: '[["Uint16Array",1,2,2],["ArrayBuffer","CgAUAB4AKAA="]]'
		},
		{
			name: 'Temporal.Duration',
			value: Temporal.Duration.from({ years: 1, months: 2, days: 3 }),
			js: 'Temporal.Duration.from("P1Y2M3D")',
			json: '[["Temporal.Duration","P1Y2M3D"]]'
		},
		{
			name: 'Temporal.Instant',
			value: Temporal.Instant.from('1999-09-29T05:30:00Z'),
			js: 'Temporal.Instant.from("1999-09-29T05:30:00Z")',
			json: '[["Temporal.Instant","1999-09-29T05:30:00Z"]]'
		},
		{
			name: 'Temporal.PlainDate',
			value: Temporal.PlainDate.from({ year: 1999, month: 9, day: 29 }),
			js: 'Temporal.PlainDate.from("1999-09-29")',
			json: '[["Temporal.PlainDate","1999-09-29"]]'
		},
		{
			name: 'Temporal.PlainTime',
			value: Temporal.PlainTime.from({ hour: 12, minute: 34, second: 56 }),
			js: 'Temporal.PlainTime.from("12:34:56")',
			json: '[["Temporal.PlainTime","12:34:56"]]'
		},
		{
			name: 'Temporal.PlainDateTime',
			value: Temporal.PlainDateTime.from({
				year: 1999,
				month: 9,
				day: 29,
				hour: 12,
				minute: 34,
				second: 56
			}),
			js: 'Temporal.PlainDateTime.from("1999-09-29T12:34:56")',
			json: '[["Temporal.PlainDateTime","1999-09-29T12:34:56"]]'
		},
		{
			name: 'Temporal.PlainMonthDay',
			value: Temporal.PlainMonthDay.from({ month: 9, day: 29 }),
			js: 'Temporal.PlainMonthDay.from("09-29")',
			json: '[["Temporal.PlainMonthDay","09-29"]]'
		},
		{
			name: 'Temporal.PlainYearMonth',
			value: Temporal.PlainYearMonth.from({ year: 1999, month: 9 }),
			js: 'Temporal.PlainYearMonth.from("1999-09")',
			json: '[["Temporal.PlainYearMonth","1999-09"]]'
		},
		{
			name: 'Temporal.ZonedDateTime',
			value: Temporal.ZonedDateTime.from({
				year: 1999,
				month: 9,
				day: 29,
				hour: 12,
				minute: 34,
				second: 56,
				timeZone: 'Europe/Rome'
			}),
			js: 'Temporal.ZonedDateTime.from("1999-09-29T12:34:56+02:00[Europe/Rome]")',
			json: '[["Temporal.ZonedDateTime","1999-09-29T12:34:56+02:00[Europe/Rome]"]]'
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
			js: '"a\\udc00b"',
			json: '["a\\udc00b"]'
		},
		{
			name: 'lone high surrogate',
			value: 'a\uD800b',
			js: '"a\\ud800b"',
			json: '["a\\ud800b"]'
		},
		{
			name: 'two low surrogates',
			value: 'a\uDC00\uDC00b',
			js: '"a\\udc00\\udc00b"',
			json: '["a\\udc00\\udc00b"]'
		},
		{
			name: 'two high surrogates',
			value: 'a\uD800\uD800b',
			js: '"a\\ud800\\ud800b"',
			json: '["a\\ud800\\ud800b"]'
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
			js: '"a\\udc00\\ud800b"',
			json: '["a\\udc00\\ud800b"]'
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

		((obj) => {
			obj.self = obj;
			return {
				name: 'Object with null prototype class',
				value: obj,
				js: '(function(a){a.foo="bar";a.self=a;return a}({}))',
				json: '[{"foo":1,"self":0},"bar"]',
				validate: (value) => {
					assert.is(value.foo, 'bar');
					assert.is(value.self, value);
				}
			};
		})(Object.assign(new NullObject(), { foo: 'bar' })),

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
			name: 'string (repetition)',
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

		{
			name: 'number: NaN (repetition)',
			value: [NaN, NaN],
			js: '[NaN,NaN]',
			json: `[[${consts.NAN},${consts.NAN}]]`
		},

		{
			name: 'Number (repetition)',
			value: ((number) => [number, number])(Object(42)),
			js: '(function(a){return [a,a]}(Object(42)))',
			json: '[[1,1],["Object",2],42]',
			validate: ([a, b]) => assert.is(a, b)
		},

		{
			name: 'BigInt (repetition)',
			value: ((bigint) => [bigint, bigint])(Object(1n)),
			js: '(function(a){return [a,a]}(Object(1n)))',
			json: '[[1,1],["Object",2],["BigInt","1"]]',
			validate: ([a, b]) => assert.is(a, b)
		},

		{
			name: 'Number: NaN (repetition)',
			value: ((nan) => [nan, nan])(Object(NaN)),
			js: '(function(a){return [a,a]}(Object(NaN)))',
			json: `[[1,1],["Object",${consts.NAN}]]`,
			validate: ([a, b]) => assert.is(a, b)
		},

		{
			name: 'Object (repetition)',
			value: ((object) => [object, object])({}),
			js: '(function(a){return [a,a]}({}))',
			json: '[[1,1],{}]',
			validate: ([a, b]) => assert.is(a, b)
		},

		{
			name: 'empty Map (repetition)',
			value: ((map) => [map, map])(new Map()),
			js: '(function(a){return [a,a]}(new Map))',
			json: '[[1,1],["Map"]]',
			validate: ([a, b]) => {
				assert.is(a, b);
				assert.is(a.size, 0);
			}
		},

		{
			name: 'empty Set (repetition)',
			value: ((set) => [set, set])(new Set()),
			js: '(function(a){return [a,a]}(new Set))',
			json: '[[1,1],["Set"]]',
			validate: ([a, b]) => {
				assert.is(a, b);
				assert.is(a.size, 0);
			}
		},

		{
			name: 'RegExp (repetition)',
			value: ((regexp) => [regexp, regexp])(/regexp/),
			js: '(function(a){return [a,a]}(new RegExp("regexp")))',
			json: '[[1,1],["RegExp","regexp"]]',
			validate: ([a, b]) => assert.is(a, b)
		},

		{
			name: 'Date (repetition)',
			value: ((date) => [date, date])(new Date(1e12)),
			js: '(function(a){return [a,a]}(new Date(1000000000000)))',
			json: '[[1,1],["Date","2001-09-09T01:46:40.000Z"]]',
			validate: ([a, b]) => assert.is(a, b)
		},

		{
			name: 'Array buffer (repetition)',
			value: (() => {
				const uint8 = new Uint8Array(10);
				const uint16 = new Uint16Array(uint8.buffer);

				for (let i = 0; i < uint8.length; i += 1) {
					uint8[i] = i;
				}

				return [uint8, uint16];
			})(),
			js: '(function(a){return [new Uint8Array(a),new Uint16Array(a)]}(new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer))',
			json: '[[1,3],["Uint8Array",2],["ArrayBuffer","AAECAwQFBgcICQ=="],["Uint16Array",2]]',
			validate: ([uint8, uint16]) => assert.is(uint8.buffer, uint16.buffer)
		},

		{
			name: 'TypedArray (repetition)',
			value: (() => {
				const uint8 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
				return [uint8, uint8];
			})(),
			js: '(function(a){a=new Uint8Array([0,1,2,3,4,5,6,7,8,9]);return [a,a]}({}))',
			json: '[[1,1],["Uint8Array",2],["ArrayBuffer","AAECAwQFBgcICQ=="]]'
		},

		{
			name: 'Array Buffer and TypedArray (repetition)',
			value: (() => {
				const uint8 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
				const uint16 = new Uint16Array(uint8.buffer);
				return [uint8, uint8, uint16];
			})(),
			js: '(function(a,b){a=new Uint8Array(b);return [a,a,new Uint16Array(b)]}({},new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer))',
			json: '[[1,1,3],["Uint8Array",2],["ArrayBuffer","AAECAwQFBgcICQ=="],["Uint16Array",2]]'
		},

		{
			name: 'DataView (repetition)',
			value: (() => {
				const uint8 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
				const dv = new DataView(uint8.buffer);
				return [dv, dv];
			})(),
			js: '(function(a){a=new DataView(new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer);return [a,a]}({}))',
			json: '[[1,1],["DataView",2],["ArrayBuffer","AAECAwQFBgcICQ=="]]'
		},

		{
			name: 'Array Buffer and DataView (repetition)',
			value: (() => {
				const uint8 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
				const dv = new DataView(uint8.buffer);
				return [dv, dv, uint8.buffer];
			})(),
			js: '(function(a,b){a=new DataView(b);return [a,a,b]}({},new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer))',
			json: '[[1,1,2],["DataView",2],["ArrayBuffer","AAECAwQFBgcICQ=="]]'
		},

		{
			name: 'DataView subview (repetition)',
			value: (() => {
				const uint8 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
				const dv = new DataView(uint8.buffer, 2, 4);
				return [dv, dv];
			})(),
			js: '(function(a){a=new DataView(new Uint8Array([0,1,2,3,4,5,6,7,8,9]).buffer,2,4);return [a,a]}({}))',
			json: '[[1,1],["DataView",2,2,4],["ArrayBuffer","AAECAwQFBgcICQ=="]]'
		},

		{
			name: 'BigInt64Array (repetition)',
			value: ((array) => [array, array])(new BigInt64Array([1n, 2n, 3n])),
			js: '(function(a){a=new BigInt64Array([1n,2n,3n]);return [a,a]}({}))',
			json: '[[1,1],["BigInt64Array",2],["ArrayBuffer","AQAAAAAAAAACAAAAAAAAAAMAAAAAAAAA"]]',
			validate: ([a, b]) => assert.is(a, b)
		},

		{
			name: 'Temporal.Instant (repetition)',
			value: ((instant) => [instant, instant])(
				Temporal.Instant.from('1999-09-29T05:30:00Z')
			),
			js: '(function(a){return [a,a]}(Temporal.Instant.from("1999-09-29T05:30:00Z")))',
			json: '[[1,1],["Temporal.Instant","1999-09-29T05:30:00Z"]]',
			validate: ([a, b]) => {
				assert.is(a, b);
				assert.ok(a instanceof Temporal.Instant);
			}
		},

		{
			name: 'Map key (repetition)',
			value: (() => {
				const shared = { id: 1 };
				return [shared, new Map([[shared, 'v']])];
			})(),
			js: '(function(a){a.id=1;return [a,new Map([[a,"v"]])]}({}))',
			json: '[[1,3],{"id":2},1,["Map",1,4],"v"]',
			validate: ([obj, map]) => assert.is([...map.keys()][0], obj)
		},

		{
			name: 'Map keys (interlinked)',
			value: (() => {
				const node1 = { id: 1 };
				const node2 = { id: 2 };
				const node3 = { id: 3 };
				return new Map([
					[
						node1,
						new Map([
							[node2, 1],
							[node3, 1]
						])
					],
					[
						node2,
						new Map([
							[node1, 1],
							[node3, 1]
						])
					],
					[
						node3,
						new Map([
							[node1, 1],
							[node2, 1]
						])
					]
				]);
			})(),
			js: '(function(a,b,c){a.id=1;b.id=2;c.id=3;return new Map([[a,new Map([[b,1],[c,1]])],[b,new Map([[a,1],[c,1]])],[c,new Map([[a,1],[b,1]])]])}({},{},{}))',
			json: '[["Map",1,3,4,8,6,9],{"id":2},1,["Map",4,2,6,2],{"id":5},2,{"id":7},3,["Map",1,2,6,2],["Map",1,2,4,2]]',
			validate: (map) => {
				const [node1, node2, node3] = map.keys();
				const from1 = [...map.get(node1).keys()];
				const from2 = [...map.get(node2).keys()];
				const from3 = [...map.get(node3).keys()];

				// each node appears as a key in the two sibling sub-maps;
				// the same object identity must be preserved everywhere
				assert.is(from2[0], node1);
				assert.is(from3[0], node1);
				assert.is(from1[0], node2);
				assert.is(from3[1], node2);
				assert.is(from1[1], node3);
				assert.is(from2[1], node3);
			}
		}
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
			js: `new RegExp("[\\u003C/script>\\u003Cscript>alert('xss')//]")`,
			json: `[["RegExp","[\\u003C/script>\\u003Cscript>alert('xss')//]"]]`
		},
		{
			name: 'Dangerous regex',
			value: (() => {
				const regex = /[</script><script>alert('xss')//]/;
				return [regex, regex];
			})(),
			js: `(function(a){return [a,a]}(new RegExp("[\\u003C/script>\\u003Cscript>alert('xss')//]")))`,
			json: `[[1,1],["RegExp","[\\u003C/script>\\u003Cscript>alert('xss')//]"]]`
		}
	],

	misc: [
		{
			name: 'Object without prototype',
			value: Object.create(null),
			js: '{__proto__:null}',
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
			js: '(function(a){return [a,a]}((new Foo({bar:(new Bar({answer:42}))}))))',
			json: '[[1,1],["Foo",2],{"bar":3},["Bar",4],{"answer":5},42]',
			replacer: (value, js) => {
				if (value instanceof Foo) {
					return js`new Foo(${value.value})`;
				}

				if (value instanceof Bar) {
					return js`new Bar(${value.value})`;
				}
			},
			// test for https://github.com/Rich-Harris/devalue/pull/80
			reducers: Object.assign(Object.create({ polluted: true }), {
				Foo: (x) => x instanceof Foo && x.value,
				Bar: (x) => x instanceof Bar && x.value
			}),
			revivers: {
				Foo: (x) => new Foo(x),
				Bar: (x) => new Bar(x)
			},
			validate: ([obj1, obj2]) => {
				assert.is(obj1, obj2);
				assert.ok(obj1 instanceof Foo);
				assert.ok(obj1.value.bar instanceof Bar);
				assert.equal(obj1.value.bar.value.answer, 42);
			}
		}
	])(new Foo({ bar: new Bar({ answer: 42 }) })),

	custom_fallback: ((date) => [
		{
			name: 'Custom fallback',
			value: date,
			js: "(new Date(''))",
			json: '[["Date",""]]',
			replacer: (value, js) => value instanceof Date && js`new Date('')`,
			reducers: {
				Date: (value) => value instanceof Date && ''
			},
			revivers: {
				Date: (value) => new Date(value)
			},
			validate: (obj) => {
				assert.ok(obj instanceof Date);
				assert.ok(isNaN(obj.getDate()));
			}
		}
	])(new Date('invalid')),

	functions: (() => {
		// Simple function wrapper class for testing
		class FunctionRef {
			constructor(fn) {
				this.fn = fn;
			}
		}

		const testFn = (x) => x * 2;

		return [
			{
				name: 'Function wrapped in custom type',
				value: new FunctionRef(testFn),
				js: '(new FunctionRef((x) => x * 2))',
				json: '[["FunctionRef",1],"(x) => x * 2"]',
				replacer: (value, js) => {
					if (value instanceof FunctionRef) {
						return js`new FunctionRef((x) => x * 2)`;
					}
				},
				reducers: {
					FunctionRef: (value) => {
						if (value instanceof FunctionRef) {
							// Serialize the function code as a string
							return value.fn.toString();
						}
					}
				},
				revivers: {
					FunctionRef: (code) => {
						// Reconstruct the function from its string representation
						const fn = new Function('return ' + code)();
						return new FunctionRef(fn);
					}
				},
				validate: (result) => {
					assert.ok(result instanceof FunctionRef);
					assert.ok(typeof result.fn === 'function');
					// Test that the function works
					assert.equal(result.fn(5), 10);
				}
			},
			{
				name: 'Function in nested structure',
				value: { fn: testFn, nested: { data: 42 } },
				js: '{fn:((x) => x * 2),nested:{data:42}}',
				json: '[{"fn":1,"nested":3},["FunctionRef",2],"(x) => x * 2",{"data":4},42]',
				replacer: (value, js) => {
					if (typeof value === 'function') {
						return js`(x) => x * 2`;
					}
				},
				reducers: {
					FunctionRef: (value) => {
						if (typeof value === 'function') {
							return value.toString();
						}
					}
				},
				revivers: {
					FunctionRef: (code) => {
						return new Function('return ' + code)();
					}
				},
				validate: (result) => {
					assert.ok(typeof result.fn === 'function');
					assert.equal(result.nested.data, 42);
					assert.equal(result.fn(3), 6);
				}
			}
		];
	})()
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

const custom_source_test = uvu.suite('uneval: custom source');
custom_source_test('preserves identities referenced by custom source', () => {
	class Wrapper {
		constructor(inner) {
			this.inner = inner;
		}
	}
	const shared = { hello: 'world' };
	const source = uneval({ wrapped: new Wrapper(shared), shared }, (value, js) =>
		value instanceof Wrapper ? js`new Wrapper(${value.inner})` : undefined
	);
	const result = eval(source);
	assert.is(result.wrapped.inner, result.shared);
});
custom_source_test('constructs a repeated wrapper after its shared child is populated', () => {
	class Wrapper {
		static calls = 0;

		constructor(inner) {
			Wrapper.calls += 1;
			this.inner = inner;
			this.answer = inner.answer;
		}
	}

	const child = { answer: 42 };
	const wrapper = new Wrapper(child);
	Wrapper.calls = 0;
	let replacer_calls = 0;
	const source = uneval([wrapper, wrapper, child], (value, js) => {
		if (value instanceof Wrapper) {
			replacer_calls += 1;
			return js`new Wrapper(${value.inner})`;
		}
	});
	const result = vm.runInNewContext(source, { Wrapper });

	assert.ok(source.startsWith('(function(b){var a;'));
	assert.ok(source.endsWith('}({}))'));
	assert.is(replacer_calls, 1);
	assert.is(Wrapper.calls, 1);
	assert.is(result[0], result[1]);
	assert.is(result[0].inner, result[2]);
	assert.is(result[0].answer, 42);
});
custom_source_test('orders nested custom dependencies', () => {
	class Inner {
		static calls = 0;

		constructor(value) {
			Inner.calls += 1;
			this.value = value;
		}
	}
	class Outer {
		static calls = 0;

		constructor(inner) {
			Outer.calls += 1;
			this.inner = inner;
			this.answer = inner.value.answer;
		}
	}

	const child = { answer: 42 };
	const inner = new Inner(child);
	const outer = new Outer(inner);
	Inner.calls = 0;
	Outer.calls = 0;
	const replacer_calls = new Map();
	const source = uneval([outer, outer, inner, inner, child], (value, js) => {
		if (value instanceof Outer) {
			replacer_calls.set(value, (replacer_calls.get(value) ?? 0) + 1);
			return js`new Outer(${value.inner})`;
		}
		if (value instanceof Inner) {
			replacer_calls.set(value, (replacer_calls.get(value) ?? 0) + 1);
			return js`new Inner(${value.value})`;
		}
	});
	const result = vm.runInNewContext(source, { Inner, Outer });

	assert.is(replacer_calls.get(inner), 1);
	assert.is(replacer_calls.get(outer), 1);
	assert.is(Inner.calls, 1);
	assert.is(Outer.calls, 1);
	assert.is(result[0], result[1]);
	assert.is(result[0].inner, result[2]);
	assert.is(result[2], result[3]);
	assert.is(result[2].value, result[4]);
	assert.is(result[0].answer, 42);
});
custom_source_test('finds custom dependencies inside inline containers', () => {
	class Inner {
		static calls = 0;

		constructor(value) {
			Inner.calls += 1;
			this.value = value;
		}
	}
	class Outer {
		static calls = 0;

		constructor(options) {
			Outer.calls += 1;
			this.inner = options.inner;
			this.answer = options.inner.value.answer;
		}
	}

	const inner = new Inner({ answer: 42 });
	const outer = new Outer({ inner });
	Inner.calls = 0;
	Outer.calls = 0;
	const source = uneval([outer, outer, inner], (value, js) => {
		if (value instanceof Outer) return js`new Outer(${{ inner: value.inner }})`;
		if (value instanceof Inner) return js`new Inner(${value.value})`;
	});
	const result = vm.runInNewContext(source, { Inner, Outer });

	assert.is(Inner.calls, 1);
	assert.is(Outer.calls, 1);
	assert.is(result[0], result[1]);
	assert.is(result[0].inner, result[2]);
	assert.is(result[0].answer, 42);
});
custom_source_test('preserves a child used by multiple source holes', () => {
	class Pair {
		constructor(left, right) {
			this.left = left;
			this.right = right;
		}
	}

	const child = { answer: 42 };
	const source = uneval(new Pair(child, child), (value, js) =>
		value instanceof Pair ? js`new Pair(${value.left},${value.right})` : undefined
	);
	const result = vm.runInNewContext(source, { Pair });

	assert.is(result.left, result.right);
	assert.is(result.left.answer, 42);
});
custom_source_test('keeps dependency-free custom constructions in IIFE arguments', () => {
	class Wrapper {}

	const wrapper = new Wrapper();
	const source = uneval([wrapper, wrapper], (value, js) =>
		value instanceof Wrapper ? js`new Wrapper()` : undefined
	);

	assert.is(source, '(function(a){return [a,a]}((new Wrapper())))');
	const result = vm.runInNewContext(source, { Wrapper });
	assert.is(result[0], result[1]);
});
custom_source_test('orders a shared typed view after its backing buffer', () => {
	class Wrapper {
		static calls = 0;

		constructor(view, buffer) {
			Wrapper.calls += 1;
			this.view = view;
			this.buffer = buffer;
			this.first = view[0];
		}
	}

	const view = new Uint8Array([1, 2, 3]);
	const wrapper = new Wrapper(view, view.buffer);
	Wrapper.calls = 0;
	let replacer_calls = 0;
	const source = uneval([wrapper, wrapper, view, view.buffer], (value, js) => {
		if (value instanceof Wrapper) {
			replacer_calls += 1;
			return js`new Wrapper(${value.view},${value.buffer})`;
		}
	});
	const result = vm.runInNewContext(source, { Wrapper });

	assert.is(replacer_calls, 1);
	assert.is(Wrapper.calls, 1);
	assert.is(result[0], result[1]);
	assert.is(result[0].view, result[2]);
	assert.is(result[2].buffer, result[3]);
	assert.is(result[0].buffer, result[3]);
	assert.is(result[0].first, 1);
});
custom_source_test('reconstructs custom cycles through mutable containers', () => {
	class Wrapper {
		static calls = 0;

		constructor(inner) {
			Wrapper.calls += 1;
			this.inner = inner;
		}
	}

	const container = {};
	const wrapper = new Wrapper(container);
	container.wrapper = wrapper;
	Wrapper.calls = 0;
	let replacer_calls = 0;
	const source = uneval(wrapper, (value, js) => {
		if (value instanceof Wrapper) {
			replacer_calls += 1;
			return js`new Wrapper(${value.inner})`;
		}
	});
	const result = vm.runInNewContext(source, { Wrapper });

	assert.is(replacer_calls, 1);
	assert.is(Wrapper.calls, 1);
	assert.is(result.inner.wrapper, result);
});
custom_source_test('preserves property order around cyclic references', () => {
	class Marker {}

	for (const prototype of [Object.prototype, null]) {
		for (const position of ['first', 'middle', 'last']) {
			const value = Object.create(prototype);
			const completed = { done: true };
			if (position !== 'first') value.before = completed;
			value.self = value;
			if (position !== 'last') value.after = 42;

			const source = uneval([value, new Marker()], (item, js) =>
				item instanceof Marker ? js`new Marker()` : undefined
			);
			const [result] = vm.runInNewContext(source, { Marker });
			const expected = [
				...(position === 'first' ? [] : ['before']),
				'self',
				...(position === 'last' ? [] : ['after'])
			];

			assert.equal(Object.keys(result), expected);
			assert.is(result.self, result);
			if (position !== 'first') assert.is(result.before.done, true);
		}
	}
});
custom_source_test('preserves Map and Set order around cyclic references', () => {
	class Marker {}

	for (const position of ['first', 'middle', 'last']) {
		const completed = { done: true };
		const map = new Map();
		if (position !== 'first') map.set('before', completed);
		map.set('self', map);
		if (position !== 'last') map.set('after', 42);

		const set = new Set();
		if (position !== 'first') set.add(completed);
		set.add(set);
		if (position !== 'last') set.add(42);

		const source = uneval([map, set, new Marker()], (item, js) =>
			item instanceof Marker ? js`new Marker()` : undefined
		);
		const [result_map, result_set] = vm.runInNewContext(source, { Marker });
		const map_entries = Array.from(result_map);
		const set_values = Array.from(result_set);

		assert.equal(
			map_entries.map(([key]) => key),
			[...(position === 'first' ? [] : ['before']), 'self', ...(position === 'last' ? [] : ['after'])]
		);
		assert.is(map_entries[position === 'first' ? 0 : 1][1], result_map);
		assert.is(set_values[position === 'first' ? 0 : 1], result_set);
		if (position !== 'first') {
			assert.is(map_entries[0][1].done, true);
			assert.is(set_values[0].done, true);
		}
		if (position !== 'last') {
			assert.is(map_entries.at(-1)[1], 42);
			assert.is(set_values.at(-1), 42);
		}
	}
});
custom_source_test('preserves order in mutual and custom cycles', () => {
	class Wrapper {
		constructor(inner) {
			this.inner = inner;
			this.before = inner.before.done;
		}
	}

	const left = {};
	const right = {};
	left.peer = right;
	left.tail = 'left';
	right.peer = left;
	right.tail = 'right';

	const container = {};
	container.before = { done: true };
	const wrapper = new Wrapper(container);
	container.wrapper = wrapper;
	container.tail = 42;

	const source = uneval([left, right, wrapper], (item, js) =>
		item instanceof Wrapper ? js`new Wrapper(${item.inner})` : undefined
	);
	const [result_left, result_right, result_wrapper] = vm.runInNewContext(source, { Wrapper });

	assert.equal(Object.keys(result_left), ['peer', 'tail']);
	assert.equal(Object.keys(result_right), ['peer', 'tail']);
	assert.is(result_left.peer, result_right);
	assert.is(result_right.peer, result_left);
	assert.equal(Object.keys(result_wrapper.inner), ['before', 'wrapper', 'tail']);
	assert.is(result_wrapper.inner.wrapper, result_wrapper);
	assert.is(result_wrapper.before, true);
	assert.is(result_wrapper.inner.tail, 42);
});
custom_source_test('rejects cycles made entirely of custom constructions', () => {
	class Atomic {
		constructor() {
			this.other = undefined;
		}
	}

	const a = new Atomic();
	const b = new Atomic();
	a.other = b;
	b.other = a;
	const self = new Atomic();
	self.other = self;
	for (const value of [a, self]) {
		assert.throws(
			() =>
				uneval(value, (item, js) =>
					item instanceof Atomic
						? js`Object.assign(new Atomic(),{other:${item.other}})`
						: undefined
				),
			(error) =>
				error.name === 'DevalueError' &&
				error.message === 'Cannot stringify a circular chain of atomic values'
		);
	}
});
custom_source_test('accepts only documented fallback values', () => {
	for (const fallback of [undefined, null, false]) {
		assert.is(uneval({ answer: 42 }, () => fallback), '{answer:42}');
	}

	for (const invalid of ['', 0, 1, true, Promise.resolve(), {}]) {
		assert.throws(
			() => uneval({ answer: 42 }, () => invalid),
			(error) => error instanceof TypeError && error.message === 'Invalid uneval replacer result'
		);
	}
});
custom_source_test('treats replacer results as expressions', () => {
	class Replacement {
		constructor(source) {
			this.source = source;
		}
	}

	const comma = new Replacement('comma');
	const conditional = new Replacement('conditional');
	const object = new Replacement('object');
	const nested = new Replacement('nested');
	const escaped = new Replacement('escaped');
	const source = uneval([comma, conditional, object, nested, escaped], (value, js) => {
		if (!(value instanceof Replacement)) return;
		switch (value.source) {
			case 'comma':
				return js`1,2`;
			case 'conditional':
				return js`false?1:2`;
			case 'object':
				return js`{answer:42}`;
			case 'nested':
				return js`${js`Math.max(`}${1},${2}${js`)`}`;
			case 'escaped':
				return js`${'</script>'}`;
		}
	});
	const result = vm.runInNewContext(source);

	assert.is(result.length, 5);
	assert.is(result[0], 2);
	assert.is(result[1], 2);
	assert.is(result[2].answer, 42);
	assert.is(result[3], 2);
	assert.is(result[4], '</script>');
	assert.ok(!source.includes('</script>'));
});
custom_source_test('groups a root object-literal replacement', () => {
	class Replacement {}

	const source = uneval(new Replacement(), (value, js) =>
		value instanceof Replacement ? js`{answer:42}` : undefined
	);
	assert.is(source, '({answer:42})');
	assert.is(vm.runInNewContext(source).answer, 42);
});
custom_source_test('requires js to be used as a tagged template', () => {
	for (const invoke of [
		(js) => js('new Date()'),
		(js) => js(['new Date()'])
	]) {
		assert.throws(
			() => uneval(new Date(), (value, js) => value instanceof Date ? invoke(js) : undefined),
			'`js` must be used as a tagged template, but was called as a regular function'
		);
	}
});
custom_source_test.run();

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
		name: 'typed array with non-ArrayBuffer input',
		json: '[["Int8Array", 1], { "length": 2 }, 1000000000]',
		message: 'Invalid data'
	},
	{
		name: 'ArrayBuffer with non-string value',
		json: '[["ArrayBuffer", { "length": 100 }]]',
		message: 'Invalid ArrayBuffer encoding'
	},
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
		json: `${consts.HOLE}`,
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
	},
	{
		name: 'prototype pollution',
		json: '[{"__proto__":1},{}]',
		message: 'Cannot parse an object with a `__proto__` property'
	},
	{
		name: 'sparse array prototype pollution',
		json: `[[${consts.SPARSE},1,"__proto__",{}]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array non-integer index',
		json: `[[${consts.SPARSE},5,"foo",1]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array negative index',
		json: `[[${consts.SPARSE},5,-1,1]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array out-of-bounds index',
		json: `[[${consts.SPARSE},2,5,1]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array non-integer length',
		json: `[[${consts.SPARSE},"abc"]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array negative length',
		json: `[[${consts.SPARSE},-3]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array float length',
		json: `[[${consts.SPARSE},1.5]]`,
		message: 'Invalid input'
	},
	{
		name: 'sparse array float index',
		json: `[[${consts.SPARSE},5,1.5,1]]`,
		message: 'Invalid input'
	},
	{
		name: 'prototype pollution via null-prototype object',
		json: '[["null","__proto__",1],{}]',
		message: 'Cannot parse an object with a `__proto__` property'
	},
	{
		name: 'nested prototype pollution via null-prototype object',
		json: '[{"data":1},["null","__proto__",2],{"polluted":3},true]',
		message: 'Cannot parse an object with a `__proto__` property'
	},
	{
		name: 'prototype pollution via Object wrapper',
		json: '[["Object",{"__proto__":1}],{}]',
		message: 'Invalid input'
	},
	{
		name: 'nested prototype pollution via Object wrapper',
		json: '[{"wrapped":1},["Object",{"__proto__":2}],{}]',
		message: 'Invalid input'
	},
	{
		name: 'bad index',
		json: '[{"0":1,"toString":"push"},"hello"]',
		message: 'Invalid input'
	},
	{
		name: 'TypedArray self-reference',
		json: '[["Uint8Array", 0]]',
		message: 'Invalid data'
	},
	{
		name: 'custom reviver self-reference',
		json: '[["Custom", 0]]',
		revivers: { Custom: (v) => v },
		message: 'Invalid circular reference'
	},
	{
		name: 'mutual TypedArray reference',
		json: '[["Uint8Array", 1], ["Uint8Array", 0]]',
		message: 'Invalid data'
	}
];

for (const { name, json, message, revivers } of invalid) {
	uvu.test(`parse error: ${name}`, () => {
		assert.throws(
			() => parse(json, revivers),
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

	uvu.test(`${fn.name} throws for Symbols`, () => {
		assert.throws(() => fn(Symbol('foo')));
	});

	uvu.test(`${fn.name} throws for boxed Symbols`, () => {
		assert.throws(() => fn(Object(Symbol('foo'))));
	});

	uvu.test(`${fn.name} throws for symbolic keys`, () => {
		assert.throws(() => fn({ [Symbol()]: null }));
	});

	uvu.test(`${fn.name} throws for __proto__ keys`, () => {
		const inner = JSON.parse('{"__proto__":1}');
		const root = { foo: inner };
		try {
			fn(root);
			assert.unreachable('should have thrown');
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify objects with __proto__ keys');
			assert.equal(e.path, '.foo');
			assert.equal(e.value, inner);
			assert.equal(e.root, root);
		}
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

	uvu.test(`${fn.name} populates error.value with the problematic value`, () => {
		const testFn = function invalid() {};
		try {
			fn({
				foo: {
					array: [testFn]
				}
			});
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify a function');
			assert.equal(e.value, testFn);
		}
	});

	uvu.test(`${fn.name} populates error.root with the root value`, () => {
		const root = {
			foo: {
				array: [function invalid() {}]
			}
		};
		try {
			fn(root);
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify a function');
			assert.equal(e.root, root);
		}
	});

	uvu.test(`${fn.name} includes value and root on arbitrary non-POJOs error`, () => {
		class Whatever {}
		const problematicValue = new Whatever();
		const root = {
			foo: {
				['string-key']: new Map([['key', problematicValue]])
			}
		};
		try {
			fn(root);
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify arbitrary non-POJOs');
			assert.equal(e.value, problematicValue);
			assert.equal(e.root, root);
		}
	});

	uvu.test(`${fn.name} includes value and root on symbolic keys error`, () => {
		const symbolKey = Symbol('key');
		const root = { [symbolKey]: 'value' };
		try {
			fn(root);
		} catch (e) {
			assert.equal(e.name, 'DevalueError');
			assert.equal(e.message, 'Cannot stringify POJOs with symbolic keys');
			assert.equal(e.value, root);
			assert.equal(e.root, root);
		}
	});
}

uvu.test('handles very sparse arrays efficiently', () => {
	const arr = [];
	arr[1_000_000] = 'x';

	// This should complete nearly instantly, not iterate 1M times
	const start = performance.now();
	const json = stringify(arr);
	const elapsed = performance.now() - start;

	assert.ok(elapsed < 100, `stringify took ${elapsed}ms, expected < 100ms`);

	// Verify round-trip
	const result = parse(json);
	assert.is(result.length, 1_000_001);
	assert.is(result[1_000_000], 'x');
	assert.ok(!(0 in result));

	// Verify uneval too
	const start2 = performance.now();
	const js = uneval(arr);
	const elapsed2 = performance.now() - start2;
	assert.ok(elapsed2 < 100, `uneval took ${elapsed2}ms, expected < 100ms`);
});

uvu.test('ignores non-numeric array properties in dense encoding', () => {
	// Dense path (few holes — array literal / HOLE encoding wins)
	const arr = [, 'a', , 'b'];
	arr.foo = 'should be ignored';
	arr.bar = 42;

	// uneval — should produce the holey literal, no mention of "foo" or "bar"
	const js = uneval(arr);
	assert.ok(!js.includes('foo'), `uneval output should not contain "foo": ${js}`);
	assert.ok(!js.includes('bar'), `uneval output should not contain "bar": ${js}`);
	assert.ok(
		!js.includes('should be ignored'),
		`uneval output should not contain non-numeric value: ${js}`
	);
	const evaled = (0, eval)(js);
	assert.is(evaled.length, 4);
	assert.is(evaled[1], 'a');
	assert.is(evaled[3], 'b');
	assert.ok(!(0 in evaled));

	// stringify — should produce HOLE encoding, no mention of "foo" or "bar"
	const json = stringify(arr);
	assert.ok(!json.includes('foo'), `stringify output should not contain "foo": ${json}`);
	assert.ok(!json.includes('bar'), `stringify output should not contain "bar": ${json}`);
	const parsed = parse(json);
	assert.is(parsed.length, 4);
	assert.is(parsed[1], 'a');
	assert.is(parsed[3], 'b');
	assert.ok(!(0 in parsed));
});

uvu.test('uneval round-trips sparse arrays whose first hole is not at index 0', () => {
	for (const arr of [[1, , 3], [1, ,], [1, , , 4], [1, 2, , 4]]) {
		const evaled = (0, eval)(uneval(arr));
		assert.is(evaled.length, arr.length, `length for keys ${Object.keys(arr).join(',')}`);
		assert.equal(Object.keys(evaled), Object.keys(arr));
		for (const k of Object.keys(arr)) {
			assert.is(evaled[k], arr[k]);
		}
	}
});

uvu.test('ignores non-numeric array properties in sparse encoding', () => {
	// Sparse path (very sparse — Object.assign / SPARSE encoding wins)
	const arr = [];
	arr[1_000_000] = 'x';
	arr.foo = 'should be ignored';
	arr.bar = 42;

	// uneval — should produce Object.assign form, no mention of "foo" or "bar"
	const js = uneval(arr);
	assert.ok(!js.includes('foo'), `uneval output should not contain "foo": ${js}`);
	assert.ok(!js.includes('bar'), `uneval output should not contain "bar": ${js}`);
	assert.ok(
		!js.includes('should be ignored'),
		`uneval output should not contain non-numeric value: ${js}`
	);
	assert.ok(js.includes('Object.assign'), `uneval should use Object.assign for very sparse arrays`);
	const evaled = (0, eval)(js);
	assert.is(evaled.length, 1_000_001);
	assert.is(evaled[1_000_000], 'x');
	assert.ok(!(0 in evaled));
	assert.ok(!('foo' in evaled));

	// stringify — should produce SPARSE encoding, no mention of "foo" or "bar"
	const json = stringify(arr);
	assert.ok(!json.includes('foo'), `stringify output should not contain "foo": ${json}`);
	assert.ok(!json.includes('bar'), `stringify output should not contain "bar": ${json}`);
	const parsed = parse(json);
	assert.is(parsed.length, 1_000_001);
	assert.is(parsed[1_000_000], 'x');
	assert.ok(!(0 in parsed));
});

uvu.test('does not create duplicate parameter names', () => {
	const foo = new Array(20000).fill(0).map((_, i) => i);
	const bar = foo.map((_, i) => ({ [i]: foo[i] }));
	const serialized = uneval([foo, ...bar]);

	eval(serialized);
});

uvu.test('reconstructs a referenced typed array before it is used in a cycle', () => {
	const view = new Uint8Array([1, 2, 3]);
	const obj = { a: view, b: view };
	obj.self = obj;

	const result = (0, eval)(uneval(obj));

	assert.is(result.self, result);
	assert.ok(result.a instanceof Uint8Array);
	assert.is(result.a, result.b);
	assert.equal(Array.from(result.a), [1, 2, 3]);
});

uvu.test('rejects sparse array __proto__ pollution via parse', () => {
	// Attempt to set __proto__ on an array via the sparse array encoding
	const payload = JSON.stringify([[consts.SPARSE, 1, '__proto__', { polluted: true }]]);
	assert.throws(
		() => parse(payload),
		(error) => error.message === 'Invalid input'
	);
});

uvu.test('rejects sparse array __proto__ pollution via unflatten', () => {
	// Same attack via unflatten (which receives already-parsed data)
	const payload = [[consts.SPARSE, 1, '__proto__', { polluted: true }]];
	assert.throws(
		() => unflatten(payload),
		(error) => error.message === 'Invalid input'
	);
});

uvu.test('sparse array CPU exhaustion payload is rejected', () => {
	// Reproduction from reported vulnerability: builds deep __proto__ chains
	// via sparse array encoding, causing expensive [[SetPrototypeOf]] calls.
	const LAYERS = 49_000;
	const data = [[consts.SPARSE, 0], 0, []];
	for (let i = 3; i < 3 + LAYERS; i++) {
		data.push([consts.SPARSE, 0, '__proto__', i - 1]);
		data[0].push('__proto__', i);
	}
	const payload = JSON.stringify(data);

	assert.throws(
		() => parse(payload),
		(error) => error.message === 'Invalid input'
	);
});

uvu.test('sparse array type confusion via __proto__ is blocked', () => {
	// Reproduction from reported vulnerability: uses sparse array encoding to
	// set __proto__ on an array, overwriting the prototype and allowing an
	// attacker to control property values (e.g. spoofing .magnitude on a Vector).
	const payload = `[[${consts.SPARSE},0,"x",1,"y",2,"magnitude",3,"__proto__",4],3,4,"nope",["Vector",5],[6,7],8,9]`;

	class Vector {
		constructor(x, y) {
			this.x = x;
			this.y = y;
		}
		get magnitude() {
			return (this.x ** 2 + this.y ** 2) ** 0.5;
		}
	}

	assert.throws(
		() => parse(payload, { Vector: ([x, y]) => new Vector(x, y) }),
		(error) => error.message === 'Invalid input'
	);
});

uvu.test('valid sparse array parses correctly', () => {
	// Ensure the fix does not break legitimate sparse array round-tripping.
	// devalue format: [root_entry, ...other_entries]
	// [-7, 3, 0, 1, 2, 2] = sparse array of length 3, index 0 = entries[1], index 2 = entries[2]
	const goodPayload = JSON.stringify([[consts.SPARSE, 3, 0, 1, 2, 2], 'a', 'c']);
	const result = parse(goodPayload);
	assert.instance(result, Array);
	assert.is(result.length, 3);
	assert.is(result[0], 'a');
	assert.ok(!(1 in result));
	assert.is(result[2], 'c');
	assert.is(Object.getPrototypeOf(result), Array.prototype);
});

uvu.test('errors on out-of-bounds indices', () => {
	assert.throws(
		() => parse('[["Set",7]]'),
		(error) => error.message === 'Invalid input'
	)
});

// Regression test for a DoS vulnerability in sparse array parsing.
// The SPARSE encoding is `[-7, length, idx, val, ...]`. Previously, `parse`
// handled this by calling `new Array(length)`, which V8 eagerly allocates
// a backing store for. A malicious payload containing many such arrays
// — each claiming a huge length but carrying no actual data — could force
// the parser to allocate arbitrarily large amounts of memory and crash
// the host process.
//
// Each case below crafts a payload whose combined implied allocation is
// ~20GB. With a correct fix (lazy allocation / deferred length), every
// case finishes near-instantly. Without it, the test process dies.

/**
 * Builds a payload shaped like:
 *   [ {k0:1, k1:2, ..., k(count-1):count},   // root object, references each sparse array
 *     [-7, perArrayLen, 0, count+1],         // sparse array #0: length = perArrayLen, index 0 -> values[count+1]
 *     [-7, perArrayLen, 0, count+1],         // sparse array #1
 *     ...
 *     42 ]                                   // values[count+1], placed at index 0 of each sparse array
 *
 * Hydrating the root object forces every sparse array to be hydrated,
 * which (without the fix) triggers `new Array(perArrayLen)` `count` times.
 *
 * @param {number} count
 * @param {number} perArrayLen
 */
function buildSparseDoSPayload(count, perArrayLen) {
	let payload = '[{';

	for (let i = 0; i < count; i += 1) {
		if (i > 0) payload += ',';
		payload += `"k${i}":${i + 1}`;
	}

	payload += '}';

	for (let i = 0; i < count; i += 1) {
		payload += `,[${consts.SPARSE},${perArrayLen},0,${count + 1}]`;
	}

	payload += ',42]';
	return payload;
}

// Matrix of (perArrayLen, count) pairs — each row allocates ~2.5e9 slots
// (~20GB assuming 8-byte pointers) if the parser eagerly materializes
// sparse arrays.
const sparseDoSCases = [
	{ perArrayLen: 10_000, count: 250_000 },
	{ perArrayLen: 100_000, count: 25_000 },
	{ perArrayLen: 1_000_000, count: 2_500 },
	{ perArrayLen: 10_000_000, count: 250 },
	{ perArrayLen: 100_000_000, count: 25 }
];

for (const { perArrayLen, count } of sparseDoSCases) {
	uvu.test(`does not eagerly allocate sparse arrays (len=${perArrayLen}, count=${count})`, () => {
		const payload = buildSparseDoSPayload(count, perArrayLen);
		const result = parse(payload);

		// The root is the object whose keys reference every sparse array;
		// accessing them forces hydration of all `count` arrays.
		assert.is(typeof result, 'object');
		assert.ok(result !== null);

		// Spot-check the first and last sparse arrays.
		const first = result.k0;
		const last = result[`k${count - 1}`];
		assert.ok(Array.isArray(first));
		assert.ok(Array.isArray(last));
		assert.is(first.length, perArrayLen);
		assert.is(last.length, perArrayLen);
		assert.is(first[0], 42);
		assert.is(last[0], 42);
	});
}

uvu.test.run();

// --- stringifyAsync tests ---

// Verify that stringifyAsync produces identical output to stringify for all fixtures
for (const [name, tests] of Object.entries(fixtures)) {
	const test = uvu.suite(`stringifyAsync: ${name}`);
	for (const t of tests) {
		test(t.name, async () => {
			const actual = await stringifyAsync(t.value, t.reducers);
			const expected = t.json;
			assert.equal(actual, expected);
		});
	}
	test.run();
}

// Verify round-trip: stringifyAsync output can be parsed back
for (const [name, tests] of Object.entries(fixtures)) {
	const test = uvu.suite(`stringifyAsync round-trip: ${name}`);
	for (const t of tests) {
		test(t.name, async () => {
			const json = await stringifyAsync(t.value, t.reducers);
			const actual = parse(json, t.revivers);

			if (t.validate) {
				t.validate(actual);
			} else {
				assert.equal(actual, t.value);
			}
		});
	}
	test.run();
}

// Async-specific tests
const asyncTests = uvu.suite('stringifyAsync: promises');

asyncTests('resolves top-level promise', async () => {
	const result = await stringifyAsync(Promise.resolve(42));
	assert.equal(result, stringify(42));
});

asyncTests('resolves promise to undefined', async () => {
	const result = await stringifyAsync(Promise.resolve(undefined));
	assert.equal(result, stringify(undefined));
});

asyncTests('resolves promise to null', async () => {
	const result = await stringifyAsync(Promise.resolve(null));
	assert.equal(result, stringify(null));
});

asyncTests('resolves promise to NaN', async () => {
	const result = await stringifyAsync(Promise.resolve(NaN));
	assert.equal(result, stringify(NaN));
});

asyncTests('resolves nested promises in objects', async () => {
	const result = await stringifyAsync({
		a: Promise.resolve(1),
		b: Promise.resolve('hello')
	});
	assert.equal(result, stringify({ a: 1, b: 'hello' }));
});

asyncTests('resolves promises in arrays', async () => {
	const result = await stringifyAsync([Promise.resolve('a'), Promise.resolve('b')]);
	assert.equal(result, stringify(['a', 'b']));
});

asyncTests('resolves promises in Sets', async () => {
	const result = await stringifyAsync(new Set([Promise.resolve(1), Promise.resolve(2)]));
	assert.equal(result, stringify(new Set([1, 2])));
});

asyncTests('resolves promises in Map values', async () => {
	const result = await stringifyAsync(new Map([['key', Promise.resolve('value')]]));
	assert.equal(result, stringify(new Map([['key', 'value']])));
});

asyncTests('resolves deeply nested promises', async () => {
	const result = await stringifyAsync({
		a: { b: { c: Promise.resolve(42) } }
	});
	assert.equal(result, stringify({ a: { b: { c: 42 } } }));
});

asyncTests('deduplicates resolved values by identity', async () => {
	const obj = { x: 1 };
	const promise = Promise.resolve(obj);
	const result = await stringifyAsync([promise, promise]);
	assert.equal(result, stringify([obj, obj]));
});

asyncTests('handles thenables', async () => {
	const thenable = { then: (resolve) => resolve(42) };
	const result = await stringifyAsync(thenable);
	assert.equal(result, stringify(42));
});

asyncTests('propagates rejected promises', async () => {
	try {
		await stringifyAsync(Promise.reject(new Error('fail')));
		assert.unreachable('should have thrown');
	} catch (e) {
		assert.equal(e.message, 'fail');
	}
});

asyncTests('resolves promise to complex value', async () => {
	const complex = { date: new Date(1e12), set: new Set([1, 2]), arr: [3, 4] };
	const result = await stringifyAsync(Promise.resolve(complex));
	assert.equal(result, stringify(complex));
});

asyncTests('resolves mixed sync and async values', async () => {
	const result = await stringifyAsync({
		sync: 'hello',
		async: Promise.resolve('world'),
		nested: {
			sync: 42,
			async: Promise.resolve([1, 2, 3])
		}
	});
	assert.equal(
		result,
		stringify({
			sync: 'hello',
			async: 'world',
			nested: {
				sync: 42,
				async: [1, 2, 3]
			}
		})
	);
});

asyncTests.run();

// Error handling with stringifyAsync
const asyncErrorTests = uvu.suite('stringifyAsync: errors');

asyncErrorTests('throws for functions', async () => {
	try {
		await stringifyAsync(function invalid() {});
		assert.unreachable('should have thrown');
	} catch (e) {
		assert.equal(e.name, 'DevalueError');
		assert.equal(e.message, 'Cannot stringify a function');
	}
});

asyncErrorTests('throws for Symbols', async () => {
	try {
		await stringifyAsync(Symbol('foo'));
		assert.unreachable('should have thrown');
	} catch (e) {
		assert.equal(e.name, 'DevalueError');
	}
});

asyncErrorTests('throws for non-POJOs without reducer', async () => {
	class Whatever {}
	try {
		await stringifyAsync(new Whatever());
		assert.unreachable('should have thrown');
	} catch (e) {
		assert.equal(e.name, 'DevalueError');
		assert.equal(e.message, 'Cannot stringify arbitrary non-POJOs');
	}
});

asyncErrorTests('throws for promise resolving to function', async () => {
	try {
		await stringifyAsync(Promise.resolve(function invalid() {}));
		assert.unreachable('should have thrown');
	} catch (e) {
		assert.equal(e.name, 'DevalueError');
		assert.equal(e.message, 'Cannot stringify a function');
	}
});

asyncErrorTests.run();

const circularCustomTypes = uvu.suite('circular references through custom types');

circularCustomTypes('resolves circular reference through two custom types', () => {
	const foo = new Foo({ name: 'outer' });
	const bar = new Bar({ name: 'inner', ref: foo });
	foo.value.ref = bar;

	const reducers = {
		Foo: (x) => x instanceof Foo && x.value,
		Bar: (x) => x instanceof Bar && x.value
	};
	const fooCache = new WeakMap();
	const barCache = new WeakMap();
	const revivers = {
		Foo: (x) => {
			let inst = fooCache.get(x);
			if (!inst) {
				inst = Object.create(Foo.prototype);
				fooCache.set(x, inst);
			}
			inst.value = x;
			return inst;
		},
		Bar: (x) => {
			let inst = barCache.get(x);
			if (!inst) {
				inst = Object.create(Bar.prototype);
				barCache.set(x, inst);
			}
			inst.value = x;
			return inst;
		}
	};

	const json = stringify(foo, reducers);
	const result = parse(json, revivers);

	assert.ok(result instanceof Foo);
	assert.ok(result.value.ref instanceof Bar);
	assert.is(result.value.ref.value.ref, result);
});

circularCustomTypes('resolves self-referencing custom type', () => {
	const foo = new Foo({ name: 'self' });
	foo.value.ref = foo;

	const reducers = {
		Foo: (x) => x instanceof Foo && x.value
	};
	const fooCache = new WeakMap();
	const revivers = {
		Foo: (x) => {
			let inst = fooCache.get(x);
			if (!inst) {
				inst = Object.create(Foo.prototype);
				fooCache.set(x, inst);
			}
			inst.value = x;
			return inst;
		}
	};

	const json = stringify(foo, reducers);
	const result = parse(json, revivers);

	assert.ok(result instanceof Foo);
	assert.is(result.value.ref, result);
});

circularCustomTypes.run();


{
	const test = uvu.suite('uneval: large graphs');

	test('serializes more than 65534 repeated references to valid JS', () => {
		// A function may have at most 65535 parameters, so one hoisted parameter
		// per repeated value produced code the engine rejects with "Too many
		// parameters in function definition". See issue #93.
		const shared = Array.from({ length: 70000 }, (_, i) => ({ i }));
		const value = { a: shared, b: shared.slice() };

		const serialized = uneval(value);
		assert.ok(serialized.includes('arguments[0]'));
		const roundtripped = new Function('return ' + serialized)();

		assert.equal(roundtripped.a.length, 70000);
		assert.equal(roundtripped.a[0].i, 0);
		assert.equal(roundtripped.a[69999].i, 69999);
		// the two arrays share object identity
		assert.ok(roundtripped.a[123] === roundtripped.b[123]);
	});

	test('packs oversized custom-graph IIFE arguments into one array', () => {
		class Marker {}
		const shared = Array.from({ length: 65536 }, (_, i) => ({ i }));
		const marker = new Marker();
		const value = { a: shared, b: shared.slice(), marker };

		const serialized = uneval(value, (item, js) =>
			item instanceof Marker ? js`({custom:true})` : undefined
		);
		assert.ok(serialized.includes('arguments[0]'));
		const roundtripped = new Function('return ' + serialized)();

		assert.is(roundtripped.a[65535], roundtripped.b[65535]);
		assert.is(roundtripped.marker.custom, true);
	});

	test.run();
}
