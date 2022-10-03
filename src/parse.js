import {
	HOLE,
	NAN,
	NEGATIVE_INFINITY,
	NEGATIVE_ZERO,
	POSITIVE_INFINITY,
	UNDEFINED
} from './constants.js';

/**
 * Revive a value serialized with `devalue.stringify`
 * @param {string} serialized
 */
export function parse(serialized) {
	const values = JSON.parse(serialized);

	if (typeof values === 'number') return get_value(values);

	/** @param {number} index */
	function get_value(index) {
		if (index === UNDEFINED) return undefined;
		if (index === NAN) return NaN;
		if (index === POSITIVE_INFINITY) return Infinity;
		if (index === NEGATIVE_INFINITY) return -Infinity;
		if (index === NEGATIVE_ZERO) return -0;

		return values[index];
	}

	let i = values.length;
	while (i--) {
		const value = values[i];

		if (!value || typeof value !== 'object') continue;

		if (Array.isArray(value)) {
			if (typeof value[0] === 'string') {
				const type = value[0];

				switch (type) {
					case 'Date':
						values[i] = new Date(value[1]);
						break;

					case 'Set':
						const set = new Set();
						values[i] = set;
						for (const n of value[1]) set.add(get_value(n));
						break;

					case 'Map':
						const map = new Map();
						values[i] = map;
						for (let i = 0; i < value[1].length; i += 2) {
							map.set(get_value(value[i]), get_value(value[i + 1]));
						}
						break;

					case 'RegExp':
						values[i] = new RegExp(value[1], value[2]);
						break;

					case 'Object':
						values[i] = Object(value[1]);
						break;

					case 'BigInt':
						values[i] = BigInt(value[1]);
						break;

					case 'null':
						const object = Object.create(null);
				}
			} else {
				const array = new Array(value.length);

				for (let i = 0; i < value.length; i += 1) {
					const n = value[i];
					if (n === HOLE) continue;

					array[i] = get_value(n);
				}

				values[i] = array;
			}
		} else {
			/** @type {Record<string, any>} */
			const object = {};

			for (const key in value) {
				const n = value[key];
				object[key] = get_value(n);
			}

			values[i] = object;
		}
	}

	return values[0];
}
