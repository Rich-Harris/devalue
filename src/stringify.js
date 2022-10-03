import {
	DevalueError,
	get_type,
	is_plain_object,
	is_primitive,
	stringify_string
} from './utils.js';
import {
	HOLE,
	NAN,
	NEGATIVE_INFINITY,
	NEGATIVE_ZERO,
	POSITIVE_INFINITY,
	UNDEFINED
} from './constants.js';

/**
 * Turn a value into a JSON string that can be parsed with `devalue.parse`
 * @param {any} value
 */
export function stringify(value) {
	/** @type {any[]} */
	const stringified = [];

	/** @type {Map<any, number>} */
	const map = new Map();

	/** @type {string[]} */
	const keys = [];

	let p = 0;

	/** @param {any} thing */
	function flatten(thing) {
		if (map.has(thing)) return map.get(thing);

		if (thing === undefined) return UNDEFINED;
		if (Number.isNaN(thing)) return NAN;
		if (thing === Infinity) return POSITIVE_INFINITY;
		if (thing === -Infinity) return NEGATIVE_INFINITY;
		if (thing === 0 && 1 / thing < 0) return NEGATIVE_ZERO;

		const index = p++;
		map.set(thing, index);

		if (typeof thing === 'function') {
			throw new DevalueError(`Cannot stringify a function`, keys);
		}

		if (is_primitive(thing)) {
			stringified[index] = stringify_primitive(thing);
		} else {
			const type = get_type(thing);

			switch (type) {
				case 'Number':
				case 'String':
				case 'Boolean':
					stringified[index] = `["Object",${stringify_primitive(thing)}]`;
					break;

				case 'BigInt':
					stringified[index] = `["BigInt",${thing}]`;
					break;

				case 'Date':
					stringified[index] = `["Date","${thing.toISOString()}"]`;
					break;

				case 'RegExp':
					const { source, flags } = thing;
					stringified[index] = flags
						? `["RegExp",${stringify_string(source)},"${flags}"]`
						: `["RegExp",${stringify_string(source)}]`;
					break;

				case 'Array':
					/** @type {number[]} */
					let flattened_array = [];

					for (let i = 0; i < thing.length; i += 1) {
						if (i in thing) {
							keys.push(`[${i}]`);
							flattened_array.push(flatten(thing[i]));
							keys.pop();
						} else {
							flattened_array.push(HOLE);
						}
					}

					stringified[index] = `[${flattened_array.join(',')}]`;

					break;

				case 'Set':
					/** @type {number[]} */
					const flattened_set = [];

					for (const value of thing) {
						flattened_set.push(flatten(value));
					}

					stringified[index] = `["Set",[${flattened_set.join(',')}]]`;
					break;

				case 'Map':
					/** @type {number[]} */
					const flattened_map = [];

					for (const [key, value] of thing) {
						keys.push(
							`.get(${is_primitive(key) ? stringify_primitive(key) : '...'})`
						);
						flattened_map.push(flatten(key), flatten(value));
					}

					stringified[index] = `["Map",[${flattened_map.join(',')}]]`;
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

					if (Object.getPrototypeOf(thing) === null) {
						let str = '["null"';
						for (const key in thing) {
							keys.push(`.${key}`);
							str += `,${stringify_string(key)},${flatten(thing[key])}`;
							keys.pop();
						}
						stringified[index] = str + ']';
					} else {
						let str = '{';
						let started = false;
						for (const key in thing) {
							if (started) str += ',';
							started = true;
							keys.push(`.${key}`);
							str += `${stringify_string(key)}:${flatten(thing[key])}`;
							keys.pop();
						}
						stringified[index] = str + '}';
					}
			}
		}

		return index;
	}

	const index = flatten(value);

	// special case — value is represented as a negative index
	if (index < 0) return `${index}`;

	return `[${stringified.join(',')}]`;
}

/**
 * @param {any} thing
 * @returns {string}
 */
function stringify_primitive(thing) {
	const type = typeof thing;
	if (type === 'string') return stringify_string(thing);
	if (thing instanceof String) return stringify_string(thing.toString());
	if (thing === void 0) return UNDEFINED.toString();
	if (thing === 0 && 1 / thing < 0) return NEGATIVE_ZERO.toString();
	if (type === 'bigint') return `["BigInt","${thing}"]`;
	return String(thing);
}
