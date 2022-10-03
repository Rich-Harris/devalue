import {
	DevalueError,
	get_type,
	is_plain_object,
	is_primitive,
	stringify_primitive
} from './utils.js';

const UNDEFINED = -1;
const HOLE = -2;
const NAN = -3;
const POSITIVE_INFINITY = -4;
const NEGATIVE_INFINITY = -5;
const NEGATIVE_ZERO = -6;

/**
 * Turn a value into a JSON string that can be parsed with `devalue.parse`
 * @param {any} value
 */
export function stringify(value) {
	/** @type {any[]} */
	const array = [];

	/** @type {Map<any, number>} */
	const map = new Map();

	/** @type {string[]} */
	const keys = [];

	/** @param {any} thing */
	function flatten(thing) {
		if (map.has(thing)) return map.get(thing);

		if (thing === undefined) return UNDEFINED;
		if (Number.isNaN(thing)) return NAN;
		if (thing === Infinity) return POSITIVE_INFINITY;
		if (thing === -Infinity) return NEGATIVE_INFINITY;
		if (thing === 0 && 1 / thing < 0) return NEGATIVE_ZERO;

		const index = array.length;
		map.set(thing, index);

		if (typeof thing === 'function') {
			throw new DevalueError(`Cannot stringify a function`, keys);
		}

		if (is_primitive(thing)) {
			array.push(thing);
		} else {
			const type = get_type(thing);

			switch (type) {
				case 'Number':
				case 'String':
				case 'Boolean':
					array.push(['Object', thing]);
					break;

				case 'BigInt':
					array.push(['BigInt', thing.toString()]);
					break;

				case 'Date':
					array.push(['Date', thing.toISOString()]);
					break;

				case 'RegExp':
					const { source, flags } = thing;
					array.push(flags ? ['RegExp', source, flags] : ['RegExp', source]);
					break;

				case 'Array':
					/** @type {number[]} */
					const flattened_array = [];
					array.push(flattened_array);

					for (let i = 0; i < thing.length; i += 1) {
						if (i in thing) {
							keys.push(`[${i}]`);
							flattened_array.push(flatten(thing[i]));
							keys.pop();
						} else {
							flattened_array.push(HOLE);
						}
					}

					break;

				case 'Set':
					/** @type {any[]} */
					const flattened_set = ['Set', []];
					array.push(flattened_set);

					for (const value of thing) {
						flattened_set[1].push(flatten(value));
					}
					break;

				case 'Map':
					/** @type {any[]} */
					const flattened_map = ['Map', []];
					array.push(flattened_map);

					for (const [key, value] of thing) {
						keys.push(
							`.get(${is_primitive(key) ? stringify_primitive(key) : '...'})`
						);
						flattened_map[1].push(flatten(key), flatten(value));
					}
					break;

				default:
					if (!is_plain_object(thing)) {
						throw new DevalueError(
							`Cannot stringify arbitrary non-POJOs`,
							keys
						);
					}

					if (Object.getOwnPropertySymbols(thing).length > 0) {
						throw new DevalueError(
							`Cannot stringify POJOs with symbolic keys`,
							keys
						);
					}

					/** @type {Record<string, any>} */
					const flattened_object = {};
					array.push(flattened_object);

					for (const key in thing) {
						keys.push(`.${key}`);
						flattened_object[key] = flatten(thing[key]);
						keys.pop();
					}
			}
		}

		return index;
	}

	const index = flatten(value);

	// special case — value is represented as a negative index
	if (index < 0) return `[${index}]`;

	return JSON.stringify(array);
}
