import * as assert from 'assert';
import devalue from '../src/index';

describe('devalue', () => {
	// borrowed from https://github.com/jed/lave
	const tests: Record<string, [any, string]> = {
		number:    [ 123                           , `123`                                 ],
		negative:  [ -123                          , `-123`                                ],
		string:    [ 'abc'                         , `"abc"`                               ],
		boolean:   [ true                          , `true`                                ],
		Number:    [ new Number(123)               , `Object(123)`                         ],
		String:    [ new String('abc')             , `Object("abc")`                       ],
		Boolean:   [ new Boolean(true)             , `Object(true)`                        ],
		undefined: [ void 0                        , `undefined`                           ],
		null:      [ null                          , `null`                                ],
		NaN:       [ NaN                           , `NaN`                                 ],
		Infinity:  [ Infinity                      , `Infinity`                            ],
		RegExp:    [ /regexp/img                   , `/regexp/gim`                         ],
		//Buffer:    [ new Buffer('A')               , `Buffer('QQ==','base64')`             ],
		Date:      [ new Date(1e12)                , `new Date(1000000000000)`             ],
		Array:     [ [1,2,3]                       , `[1,2,3]`                             ],
		Object:    [ {foo: 'bar', 'x-y': 'z'}      , `{foo:"bar","x-y":"z"}`               ],
		sparse:    [ Array(10)                     , `[,,,,,,,,,,]`                        ],
		Set:       [ new Set([1,2,3])              , `new Set([1,2,3])`                    ],
		Map:       [ new Map([[1,2]])              , `new Map([[1,2]])`                    ],
		cycleMap:  [ (a=>a.set(0,a))(new Map)      , `(function(a){a.set(0, a);return a}(new Map))`   ],
		cycleSet:  [ (a=>a.add(a).add(0))(new Set) , `(function(a){a.add(a).add(0);return a}(new Set))` ],
		arrcycle:  [ ((a:any)=>a[0]=a)([])         , `var a=[,];a[0]=a;a`                  ],
		objcycle:  [ ((a:any)=>a.a=a)({})          , `var a={'a':null};a.a=a;a`            ],
		dipole:    [ (a=>[a,a])({})                , `var a={};[a,a]`                      ],
		property:  [ Object.assign([], {a:0})      , `var a=[];a.a=0;a`                    ],
		prototype: [ Object.create(null)           , `Object.create(null)`                 ]
	};

	function test(name: string, input: any, expected: string) {
		it(name, () => {
			const actual = devalue(input);
			assert.equal(actual, expected);
		});
	}

	describe('basics', () => {
		test('number', 42, '42');
		test('negative number', -42, '-42');
		test('negative zero', -0, '-0');
		test('string', 'woo!!!', '"woo!!!"');
		test('boolean', true, 'true');
		test('Number', new Number(42), 'Object(42)');
		test('String', new String('yar'), 'Object("yar")');
		test('Boolean', new Boolean(false), 'Object(false)');
		test('undefined', undefined, 'void 0');
		test('null', null, 'null');
		test('NaN', NaN, 'NaN');
		test('Infinity', Infinity, 'Infinity');
		test('RegExp', /regexp/img, '/regexp/gim');
		test('Date', new Date(1e12), 'new Date(1000000000000)');
		test('Array', ['a', 'b', 'c'], '["a","b","c"]');
		test('Array (empty)', [], '[]');
		test('Array (sparse)', [,'b',,], '[,"b",,]');
		test('Object', {foo: 'bar', 'x-y': 'z'}, '{foo:"bar","x-y":"z"}');
		test('Set', new Set([1, 2, 3]), 'new Set([1,2,3])');
		test('Map', new Map([['a', 'b']]), 'new Map([["a","b"]])');
	});

	describe('cycles', () => {
		let map = new Map();
		map.set('self', map);
		test('Map (cyclical)', map, `(function(a){a.set("self", a);return a}(new Map))`);

		let set = new Set();
		set.add(set);
		set.add(42);
		test('Set (cyclical)', set, `(function(a){a.add(a).add(42);return a}(new Set))`);

		let arr: any[] = [];
		arr[0] = arr;
		test('Array (cyclical)', arr, `(function(a){a[0]=a;return a}(Array(1)))`);

		let obj: any = {};
		obj.self = obj;
		test('Object (cyclical)', obj, `(function(a){a.self=a;return a}({}))`);
	});

	describe('repetition', () => {
		let str = 'a string';
		test('String (repetition)', [str, str], `(function(a){return [a,a]}("a string"))`);
	});

	describe('misc', () => {
		test('Object without prototype', Object.create(null), 'Object.create(null)');

		// let arr = [];
		// arr.x = 42;
		// test('Array with named properties', arr, `TODO`);
	});
});