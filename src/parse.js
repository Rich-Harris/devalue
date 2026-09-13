import { decode64 } from './base64.js';
import {
	HOLE,
	NAN,
	NEGATIVE_INFINITY,
	NEGATIVE_ZERO,
	POSITIVE_INFINITY,
	SPARSE,
	UNDEFINED
} from './constants.js';
import { default_parse_operations, merge_operations } from './operations.js';
import { is_valid_array_index, is_valid_array_len } from './utils.js';

/**
 * Revive a value serialized with `devalue.stringify`
 * @param {string} serialized
 * @param {Record<string, (value: any) => any>} [revivers]
 * @param {import('./types.js').ParseOptions} [options]
 */
export function parse(serialized, revivers, options) {
	return unflatten(JSON.parse(serialized), revivers, options);
}

/**
 * Revive a value flattened with `devalue.stringify`
 * @param {number | any[]} parsed
 * @param {Record<string, (value: any) => any>} [revivers]
 * @param {import('./types.js').ParseOptions} [options]
 */
export function unflatten(parsed, revivers, options) {
	/** @type {import('./types.js').ParseOperations} */
	const ops = merge_operations(default_parse_operations, options?.operations);

	if (typeof parsed === 'number') return hydrate(parsed, true);

	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error('Invalid input');
	}

	const values = /** @type {any[]} */ (parsed);

	const hydrated = Array(values.length);

	/**
	 * A set of values currently being hydrated with custom revivers,
	 * used to detect invalid cyclical dependencies
	 * @type {Set<number> | null}
	 */
	let hydrating = null;

	/**
	 * @param {number} index
	 * @returns {any}
	 */
	function hydrate(index, standalone = false) {
		if (index === UNDEFINED) return ops.fromPrimitive(undefined);
		if (index === NAN) return ops.fromPrimitive(NaN);
		if (index === POSITIVE_INFINITY) return ops.fromPrimitive(Infinity);
		if (index === NEGATIVE_INFINITY) return ops.fromPrimitive(-Infinity);
		if (index === NEGATIVE_ZERO) return ops.fromPrimitive(-0);

		if (standalone || typeof index !== 'number') {
			throw new Error(`Invalid input`);
		}

		if (index in hydrated) return hydrated[index];

		if (index >= values.length) {
			throw new Error(`Invalid input`);
		}

		const value = values[index];

		if (!value || typeof value !== 'object') {
			hydrated[index] = ops.fromPrimitive(value);
		} else if (Array.isArray(value)) {
			if (typeof value[0] === 'string') {
				const type = value[0];

				const reviver = revivers && Object.hasOwn(revivers, type) ? revivers[type] : undefined;

				if (reviver) {
					let i = value[1];
					if (typeof i !== 'number') {
						// if it's not a number, it was serialized by a builtin reviver
						// so we need to munge it into the format expected by a custom reviver
						i = values.push(value[1]) - 1;
					}

					// If the payload is already hydrated, its recursion has already
					// terminated (e.g. a self-referential object cached itself before
					// following its own back-reference), so revive it directly. Falling
					// through to the `hydrating` guard here would wrongly reject a valid
					// cycle. An actually infinite payload (e.g. `[["Custom", 0]]`) is never
					// cached, so it still hits the guard below.
					if (Object.hasOwn(hydrated, i)) {
						return (hydrated[index] = reviver(hydrated[i]));
					}

					hydrating ??= new Set();

					if (hydrating.has(i)) {
						throw new Error('Invalid circular reference');
					}

					hydrating.add(i);
					hydrated[index] = reviver(hydrate(i));
					hydrating.delete(i);

					return hydrated[index];
				}

				switch (type) {
					case 'Date':
						hydrated[index] = ops.fromISOString(value[1]);
						break;

					case 'Set':
						const set = ops.createSet();
						hydrated[index] = set;
						for (let i = 1; i < value.length; i += 1) {
							ops.addValue(set, hydrate(value[i]));
						}
						break;

					case 'Map':
						const map = ops.createMap();
						hydrated[index] = map;
						for (let i = 1; i < value.length; i += 2) {
							ops.addEntry(map, hydrate(value[i]), hydrate(value[i + 1]));
						}
						break;

					case 'RegExp':
						hydrated[index] = ops.fromRegExpInfo(value[1], value[2]);
						break;

					case 'Object': {
						const wrapped_index = value[1];

						// Only a primitive can be boxed. The negative sentinels below are the
						// ones `stringify` emits for boxed numbers; every other sentinel
						// (`UNDEFINED`, `HOLE`, `SPARSE`) would box `undefined` into a plain
						// `{}`, which is not a value `stringify` can produce.
						const is_boxable_sentinel =
							wrapped_index === NAN ||
							wrapped_index === POSITIVE_INFINITY ||
							wrapped_index === NEGATIVE_INFINITY ||
							wrapped_index === NEGATIVE_ZERO;

						if (!is_boxable_sentinel) {
							// The index must be checked before it is used to look up `values`,
							// otherwise a non-index (or an out-of-bounds one) reaches the
							// `[0]` access below as `undefined` and throws a raw TypeError
							// instead of the intended `Invalid input`.
							if (
								typeof wrapped_index !== 'number' ||
								!Number.isInteger(wrapped_index) ||
								wrapped_index < 0 ||
								wrapped_index >= values.length
							) {
								throw new Error('Invalid input');
							}

							const wrapped = values[wrapped_index];

							// `typeof null === 'object'`, so `null` also has to be rejected here
							// rather than being indexed into.
							const is_bigint = Array.isArray(wrapped) && wrapped[0] === 'BigInt';

							if ((wrapped === null || typeof wrapped === 'object') && !is_bigint) {
								// avoid infinite recusion in case of malformed input
								throw new Error('Invalid input');
							}
						}

						hydrated[index] = ops.box(hydrate(wrapped_index));
						break;
					}

					case 'BigInt':
						hydrated[index] = ops.fromPrimitive(BigInt(value[1]));
						break;

					case 'null':
						const obj = ops.createNullPrototypeObject();
						hydrated[index] = obj;
						for (let i = 1; i < value.length; i += 2) {
							if (value[i] === '__proto__') {
								throw new Error('Cannot parse an object with a `__proto__` property');
							}

							ops.set(obj, value[i], hydrate(value[i + 1]));
						}
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
					case 'BigUint64Array':
					case 'DataView': {
						const buffer_index = value[1];

						// `buffer_index` is checked before it is used as a lookup, otherwise a
						// non-index reads `undefined` out of `values` and the `[0]` access
						// below throws a raw TypeError instead of the intended `Invalid data`.
						const buffer_value =
							typeof buffer_index === 'number' &&
							Number.isInteger(buffer_index) &&
							buffer_index >= 0 &&
							buffer_index < values.length
								? values[buffer_index]
								: undefined;

						if (!Array.isArray(buffer_value) || buffer_value[0] !== 'ArrayBuffer') {
							// without this, if we receive malformed input we could
							// end up trying to hydrate in a circle or allocate
							// huge amounts of memory when we call `new TypedArrayConstructor(buffer)`
							throw new Error('Invalid data');
						}

						const buffer = hydrate(buffer_index);

						hydrated[index] = ops.fromViewInfo(type, buffer, value[2], value[3]);

						break;
					}

					case 'ArrayBuffer': {
						const base64 = value[1];
						if (typeof base64 !== 'string') {
							throw new Error('Invalid ArrayBuffer encoding');
						}
						hydrated[index] = ops.fromArrayBuffer(decode64(base64));
						break;
					}

					case 'URL':
					case 'URLSearchParams':
					case 'Temporal.Duration':
					case 'Temporal.Instant':
					case 'Temporal.PlainDate':
					case 'Temporal.PlainTime':
					case 'Temporal.PlainDateTime':
					case 'Temporal.PlainMonthDay':
					case 'Temporal.PlainYearMonth':
					case 'Temporal.ZonedDateTime': {
						// the same tags `toStringValue` serializes on the stringify side
						hydrated[index] = ops.fromStringValue(type, value[1]);
						break;
					}

					default:
						throw new Error(`Unknown type ${type}`);
				}
			} else if (value[0] === SPARSE) {
				// Sparse array encoding: [SPARSE, length, idx, val, idx, val, ...]
				const len = value[1];

				if (!is_valid_array_len(len)) {
					throw new Error('Invalid input');
				}

				// `len` comes from the input rather than being bounded by it, so
				// `createSparseArray` is responsible for not allocating storage
				// proportional to it.
				const array = ops.createSparseArray(len);
				hydrated[index] = array;

				for (let i = 2; i < value.length; i += 2) {
					const idx = value[i];

					if (!is_valid_array_index(idx) || idx >= len) {
						throw new Error('Invalid input');
					}

					ops.set(array, idx, hydrate(value[i + 1]));
				}
			} else {
				const array = ops.createArray(value.length);
				hydrated[index] = array;

				for (let i = 0; i < value.length; i += 1) {
					const n = value[i];
					if (n === HOLE) continue;

					ops.set(array, i, hydrate(n));
				}
			}
		} else {
			const object = ops.createObject();
			hydrated[index] = object;

			for (const key of Object.keys(value)) {
				if (key === '__proto__') {
					throw new Error('Cannot parse an object with a `__proto__` property');
				}

				ops.set(object, key, hydrate(value[key]));
			}
		}

		return hydrated[index];
	}

	return hydrate(0);
}
