/** @import { UnevalReplacer } from './types.js' */

import {
	DevalueError,
	enumerable_symbols,
	escaped,
	get_type,
	is_plain_object,
	is_primitive,
	stringify_key,
	stringify_primitive,
	stringify_string,
	valid_array_indices
} from './utils.js';
import { is_source, js, render_source, visit_source } from './javascript-source.js';

const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
const MAX_IIFE_PARAMS = 65534;
const unsafe_chars = /[<\b\f\n\r\t\0\u2028\u2029]/g;
const reserved =
	/^(?:do|if|in|for|int|let|new|try|var|byte|case|char|else|enum|goto|long|this|void|with|await|break|catch|class|const|final|float|short|super|throw|while|yield|delete|double|export|import|native|return|switch|throws|typeof|boolean|default|extends|finally|package|private|abstract|continue|debugger|function|volatile|interface|protected|transient|implements|instanceof|synchronized)$/;

/**
 * Turn a value into the JavaScript that creates an equivalent value
 * @param {any} value
 * @param {UnevalReplacer} [replacer]
 */
export function uneval(value, replacer) {
	const counts = new Map();

	/** @type {string[]} */
	const keys = [];

	const custom = new Map();
	/** @type {Map<any, any[]>} */
	const dependencies = new Map();

	/**
	 * @param {any} thing
	 * @param {any[]} [parent_dependencies]
	 */
	function walk(thing, parent_dependencies) {
		if (replacer && parent_dependencies !== undefined && !is_primitive(thing)) {
			parent_dependencies.push(thing);
		}

		if (!is_primitive(thing)) {
			if (counts.has(thing)) {
				counts.set(thing, counts.get(thing) + 1);
				return;
			}

			counts.set(thing, 1);
			/** @type {any[] | undefined} */
			const own_dependencies = replacer ? [] : undefined;
			if (own_dependencies) dependencies.set(thing, own_dependencies);

			if (replacer) {
				const source = replacer(thing, js);

				if (is_source(source)) {
					custom.set(thing, source);
					visit_source(source, (value) => walk(value, own_dependencies));
					return;
				}
				if (source !== undefined && source !== null && source !== false) {
					throw new TypeError('Invalid uneval replacer result');
				}
			}

			if (typeof thing === 'function') {
				throw new DevalueError(`Cannot stringify a function`, keys, thing, value);
			}

			const type = get_type(thing);

			switch (type) {
				case 'Number':
				case 'BigInt':
				case 'String':
				case 'Boolean':
				case 'Date':
				case 'RegExp':
				case 'URL':
				case 'URLSearchParams':
					return;

				case 'Array':
					/** @type {any[]} */ (thing).forEach((value, i) => {
						keys.push(`[${i}]`);
						walk(value, own_dependencies);
						keys.pop();
					});
					break;

				case 'Set':
					Array.from(thing).forEach((value) => walk(value, own_dependencies));
					break;

				case 'Map':
					for (const [key, value] of thing) {
						keys.push(`.get(${is_primitive(key) ? stringify_primitive(key) : '...'})`);
						walk(key, own_dependencies);
						walk(value, own_dependencies);
						keys.pop();
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
				case 'DataView':
					walk(thing.buffer, own_dependencies);
					return;

				case 'ArrayBuffer':
					return;

				case 'Temporal.Duration':
				case 'Temporal.Instant':
				case 'Temporal.PlainDate':
				case 'Temporal.PlainTime':
				case 'Temporal.PlainDateTime':
				case 'Temporal.PlainMonthDay':
				case 'Temporal.PlainYearMonth':
				case 'Temporal.ZonedDateTime':
					return;

				default:
					if (!is_plain_object(thing)) {
						throw new DevalueError(`Cannot stringify arbitrary non-POJOs`, keys, thing, value);
					}

					if (enumerable_symbols(thing).length > 0) {
						throw new DevalueError(`Cannot stringify POJOs with symbolic keys`, keys, thing, value);
					}

					for (const key of Object.keys(thing)) {
						if (key === '__proto__') {
							throw new DevalueError(
								`Cannot stringify objects with __proto__ keys`,
								keys,
								thing,
								value
							);
						}

						keys.push(stringify_key(key));
						walk(thing[key], own_dependencies);
						keys.pop();
					}
			}
		} else if (typeof thing === 'symbol') {
			throw new DevalueError(`Cannot stringify a Symbol primitive`, keys, thing, value);
		}
	}

	walk(value);

	return new Renderer(counts, custom, dependencies).render(value);
}

class Renderer {
	/** @type {Map<any, number>} */
	#counts;
	/** @type {Map<any, any>} */
	#custom;
	/** @type {Map<any, any[]>} */
	#dependencies;
	/** @type {Map<any, string>} */
	#names;

	/**
	 * @param {Map<any, number>} counts
	 * @param {Map<any, any>} custom
	 * @param {Map<any, any[]>} dependencies
	 */
	constructor(counts, custom, dependencies) {
		this.#counts = counts;
		this.#custom = custom;
		this.#dependencies = dependencies;
		this.#names = new Map();
	}

	/**
	 * @param {any} value
	 * @returns {string}
	 */
	render(value) {
		this.#assign_names();

		if (this.#custom.size > 0) {
			const analysis = new DependencyAnalyzer(this.#dependencies, this.#names).analyze();
			if (this.#names.size > 0) return this.#render_custom(value, analysis);
		} else if (this.#names.size > 0) {
			return this.#render_compact(value);
		}

		return this.#reference(value);
	}

	/** Assigns identifiers to values that must preserve shared identity. */
	#assign_names() {
		Array.from(this.#counts)
			.filter((entry) => entry[1] > 1)
			.sort((a, b) => b[1] - a[1])
			.forEach((entry, i) => {
				this.#names.set(entry[0], get_name(i));
			});
	}

	/**
	 * Renders a graph containing custom values. Mutable containers are created
	 * empty. For each group of values that may refer to one another, we then fill
	 * data needed immediately, create the remaining named values, and finally
	 * connect references within the group.
	 *
	 * @param {any} value
	 * @param {{ group_by_value: Map<any, number>, dependency_groups: any[][] }} analysis
	 * @returns {string}
	 */
	#render_custom(value, { group_by_value, dependency_groups }) {
		/** @type {string[]} */
		const params = [];
		/** @type {string[]} */
		const values = [];
		/** @type {string[]} */
		const declarations = [];
		/** @type {string[]} */
		const statements = [];
		const initialized_as_arguments = new Set();
		const dependency_states = new Map();

		// IIFE arguments are evaluated before its body. Empty mutable containers are
		// always safe there. Other values are safe only when their creation expression
		// does not refer to a name that will become available inside the IIFE.
		for (const [thing, name] of this.#names) {
			const mutable = this.#is_mutable(thing);
			const can_initialize =
				mutable || !this.#depends_on_name(thing, dependency_states);
      if (can_initialize) {
        initialized_as_arguments.add(thing);
				// this says "put this name into the parameters list"
        params.push(name);
				// this says "call the IIFE with this value", which "assigns" it to the parameter name
				values.push(mutable ? this.#allocate(thing) : this.#construct(thing));
			} else {
				declarations.push(name);
			}
		}

		for (let group = 0; group < dependency_groups.length; group += 1) {
			const group_values = /** @type {any[]} */ (dependency_groups[group]);

			// First fill references to earlier groups. A custom creation expression may
			// inspect this data, so it must already be present when that expression runs.
			for (const thing of group_values) {
				if (this.#names.has(thing) && this.#is_mutable(thing)) {
					this.#populate(thing, group, false, group_by_value, statements);
				}
			}

			const initializing = new Set();
			const initialized = new Set();
			for (const thing of group_values) {
				this.#initialize_group_value(
					thing,
					group,
					group_by_value,
					initialized_as_arguments,
					initializing,
					initialized,
					statements,
					value
				);
			}

			// Then connect references within this group. Waiting until now means every
			// named value in the cycle exists before a container points to it.
			for (const thing of group_values) {
				if (this.#names.has(thing) && this.#is_mutable(thing)) {
					this.#populate(thing, group, true, group_by_value, statements);
				}
			}
		}

		statements.push(`return ${this.#reference(value)}`);
		return this.#emit_iife(params, values, declarations, statements);
	}

	/**
	 * Renders a named graph without custom constructions using the compact path.
	 *
	 * @param {any} value
	 * @returns {string}
	 */
	#render_compact(value) {
		/** @type {string[]} */
		const params = [];
		/** @type {string[]} */
		const values = [];
		/** @type {string[]} */
		const reconstructions = [];
		/** @type {string[]} */
		const statements = [];

		this.#names.forEach((name, thing) => {
			params.push(name);

			if (is_primitive(thing)) {
				values.push(stringify_primitive(thing));
				return;
			}

			const type = get_type(thing);
			switch (type) {
				case 'Number':
				case 'String':
				case 'Boolean':
				case 'BigInt':
					values.push(`Object(${this.#reference(thing.valueOf())})`);
					break;

				case 'RegExp': {
					const { source, flags } = thing;
					values.push(
						flags
							? `new RegExp(${stringify_string(source)},"${flags}")`
							: `new RegExp(${stringify_string(source)})`
					);
					break;
				}

				case 'Date':
					values.push(`new Date(${thing.getTime()})`);
					break;

				case 'URL':
					values.push(`new URL(${stringify_string(thing.toString())})`);
					break;

				case 'URLSearchParams':
					values.push(`new URLSearchParams(${stringify_string(thing.toString())})`);
					break;

				case 'Array':
					values.push(`Array(${thing.length})`);
					/** @type {any[]} */ (thing).forEach((item, i) => {
						statements.push(`${name}[${i}]=${this.#reference(item)}`);
					});
					break;

				case 'Set': {
					values.push('new Set');
					const adds = Array.from(thing).map((item) => `.add(${this.#reference(item)})`);
					if (adds.length > 0) statements.push(name + adds.join(''));
					break;
				}

				case 'Map': {
					values.push('new Map');
					const sets = Array.from(thing).map(
						([key, item]) => `.set(${this.#reference(key)}, ${this.#reference(item)})`
					);
					if (sets.length > 0) statements.push(name + sets.join(''));
					break;
				}

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
					let expression = `new ${type}`;
					if (!this.#names.has(thing.buffer)) {
						expression += `([${stringify_typed_array_elements(type, thing.buffer)}])`;
					} else {
						expression += `(${this.#reference(thing.buffer)})`;
					}
					if (thing.byteLength !== thing.buffer.byteLength) {
						const start = thing.byteOffset / thing.BYTES_PER_ELEMENT;
						const end = start + thing.length;
						expression += `.subarray(${start},${end})`;
					}
					values.push('{}');
					reconstructions.push(`${name}=${expression}`);
					break;
				}

				case 'DataView': {
					let expression = 'new DataView';
					if (!this.#names.has(thing.buffer)) {
						expression += `(new Uint8Array([${new Uint8Array(thing.buffer)}]).buffer`;
					} else {
						expression += `(${this.#reference(thing.buffer)}`;
					}
					if (thing.byteLength !== thing.buffer.byteLength) {
						expression += `,${thing.byteOffset},${thing.byteLength}`;
					}
					values.push('{}');
					reconstructions.push(`${name}=${expression})`);
					break;
				}

				case 'ArrayBuffer':
					values.push(`new Uint8Array([${new Uint8Array(thing)}]).buffer`);
					break;

				case 'Temporal.Duration':
				case 'Temporal.Instant':
				case 'Temporal.PlainDate':
				case 'Temporal.PlainTime':
				case 'Temporal.PlainDateTime':
				case 'Temporal.PlainMonthDay':
				case 'Temporal.PlainYearMonth':
				case 'Temporal.ZonedDateTime':
					values.push(`${type}.from(${stringify_string(thing.toString())})`);
					break;

				default:
					values.push(Object.getPrototypeOf(thing) === null ? 'Object.create(null)' : '{}');
					Object.keys(thing).forEach((key) => {
						statements.push(`${name}${safe_prop(key)}=${this.#reference(thing[key])}`);
					});
			}
		});

		statements.push(`return ${this.#reference(value)}`);
		return this.#emit_iife(params, values, [], [...reconstructions, ...statements]);
	}

	/**
	 * Wraps named values and their initialization statements in an IIFE.
	 * Uses an array argument when the engine's parameter limit would be exceeded.
	 *
	 * @param {string[]} params
	 * @param {string[]} values
	 * @param {string[]} declarations
	 * @param {string[]} statements
	 * @returns {string}
	 */
	#emit_iife(params, values, declarations, statements) {
		const declaration = declarations.length > 0 ? `var ${declarations.join(',')};` : '';
		const body = declaration + statements.join(';');
		if (params.length > MAX_IIFE_PARAMS) {
			return `(function(){var[${params.join(',')}]=arguments[0];${body}}([${values.join(',')}]))`;
		}
		return `(function(${params.join(',')}){${body}}(${values.join(',')}))`;
	}

	/**
	 * Whether a value can be allocated empty and populated after construction.
	 *
	 * @param {any} thing
	 * @returns {boolean}
	 */
	#is_mutable(thing) {
		if (this.#custom.has(thing)) return false;
		const type = get_type(thing);
		return type === 'Array' || type === 'Set' || type === 'Map' || is_plain_object(thing);
	}

	/**
	 * Renders an empty shell for a mutable value involved in a named graph.
	 *
	 * @param {any} thing
	 * @returns {string}
	 */
	#allocate(thing) {
		switch (get_type(thing)) {
			case 'Array':
				return `Array(${thing.length})`;
			case 'Set':
				return 'new Set';
			case 'Map':
				return 'new Map';
			default:
				return Object.getPrototypeOf(thing) === null ? 'Object.create(null)' : '{}';
		}
	}

	/**
	 * Checks whether an atomic value's dependency closure reaches a named value.
	 * Such values must be constructed inside the IIFE rather than as arguments.
	 *
	 * @param {any} thing
	 * @param {Map<any, boolean>} states
	 */
  #depends_on_name(thing, states) {
    // this looks like it might be really inefficient, but because of memoization it's
    // actually linear in terms of both time and memory
		if (states.has(thing)) return states.get(thing);
		states.set(thing, false);
		for (const dependency of /** @type {any[]} */ (this.#dependencies.get(thing))) {
			if (this.#names.has(dependency) || this.#depends_on_name(dependency, states)) {
				states.set(thing, true);
				return true;
			}
		}
		return false;
	}

	/**
	 * Emits assignments that fill a mutable container. References outside the
	 * current group are filled first; references within it are filled only after
	 * every named value in that group has been created.
	 *
	 * @param {any} thing
	 * @param {number} group
	 * @param {boolean} within_group
	 * @param {Map<any, number>} group_by_value
	 * @param {string[]} statements
	 */
	#populate(thing, group, within_group, group_by_value, statements) {
		const name = this.#names.get(thing);
		/**
		 * @param {string} statement
		 * @param {any[]} values
		 */
		const add = (statement, values) => {
			const belongs_to_group = values.some(
				(value) => !is_primitive(value) && group_by_value.get(value) === group
			);
			if (belongs_to_group === within_group) statements.push(statement);
		};

		switch (get_type(thing)) {
			case 'Array':
				/** @type {any[]} */ (thing).forEach((value, i) => {
					add(`${name}[${i}]=${this.#reference(value)}`, [value]);
				});
				break;
			case 'Set':
				for (const value of thing) add(`${name}.add(${this.#reference(value)})`, [value]);
				break;
			case 'Map':
				for (const [key, value] of thing) {
					add(`${name}.set(${this.#reference(key)},${this.#reference(value)})`, [key, value]);
				}
				break;
			default:
				for (const key of Object.keys(thing)) {
					const value = thing[key];
					add(`${name}${safe_prop(key)}=${this.#reference(value)}`, [value]);
				}
		}
	}

	/**
	 * Creates a named non-mutable value after any non-mutable values it needs from
	 * the same group. Re-entering a value means the cycle has no mutable container
	 * that can be created empty and filled later.
	 *
	 * @param {any} thing
	 * @param {number} group
	 * @param {Map<any, number>} group_by_value
	 * @param {Set<any>} initialized_as_arguments
	 * @param {Set<any>} initializing
	 * @param {Set<any>} initialized
	 * @param {string[]} statements
	 * @param {any} root
	 */
	#initialize_group_value(
		thing,
		group,
		group_by_value,
		initialized_as_arguments,
		initializing,
		initialized,
		statements,
		root
	) {
		if (
			!this.#names.has(thing) ||
			this.#is_mutable(thing) ||
			initialized_as_arguments.has(thing)
		) {
			return;
		}
		if (initialized.has(thing)) return;
		if (initializing.has(thing)) {
			throw new DevalueError(
				'Cannot stringify a circular chain of atomic values',
				[],
				thing,
				root
			);
		}

		initializing.add(thing);
		for (const dependency of /** @type {any[]} */ (this.#dependencies.get(thing))) {
			if (group_by_value.get(dependency) === group && !this.#is_mutable(dependency)) {
				this.#initialize_group_value(
					dependency,
					group,
					group_by_value,
					initialized_as_arguments,
					initializing,
					initialized,
					statements,
					root
				);
			}
		}
		statements.push(`${this.#names.get(thing)}=${this.#construct(thing)}`);
		initializing.delete(thing);
		initialized.add(thing);
	}

	/**
	 * Renders a named reference when identity must be preserved, or constructs
	 * an unnamed value inline.
	 *
	 * @param {any} thing
	 * @returns {string}
	 */
	#reference = (thing) => {
		if (this.#names.has(thing)) {
			return /** @type {string} */ (this.#names.get(thing));
		}

		return this.#construct(thing);
	};

	/**
	 * Renders the expression that creates `thing` itself. Child values still go
	 * through `this.#reference`, so shared dependencies are rendered as references.
	 *
	 * @param {any} thing
	 * @returns {string}
	 */
	#construct(thing) {
		if (is_primitive(thing)) {
			return stringify_primitive(thing);
		}

		if (this.#custom.has(thing)) {
			return `(${render_source(this.#custom.get(thing), this.#reference)})`;
		}

		const type = get_type(thing);

		switch (type) {
			case 'Number':
			case 'String':
			case 'Boolean':
			case 'BigInt':
				return `Object(${this.#reference(thing.valueOf())})`;

			case 'RegExp':
				const { source, flags } = thing;
				return flags
					? `new RegExp(${stringify_string(source)},"${flags}")`
					: `new RegExp(${stringify_string(source)})`;

			case 'Date':
				return `new Date(${thing.getTime()})`;

			case 'URL':
				return `new URL(${stringify_string(thing.toString())})`;

			case 'URLSearchParams':
				return `new URLSearchParams(${stringify_string(thing.toString())})`;

			case 'Array': {
				// For dense arrays (no holes), we iterate normally.
				// When we encounter the first hole, we call Object.keys
				// to determine the sparseness, then decide between:
				//   - Array literal with holes: [,"a",,] (default)
				//   - Object.assign: Object.assign(Array(n),{...}) (for very sparse arrays)
				// Only the Object.assign path avoids iterating every slot, which
				// is what protects against the DoS of e.g. `arr[1000000] = 1`.
				let has_holes = false;

				let result = '[';

				for (let i = 0; i < thing.length; i += 1) {
					if (i > 0) result += ',';

					if (Object.hasOwn(thing, i)) {
						result += this.#reference(thing[i]);
					} else if (!has_holes) {
						// Decide between array literal and Object.assign.
						//
						// Array literal: holes are consecutive commas.
						// For example, [, "a", ,] is written as [,"a",,].
						// Each hole costs 1 char (a comma).
						//
						// Object.assign: populated indices are listed explicitly.
						// For example, [, "a", ,] would be written as
						// Object.assign(Array(3),{1:"a"}). This avoids paying
						// per-hole, but has a large fixed overhead for the
						// "Object.assign(Array(n),{...})" wrapper, and each
						// element costs extra chars for its index and colon.
						//
						// The serialized values are the same size either way, so
						// the choice comes down to the structural overhead:
						//
						//   Array literal overhead:
						//     1 char per element or hole (comma separators)
						//     + 2 chars for "[" and "]"
						//     = L + 2
						//
						//   Object.assign overhead:
						//     "Object.assign(Array(" — 20 chars
						//     + length              — d chars
						//     + "),{"               — 3 chars
						//     + for each populated element:
						//       index + ":" + ","   — (d + 2) chars
						//     + "})"                — 2 chars
						//     = (25 + d) + P * (d + 2)
						//
						// where L is the array length, P is the number of
						// populated elements, and d is the number of digits
						// in L (an upper bound on the digits in any index).
						//
						// Object.assign is cheaper when:
						//   (25 + d) + P * (d + 2) < L + 2
						const populated_keys = valid_array_indices(thing);
						const population = populated_keys.length;
						const d = String(thing.length).length;

						const hole_cost = thing.length + 2;
						const sparse_cost = 25 + d + population * (d + 2);

						if (hole_cost > sparse_cost) {
							const entries = populated_keys.map((k) => `${k}:${this.#reference(thing[k])}`).join(',');
							return `Object.assign(Array(${thing.length}),{${entries}})`;
						}

						has_holes = true;
					}
					// else: already decided on array literal, hole is just an empty slot
					// (the comma separator is all we need — no content for this position)
				}

				const tail = thing.length === 0 || thing.length - 1 in thing ? '' : ',';
				return result + tail + ']';
			}

			case 'Set':
			case 'Map':
				return `new ${type}([${Array.from(thing).map(this.#reference).join(',')}])`;

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
				let str = `new ${type}`;

				if (!this.#names.has(thing.buffer)) {
					str += `([${stringify_typed_array_elements(type, thing.buffer)}])`;
				} else {
					str += `(${this.#reference(thing.buffer)})`;
				}

				// handle subarrays
				if (thing.byteLength !== thing.buffer.byteLength) {
					const start = thing.byteOffset / thing.BYTES_PER_ELEMENT;
					const end = start + thing.length;
					str += `.subarray(${start},${end})`;
				}

				return str;
			}

			case 'DataView': {
				let str = `new DataView`;

				if (!this.#names.has(thing.buffer)) {
					str += `(new Uint8Array([${new Uint8Array(thing.buffer)}]).buffer`;
				} else {
					str += `(${this.#reference(thing.buffer)}`;
				}

				// handle subviews
				if (thing.byteLength !== thing.buffer.byteLength) {
					str += `,${thing.byteOffset},${thing.byteLength}`;
				}

				return str + ')';
			}

			case 'ArrayBuffer': {
				const ui8 = new Uint8Array(thing);
				return `new Uint8Array([${ui8.toString()}]).buffer`;
			}

			case 'Temporal.Duration':
			case 'Temporal.Instant':
			case 'Temporal.PlainDate':
			case 'Temporal.PlainTime':
			case 'Temporal.PlainDateTime':
			case 'Temporal.PlainMonthDay':
			case 'Temporal.PlainYearMonth':
			case 'Temporal.ZonedDateTime':
				return `${type}.from(${stringify_string(thing.toString())})`;

			default:
				const keys = Object.keys(thing);
				const obj = keys.map((key) => `${safe_key(key)}:${this.#reference(thing[key])}`).join(',');
				const proto = Object.getPrototypeOf(thing);
				if (proto === null) {
					return keys.length > 0 ? `{${obj},__proto__:null}` : `{__proto__:null}`;
				}

				return `{${obj}}`;
		}
	}
}

/**
 * Splits values into mutually reachable dependency groups. A group with
 * multiple values (or a value that depends on itself) represents a cycle.
 * Groups are completed with dependencies before dependants, which is also the
 * construction order the emitter needs.
 */
class DependencyAnalyzer {
	/** @type {Map<any, any[]>} */
	#dependencies;
	/** @type {Map<any, string>} */
	#names;
	/** @type {Map<any, number>} */
	#group_by_value;
	/** @type {any[][]} */
	#dependency_groups;
	/** @type {number} */
	#index;
	/** @type {Map<any, number>} */
	#indices;
	/** @type {Map<any, number>} */
	#lowlinks;
	/** @type {any[]} */
	#active_stack;
	/** @type {Set<any>} */
	#active_values;

	/**
	 * @param {Map<any, any[]>} dependencies
	 * @param {Map<any, string>} names
	 */
	constructor(dependencies, names) {
		this.#dependencies = dependencies;
		this.#names = names;
		// Map each value to the dependency group that will construct it.
		this.#group_by_value = new Map();
		// Groups are completed in dependency-first order.
		this.#dependency_groups = [];
		// Give each newly discovered value the next traversal index.
		this.#index = 0;
		// Record when each value was first encountered in the depth-first search.
		this.#indices = new Map();
		// Record the earliest active index reachable from each value.
		this.#lowlinks = new Map();

		// Keep unresolved values in traversal order, plus a set for fast lookup.
		this.#active_stack = [];
		this.#active_values = new Set();
	}

	analyze() {
		// Start another search for any values not reached by an earlier root.
		for (const thing of this.#dependencies.keys()) {
			if (!this.#indices.has(thing)) this.#connect(thing);
		}

		// Cyclic values need names even when they occur only once in the input.
		for (const group_values of this.#dependency_groups) {
			const cyclic =
				group_values.length > 1 ||
				/** @type {any[]} */ (this.#dependencies.get(group_values[0])).includes(group_values[0]);
			if (cyclic) {
				for (const thing of group_values) {
					if (!this.#names.has(thing)) this.#names.set(thing, get_name(this.#names.size));
				}
			}
		}

		return {
			group_by_value: this.#group_by_value,
			dependency_groups: this.#dependency_groups
		};
	}

	/** @param {any} thing */
	#connect(thing) {
		// Mark the value as discovered and part of the unresolved search.
		this.#indices.set(thing, this.#index);
		// A value's lowlink starts at its index and is lowered when we find
		// connections to values discovered before it.
		this.#lowlinks.set(thing, this.#index);
		this.#index += 1;
		this.#active_stack.push(thing);
		this.#active_values.add(thing);

		for (const dependency of /** @type {any[]} */ (this.#dependencies.get(thing))) {
			if (!this.#indices.has(dependency)) {
				// Discover the dependency, then carry its earliest connection back.
				this.#connect(dependency);
				this.#lowlinks.set(
					thing,
					Math.min(
						/** @type {number} */ (this.#lowlinks.get(thing)),
						/** @type {number} */ (this.#lowlinks.get(dependency))
					)
				);
			} else if (this.#active_values.has(dependency)) {
				// A previously visited active value closes a path within this group.
				this.#lowlinks.set(
					thing,
					Math.min(
						/** @type {number} */ (this.#lowlinks.get(thing)),
						/** @type {number} */ (this.#indices.get(dependency))
					)
				);
			}
			// A visited inactive dependency belongs to a completed group.
		}

		// Reaching no earlier active value means this value starts a complete group.
		if (this.#lowlinks.get(thing) === this.#indices.get(thing)) {
			const group_values = [];
			let member = thing;
			// Pop every mutually reachable value through the group root.
			do {
				member = /** @type {any} */ (this.#active_stack.pop());
				this.#active_values.delete(member);
				this.#group_by_value.set(member, this.#dependency_groups.length);
				group_values.push(member);
			} while (member !== thing);
			this.#dependency_groups.push(group_values);
		}
	}
}

/**
 * Serialize the elements of `buffer`, read as `type`, as a comma-separated list.
 * The view is created from `type` rather than from the serialized value's own
 * constructor, which may be a subclass like Node's `Buffer` whose `toString`
 * decodes the bytes instead of listing them.
 * `BigInt64Array`/`BigUint64Array` elements are bigints and must be written
 * with an `n` suffix, otherwise the emitted `new BigInt64Array([...])` throws.
 * @param {string} type
 * @param {ArrayBufferLike} buffer
 */
function stringify_typed_array_elements(type, buffer) {
	const array = new (/** @type {any} */ (globalThis)[type])(buffer);

	if (type === 'BigInt64Array' || type === 'BigUint64Array') {
		return Array.from(array, (element) => `${element}n`).join(',');
	}

	// Float arrays can hold `-0`, which `toString()` collapses to `"0"`, silently
	// losing the sign on round-trip. Emit `-0` explicitly for those elements.
	if (
		array instanceof Float32Array ||
		array instanceof Float64Array ||
		(typeof Float16Array !== 'undefined' && array instanceof Float16Array)
	) {
		return Array.from(array, (element) => (Object.is(element, -0) ? '-0' : `${element}`)).join(',');
	}

	return array.toString();
}

/** @param {number} num */
function get_name(num) {
	let name = '';

	do {
		name = chars[num % chars.length] + name;
		num = ~~(num / chars.length) - 1;
	} while (num >= 0);

	return reserved.test(name) ? `${name}0` : name;
}

/** @param {string} c */
function escape_unsafe_char(c) {
	return escaped[c] || c;
}

/** @param {string} str */
function escape_unsafe_chars(str) {
	return str.replace(unsafe_chars, escape_unsafe_char);
}

/** @param {string} key */
function safe_key(key) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key) ? key : escape_unsafe_chars(JSON.stringify(key));
}

/** @param {string} key */
function safe_prop(key) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key)
		? `.${key}`
		: `[${escape_unsafe_chars(JSON.stringify(key))}]`;
}
