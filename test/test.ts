import * as assert from 'assert';
import * as vm from 'vm';
import devalue from '../src/index';

describe('devalue', () => {
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
		test('positive decimal', 0.1, '.1');
		test('negative decimal', -0.1, '-.1');
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

		let objFromNull: any = Object.create(null);
		objFromNull.self = objFromNull;
		test('Object (cyclical)', objFromNull, `(function(a){a.self=a;return a}(Object.create(null)))`);

		let first: any = {};
		let second: any = {};
		first.second = second;
		second.first = first;
		test('Object (cyclical)', [first, second], `(function(a,b){a.second=b;b.first=a;return [a,b]}({},{}))`);
	});

	describe('repetition', () => {
		let str = 'a string';
		test('String (repetition)', [str, str], `(function(a){return [a,a]}("a string"))`);
	});

	describe('XSS', () => {
		test(
			'Dangerous string',
			`</script><script src='https://evil.com/script.js'>alert('pwned')</script><script>`,
			`"\\u003C\\u002Fscript\\u003E\\u003Cscript src='https:\\u002F\\u002Fevil.com\\u002Fscript.js'\\u003Ealert('pwned')\\u003C\\u002Fscript\\u003E\\u003Cscript\\u003E"`
		);
	});

	describe('misc', () => {
		test('Object without prototype', Object.create(null), 'Object.create(null)');

		// let arr = [];
		// arr.x = 42;
		// test('Array with named properties', arr, `TODO`);

		test('cross-realm POJO', vm.runInNewContext('({})'), '{}');
		//
		// it('throws for non-POJOs', () => {
		// 	class Foo {}
		// 	const foo = new Foo();
		// 	assert.throws(() => devalue(foo));
		// });
		//
		// it('throws for symbolic keys', () => {
		// 	assert.throws(() => devalue({ [Symbol()]: null }));
		// });
	});
});
