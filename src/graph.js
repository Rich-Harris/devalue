import {
	DevalueError,
	enumerable_symbols,
	get_type,
	is_plain_object,
	is_primitive,
	stringify_key,
	stringify_string,
	valid_array_indices
} from './utils.js';

/**
 * Creates an append-only identity graph that records canonical container edges so
 * emission and future asynchronous regions read a capture-time snapshot.
 *
 * Regions make discovery transactional without journaling: every structural write is an
 * append (a node pushed onto `nodes`, an identity key pushed onto `added`), so committing
 * is free and rolling back truncates both arrays and deletes the appended identity keys.
 *
 * @param {{
 *   root: unknown,
 *   replacer?: (value: any, uneval: (value: any) => string) => string | void,
 *   replace?: (value: unknown, node: GraphNode, graph: Graph) => boolean,
 *   uneval?: (value: any) => string
 * }} options
 * @returns {Graph}
 */
export function create_graph(options) {
	return {
		root_value: options.root,
		nodes: [],
		identities: new Map(),
		replacer: options.replacer,
		replace: options.replace,
		uneval: options.uneval,
		keys: [],
		key_kinds: [],
		added: [],
		transaction_depth: 0
	};
}

/** @param {Graph} graph */
export function begin_region(graph) {
	graph.transaction_depth += 1;
	return { nodes: graph.nodes.length, added: graph.added.length };
}

/** @param {Graph} graph @param {Region} region */
export function commit_region(graph, region) {
	graph.transaction_depth -= 1;
	// Nested regions leave their appends in place so an enclosing region can still
	// roll them back; the outermost commit discards the bookkeeping wholesale.
	if (graph.transaction_depth === 0) graph.added.length = region.added;
}

/** @param {Graph} graph @param {Region} region */
export function rollback_region(graph, region) {
	for (let i = graph.added.length - 1; i >= region.added; i -= 1) {
		graph.identities.delete(graph.added[i]);
	}
	graph.added.length = region.added;
	graph.nodes.length = region.nodes;
	graph.transaction_depth -= 1;
}

/**
 * Discovers a value into the graph and returns its canonical node, or undefined for primitives.
 *
 * @param {Graph} graph
 * @param {unknown} value
 * @param {boolean} [root]
 * @returns {GraphNode | undefined}
 */
export function discover(graph, value, root = false) {
	if (is_primitive(value)) {
		if (typeof value === 'symbol') throw error(graph, 'Cannot stringify a Symbol primitive', value);
		return undefined;
	}

	const identity = /** @type {object} */ (value);
	const existing = graph.identities.get(identity);
	if (existing) return existing;

	// The node and its identity entry are created inside this region, so rollback
	// discards them wholesale; the node's own fields can be assigned directly.
	const region = begin_region(graph);
	const node = /** @type {GraphNode} */ ({
		id: graph.nodes.length,
		value,
		kind: '',
		data: undefined,
		edges: [],
		// Region-scratch fields used by emission passes; declared here so every node
		// shares one hidden class. `epoch` tags which emission pass the rest belong to.
		epoch: 0,
		position: 0,
		uses: 0,
		hoisted: false,
		early: false,
		latest: -1,
		name: '',
		rendering: false
	});
	graph.nodes.push(node);
	graph.identities.set(identity, node);
	graph.added.push(identity);

	try {
		if (graph.replace?.(value, node, graph)) {
			commit_region(graph, region);
			return node;
		}

		if (graph.replacer) {
			const source = graph.replacer(value, (/** @type {unknown} */ child) => {
				if (!graph.uneval) throw new Error('Missing custom uneval callback');
				return graph.uneval(child);
			});
			if (typeof source === 'string') {
				node.kind = 'Custom';
				node.data = { source };
				commit_region(graph, region);
				return node;
			}
		}

		if (typeof value === 'function') throw error(graph, 'Cannot stringify a function', value);
		const type = get_type(value);
		node.kind = type;

		switch (type) {
			case 'Number':
			case 'String':
			case 'Boolean':
			case 'BigInt':
				node.data = { value: value.valueOf() };
				break;
			case 'Date':
				node.data = { time: /** @type {Date} */ (value).getTime() };
				break;
			case 'RegExp': {
				const regexp = /** @type {RegExp} */ (value);
				node.data = { source: regexp.source, flags: regexp.flags };
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
			case 'Temporal.ZonedDateTime':
				node.data = { source: String(value) };
				break;
			case 'ArrayBuffer':
				node.data = { bytes: new Uint8Array(/** @type {ArrayBuffer} */ (value)) };
				break;
			case 'Array': {
				const array = /** @type {unknown[]} */ (value);
				/** @type {Array<[string, ValueRef]>} */
				const entries = [];
				for (const key of valid_array_indices(array)) {
					graph.keys.push(key);
					graph.key_kinds.push(0);
					const child = edge(graph, array[Number(key)]);
					graph.keys.pop();
					graph.key_kinds.pop();
					entries.push([key, child]);
				}
				node.data = { length: array.length, entries };
				node.edges = entries.map((entry) => entry[1]);
				break;
			}
			case 'Set': {
				const values = Array.from(/** @type {Set<unknown>} */ (value), (child) => edge(graph, child));
				node.data = { values };
				node.edges = values;
				break;
			}
			case 'Map': {
				const entries = [];
				for (const [key, child] of /** @type {Map<unknown, unknown>} */ (value)) {
					graph.keys.push(key);
					graph.key_kinds.push(2);
					entries.push([edge(graph, key), edge(graph, child)]);
					graph.keys.pop();
					graph.key_kinds.pop();
				}
				node.data = { entries };
				node.edges = entries.flat();
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
			case 'BigUint64Array':
			case 'DataView': {
				const view = /** @type {ArrayBufferView & { length?: number }} */ (value);
				const buffer = edge(graph, view.buffer);
				node.data = {
					buffer,
					byteOffset: view.byteOffset,
					byteLength: view.byteLength,
					length: view.length
				};
				node.edges = [buffer];
				break;
			}
			default: {
				const object = /** @type {Record<string | symbol, unknown>} */ (value);
				if (!is_plain_object(object)) throw error(graph, 'Cannot stringify arbitrary non-POJOs', value);
				if (enumerable_symbols(object).length) {
					throw error(graph, 'Cannot stringify POJOs with symbolic keys', value);
				}
				/** @type {Array<[string, ValueRef]>} */
				const entries = [];
				for (const key of Object.keys(object)) {
					if (key === '__proto__') {
						throw error(graph, 'Cannot stringify objects with __proto__ keys', value);
					}
					graph.keys.push(key);
					graph.key_kinds.push(1);
					const child = edge(graph, object[key]);
					graph.keys.pop();
					graph.key_kinds.pop();
					entries.push([key, child]);
				}
				node.kind = Object.getPrototypeOf(object) === null ? 'NullObject' : 'Object';
				node.data = { entries };
				node.edges = entries.map((entry) => entry[1]);
			}
		}

		commit_region(graph, region);
		return node;
	} catch (cause) {
		rollback_region(graph, region);
		throw cause;
	}
}

/** @param {Graph} graph @param {unknown} value @returns {ValueRef} */
function edge(graph, value) {
	const node = discover(graph, value);
	return node ? { node: node.id } : { value };
}

/** @param {Graph} graph @param {string} message @param {unknown} value */
function error(graph, message, value) {
	// Path segments are stored raw during discovery (formatting per child is pure
	// overhead on the happy path) and rendered only when an error is actually thrown.
	const keys = graph.keys.map((key, index) => {
		const kind = graph.key_kinds[index];
		if (kind === 0) return `[${key}]`;
		if (kind === 1) return stringify_key(/** @type {string} */ (key));
		return `.get(${is_primitive(key) ? primitive(key) : '...'})`;
	});
	return new DevalueError(message, keys, value, graph.root_value);
}

/** @param {unknown} value */
function primitive(value) {
	if (typeof value === 'string') return stringify_string(value);
	if (value === undefined) return 'void 0';
	if (value === 0 && 1 / value < 0) return '-0';
	if (typeof value === 'number') return String(value).replace(/^(-)?0\./, '$1.');
	if (typeof value === 'bigint') return `${value}n`;
	return String(value);
}

/** @typedef {{ node: number } | { value: unknown }} ValueRef */
/** @typedef {{ id: number, value: any, kind: string, data: any, edges: ValueRef[], epoch: number, position: number, uses: number, hoisted: boolean, early: boolean, latest: number, name: string, rendering: boolean, reference?: any, opaque?: boolean }} GraphNode */
/** @typedef {{ nodes: number, added: number }} Region */
/** @typedef {{ root_value: unknown, nodes: GraphNode[], identities: Map<object, GraphNode>, replacer?: Function, replace?: Function, uneval?: Function, keys: unknown[], key_kinds: number[], added: object[], transaction_depth: number }} Graph */
