import { DevalueError, stringify_key, stringify_string } from './utils.js';
import {
	HOLE,
	NAN,
	NEGATIVE_INFINITY,
	NEGATIVE_ZERO,
	POSITIVE_INFINITY,
	SPARSE,
	UNDEFINED
} from './constants.js';
import { encode64 } from './base64.js';
import { default_stringify_operations, merge_operations } from './operations.js';

/**
 * Turn a value into a JSON string that can be parsed with `devalue.parse`
 * @param {any} value
 * @param {Record<string, (value: any) => any>} [reducers]
 * @param {import('./types.js').StringifyOptions} [options]
 */
export function stringify(value, reducers, options) {
	const stringified = run(false, value, reducers, options);
	return typeof stringified === 'string' ? stringified : `[${stringified.join(',')}]`;
}

/**
 * Turn a value into a JSON string that can be parsed with `devalue.parse`
 * @param {any} value
 * @param {Record<string, (value: any) => any>} [reducers]
 * @param {import('./types.js').StringifyOptions} [options]
 */
export async function stringifyAsync(value, reducers, options) {
	const stringified = run(true, value, reducers, options);

	if (typeof stringified === 'string') {
		return stringified;
	}

	let out = '[';

	for (let i = 0; i < stringified.length; i += 1) {
		let value = stringified[i];

		if (typeof value !== 'string') {
			await value;
			value = stringified[i];

			if (i === 0 && value < 0) {
				return `${value}`;
			}
		}

		out += value;

		if (i < stringified.length - 1) {
			out += ',';
		}
	}

	out += ']';

	return out;
}

/**
 * @param {boolean} async
 * @param {any} value
 * @param {Record<string, (value: any) => any>} [reducers]
 * @param {import('./types.js').StringifyOptions} [options]
 */
function run(async, value, reducers, options) {
	const ops = merge_operations(default_stringify_operations, options?.operations);

	/** @type {any[]} */
	const stringified = [];

	/** @type {Map<any, number>} */
	const indexes = new Map();

	/** @type {Array<{ key: string, fn: (value: any) => any }>} */
	const custom = [];
	if (reducers) {
		for (const key of Object.getOwnPropertyNames(reducers)) {
			custom.push({ key, fn: reducers[key] });
		}
	}

	/** @type {string[]} */
	const keys = [];

	let p = 0;

	/**
	 * @param {any} thing
	 * @param {number} [index]
	 */
	function flatten(thing, index) {
		const type = ops.typeOf(thing);

		if (type === 'undefined') return UNDEFINED;

		/** @type {number | undefined} */
		let number;

		// `ops.toPrimitive` is the boundary between the value being serialized and
		// plain host JavaScript: everything below operates on the extracted host
		// primitive, so native comparisons and arithmetic are correct there.
		if (type === 'number') {
			number = /** @type {number} */ (ops.toPrimitive(thing));
			if (Number.isNaN(number)) return NAN;
			if (number === Infinity) return POSITIVE_INFINITY;
			if (number === -Infinity) return NEGATIVE_INFINITY;
			if (number === 0 && 1 / number < 0) return NEGATIVE_ZERO;
		}

		const id = ops.identify(thing);

		if (indexes.has(id)) return /** @type {number} */ (indexes.get(id));

		index ??= p++;
		indexes.set(id, index);

		for (const { key, fn } of custom) {
			const value = fn(thing);
			if (value) {
				stringified[index] = `["${key}",${flatten(value)}]`;
				return index;
			}
		}

		if (type === 'function') {
			throw new DevalueError(`Cannot stringify a function`, keys, thing, value);
		} else if (type === 'symbol') {
			throw new DevalueError(`Cannot stringify a Symbol primitive`, keys, thing, value);
		}

		/** @type {string | Promise<any>} */
		let str = '';

		if (type !== 'object') {
			str = stringify_primitive(type === 'number' ? number : ops.toPrimitive(thing));
		} else if (ops.isThenable(thing)) {
			if (!async) {
				throw new DevalueError(
					`Cannot stringify a Promise or thenable — use stringifyAsync instead`,
					keys,
					thing,
					value
				);
			}

			// the callback runs after the synchronous walk has unwound `keys`,
			// so the path to the thenable has to be captured and reinstated
			const path = keys.slice();

			str = ops.toPromise(thing).then((value) => {
				const depth = keys.length;
				for (const key of path) keys.push(key);

				try {
					const i = flatten(value, index);
					if (i < 0) stringified[index] = i;
				} finally {
					keys.length = depth;
				}
			});
		} else {
			const tag = ops.tagOf(thing);

			switch (tag) {
				case 'Number':
				case 'String':
				case 'Boolean':
				case 'BigInt':
					str = `["Object",${flatten(ops.unbox(thing))}]`;
					break;

				case 'Date':
					str = `["Date","${ops.toISOString(thing)}"]`;
					break;

				case 'URL':
					str = `["URL",${stringify_string(ops.toStringValue(thing))}]`;
					break;

				case 'URLSearchParams':
					str = `["URLSearchParams",${stringify_string(ops.toStringValue(thing))}]`;
					break;

				case 'RegExp':
					const { source, flags } = ops.regExpInfo(thing);
					str = flags
						? `["RegExp",${stringify_string(source)},"${flags}"]`
						: `["RegExp",${stringify_string(source)}]`;
					break;

				case 'Array': {
					// For dense arrays (no holes), we iterate normally.
					// When we encounter the first hole, we call Object.keys
					// to determine the sparseness, then decide between:
					//   - HOLE encoding: [-2, val, -2, ...] (default)
					//   - Sparse encoding: [-7, length, idx, val, ...] (for very sparse arrays)
					// Only the sparse path avoids iterating every slot, which
					// is what protects against the DoS of e.g. `arr[1000000] = 1`.
					let mostly_dense = false;

					const length = ops.lengthOf(thing);

					str = '[';

					for (let i = 0; i < length; i += 1) {
						if (i > 0) str += ',';

						if (ops.hasOwn(thing, i)) {
							keys.push(`[${i}]`);
							str += flatten(ops.get(thing, i));
							keys.pop();
						} else if (mostly_dense) {
							// Use dense encoding. The heuristic guarantees the
							// array is only mildly sparse, so iterating over every
							// slot is fine.
							str += HOLE;
						} else {
							// Decide between HOLE encoding and sparse encoding.
							//
							// HOLE encoding: each hole is serialized as the HOLE
							// sentinel (-2). For example, [, "a", ,] becomes
							// [-2, 0, -2]. Each hole costs 3 chars ("-2" + comma).
							//
							// Sparse encoding: lists only populated indices.
							// For example, [, "a", ,] becomes [-7, 3, 1, 0] — the
							// -7 sentinel, the array length (3), then index-value
							// pairs. This avoids paying per-hole, but each element
							// costs extra chars to write its index.
							//
							// The values are the same size either way, so the
							// choice comes down to structural overhead:
							//
							//   HOLE overhead:
							//     3 chars per hole ("-2" + comma)
							//     = (L - P) * 3
							//
							//   Sparse overhead:
							//     "-7,"          — 3 chars (sparse sentinel + comma)
							//     + length + "," — (d + 1) chars (array length + comma)
							//     + per element: index + "," — (d + 1) chars
							//     = (4 + d) + P * (d + 1)
							//
							// where L is the array length, P is the number of
							// populated elements, and d is the number of digits
							// in L (an upper bound on the digits in any index).
							//
							// Sparse encoding is cheaper when:
							//   (4 + d) + P * (d + 1) < (L - P) * 3
							const populated_keys = ops.indicesOf(thing);
							const population = populated_keys.length;
							const d = String(length).length;

							const hole_cost = (length - population) * 3;
							const sparse_cost = 4 + d + population * (d + 1);

							if (hole_cost > sparse_cost) {
								str = '[' + SPARSE + ',' + length;
								for (let j = 0; j < populated_keys.length; j++) {
									const key = populated_keys[j];
									keys.push(`[${key}]`);
									str += ',' + key + ',' + flatten(ops.get(thing, key));
									keys.pop();
								}
								break;
							} else {
								mostly_dense = true;
								str += HOLE;
							}
						}
					}

					str += ']';

					break;
				}

				case 'Set':
					str = '["Set"';

					for (const value of ops.valuesOf(thing)) {
						str += `,${flatten(value)}`;
					}

					str += ']';
					break;

				case 'Map':
					str = '["Map"';

					for (const [key, value] of ops.entriesOf(thing)) {
						const key_type = ops.typeOf(key);
						const key_is_primitive =
							key_type !== 'object' && key_type !== 'function' && key_type !== 'symbol';
						keys.push(
							`.get(${key_is_primitive ? stringify_primitive(ops.toPrimitive(key)) : '...'})`
						);
						str += `,${flatten(key)},${flatten(value)}`;
						keys.pop();
					}

					str += ']';
					break;

				case 'Int8Array':
				case 'Uint8Array':
				case 'Uint8ClampedArray':
				case 'Int16Array':
				case 'Uint16Array':
				case 'Float16Array':
				case 'Int32Array':
				case 'Uint32Array':
				case 'Float32Array':
				case 'Float64Array':
				case 'BigInt64Array':
				case 'BigUint64Array': {
					const info = ops.viewInfo(thing);
					str = '["' + tag + '",' + flatten(info.buffer);

					// handle subarrays
					if (info.byteLength !== info.bufferByteLength) {
						str += `,${info.byteOffset},${info.length}`;
					}

					str += ']';
					break;
				}

				case 'DataView': {
					const info = ops.viewInfo(thing);
					str = '["' + tag + '",' + flatten(info.buffer);

					if (info.byteLength !== info.bufferByteLength) {
						str += `,${info.byteOffset},${info.byteLength}`;
					}

					str += ']';
					break;
				}

				case 'ArrayBuffer': {
					const base64 = encode64(ops.toArrayBuffer(thing));

					str = `["ArrayBuffer","${base64}"]`;
					break;
				}

				case 'Temporal.Duration':
				case 'Temporal.Instant':
				case 'Temporal.PlainDate':
				case 'Temporal.PlainTime':
				case 'Temporal.PlainDateTime':
				case 'Temporal.PlainMonthDay':
				case 'Temporal.PlainYearMonth':
				case 'Temporal.ZonedDateTime':
					str = `["${tag}",${stringify_string(ops.toStringValue(thing))}]`;
					break;

				default: {
					const shape = ops.shapeOf(thing);

					if (shape.kind === 'not-plain') {
						throw new DevalueError(`Cannot stringify arbitrary non-POJOs`, keys, thing, value);
					}

					if (shape.kind === 'symbol-keys') {
						throw new DevalueError(`Cannot stringify POJOs with symbolic keys`, keys, thing, value);
					}

					if (shape.kind === 'null-proto') {
						str = '["null"';
						for (const key of shape.keys) {
							if (key === '__proto__') {
								throw new DevalueError(
									`Cannot stringify objects with __proto__ keys`,
									keys,
									thing,
									value
								);
							}

							keys.push(stringify_key(key));
							str += `,${stringify_string(key)},${flatten(ops.get(thing, key))}`;
							keys.pop();
						}
						str += ']';
					} else {
						str = '{';
						let started = false;
						for (const key of shape.keys) {
							if (key === '__proto__') {
								throw new DevalueError(
									`Cannot stringify objects with __proto__ keys`,
									keys,
									thing,
									value
								);
							}

							if (started) str += ',';
							started = true;
							keys.push(stringify_key(key));
							str += `${stringify_string(key)}:${flatten(ops.get(thing, key))}`;
							keys.pop();
						}
						str += '}';
					}
				}
			}
		}

		stringified[index] = str;
		return index;
	}

	const index = flatten(value);

	// special case — value is represented as a negative index
	if (index < 0) return `${index}`;

	return stringified;
}

/**
 * @param {any} thing
 * @returns {string}
 */
function stringify_primitive(thing) {
	const type = typeof thing;
	if (type === 'string') return stringify_string(thing);
	if (thing === void 0) return UNDEFINED.toString();
	if (thing === 0 && 1 / thing < 0) return NEGATIVE_ZERO.toString();
	if (type === 'bigint') return `["BigInt","${thing}"]`;
	return String(thing);
}
