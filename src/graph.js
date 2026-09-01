import {
	DevalueError,
	enumerable_symbols,
	get_type,
	is_plain_object,
	is_primitive,
	stringify_key,
	stringify_primitive,
	stringify_string,
	valid_array_indices
} from './utils.js';

/** @typedef {{ node: number } | { value: unknown }} ValueRef */
/** @typedef {{ kind: string, data: any, edges: ValueRef[] }} Classification */
/** @typedef {{ discover: (value: unknown) => GraphNode | undefined, edge: (value: unknown) => ValueRef }} Capture */
/**
 * A source expression for reaching an object created by an earlier streamed region.
 *
 * @typedef {object} Reference
 * @property {string} root Expression that evaluates to the reference's starting object.
 * @property {string[]} segments Property-access segments appended to `root`.
 */
/**
 * A captured non-primitive value. Discovery fills `value` through `edges`; streaming
 * emission temporarily fills `epoch` through `rendering` while planning its output.
 *
 * @typedef {object} GraphNode
 * @property {number} id Index of this node in `Graph.nodes`; non-primitive `ValueRef`s store this number.
 * @property {any} value The original value represented by this node. Its contents are not read again during emission.
 * @property {string} kind The value type used to choose how it is reconstructed, such as `Array`, `Map`, or `Date`.
 * @property {any} data The captured type-specific data needed to reconstruct the value.
 * @property {ValueRef[]} edges References to every captured value contained by this value.
 * @property {number} epoch Identifies the emission walk for which the following planning fields are valid.
 * @property {number} position This node's position in the current emission's child-before-parent order.
 * @property {number} uses Number of references to this node in the current emission. Multiple uses require a shared temporary variable.
 * @property {boolean} hoisted Whether this node must be assigned to a temporary variable instead of being written inline.
 * @property {boolean} early Whether an empty container must be created before normal declarations so an earlier constructor can refer to it.
 * @property {number} latest Furthest declaration position reached by expanding this node inline; used to avoid references to variables not declared yet.
 * @property {string} name Temporary variable name assigned when `hoisted` is true, or an empty string when the node is inlined.
 * @property {boolean} rendering Whether this node is currently being expanded inline; guards against unexpected recursive expansion.
 * @property {Reference} [reference] A reference emitted by an earlier streaming region that can be reused by later regions.
 * @property {boolean} [opaque] Whether emission must preserve this node as a named value rather than inspect and duplicate it inline.
 */
/**
 * The graph sizes at the start of a discovery operation. Rollback removes everything
 * appended after these positions.
 *
 * @typedef {object} Region
 * @property {number} nodes Length of `Graph.nodes` when the region began.
 * @property {number} added Length of `Graph.added` when the region began.
 */
/**
 * A reusable snapshot of the non-primitive values discovered during one stream session.
 *
 * @typedef {object} Graph
 * @property {unknown} root_value The initial value, retained to provide context in serialization errors.
 * @property {GraphNode[]} nodes Every captured non-primitive value, in discovery order. A node's `id` is its index here.
 * @property {Map<object, GraphNode>} identities Maps each original object to its single graph node, preserving shared references and cycles.
 * @property {(value: unknown, node: GraphNode, capture: Capture) => Classification | false} try_classify Handles stream-specific values before built-in discovery.
 * @property {Capture} capture Stable recursive capture operations exposed to the classifier.
 * @property {unknown[]} keys Raw property, array-index, or map-key segments leading to the value currently being discovered.
 * @property {number[]} key_kinds How each entry in `keys` should be formatted in an error path: array index, property, or map key.
 * @property {object[]} added Identity-map keys added by open regions, in insertion order, so rollback can delete them.
 */

const ARRAY_INDEX = 0;
const OBJECT_KEY = 1;
const MAP_KEY = 2;

/**
 * Builds a snapshot of a value and everything it contains. Each object gets one node,
 * even when it appears more than once, and each node records the values it refers to.
 * Later code can therefore generate output from this snapshot without reading the
 * original objects again.
 *
 * Streaming output reuses this graph across multiple emitted values. Before emitting
 * one value, `uneval-stream` walks only the nodes reachable from that value and works
 * out how to reproduce their object identity. A value used once can usually be written
 * inline, while a shared or cyclic value needs a temporary variable so every reference
 * points to the same object. The `epoch` through `rendering` fields on each node hold
 * this per-emission analysis. They are reset for nodes in the current walk; `epoch`
 * distinguishes those results from values left on nodes by previous walks.
 *
 * Callers group each independently recoverable capture in a region before calling
 * `discover`. That region includes every node added while recursively walking the value.
 * We do not tag each addition; instead, the region records the starting lengths of
 * `nodes` and `added`. Anything appended after those positions belongs to the region.
 * If capture fails, the caller removes those additions and their identity entries,
 * leaving the graph as it was before the capture began.
 *
 * @param {unknown} root
 * @param {(value: unknown, node: GraphNode, capture: Capture) => Classification | false} try_classify
 * @returns {Graph}
 */
export function create_graph(root, try_classify) {
	/** @type {Graph} */
	const graph = {
		root_value: root,
		nodes: [],
		identities: new Map(),
		try_classify,
		capture: /** @type {Capture} */ (undefined),
		keys: [],
		key_kinds: [],
		added: []
	};
	graph.capture = {
		discover: (value) => discover(graph, value),
		edge: (value) => edge(graph, value)
	};
	return graph;
}

/** @param {Graph} graph */
export function checkpoint(graph) {
	return { nodes: graph.nodes.length, added: graph.added.length };
}

/**
 * @param {Graph} graph
 * @param {Region} region
 */
export function release_checkpoint(graph, region) {
	graph.added.length = region.added;
}

/**
 * @param {Graph} graph
 * @param {Region} region
 */
export function rollback(graph, region) {
	for (let i = graph.added.length - 1; i >= region.added; i -= 1) {
		graph.identities.delete(graph.added[i]);
	}
	graph.added.length = region.added;
	graph.nodes.length = region.nodes;
}

/**
 * Discovers a value into the graph and returns its canonical node, or undefined for primitives.
 *
 * @param {Graph} graph
 * @param {unknown} value
 * @returns {GraphNode | undefined}
 */
export function discover(graph, value) {
	if (is_primitive(value)) {
		if (typeof value === 'symbol') throw error(graph, 'Cannot stringify a Symbol primitive', value);
		return undefined;
	}

	const identity = /** @type {object} */ (value);
	const existing = graph.identities.get(identity);
	if (existing) return existing;

	/** @type {GraphNode} */
	const node = {
		id: graph.nodes.length,
		value,
		kind: '',
		data: undefined,
		edges: [],
		epoch: 0,
		position: 0,
		uses: 0,
		hoisted: false,
		early: false,
		latest: -1,
		name: '',
		rendering: false
	};
	graph.nodes.push(node);
	graph.identities.set(identity, node);
	graph.added.push(identity);

	const classification = graph.try_classify(value, node, graph.capture);
	if (classification) {
		node.kind = classification.kind;
		node.data = classification.data;
		node.edges = classification.edges;
		return node;
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
			/** @type {Array<[keyof unknown[], ValueRef]>} */
			const entries = [];
			for (const key of valid_array_indices(array)) {
				graph.keys.push(key);
				graph.key_kinds.push(ARRAY_INDEX);
				const child = edge(graph, array[key]);
				graph.keys.pop();
				graph.key_kinds.pop();
				entries.push([key, child]);
				node.edges.push(child);
			}
			node.data = { length: array.length, entries };
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
				graph.key_kinds.push(MAP_KEY);
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
				graph.key_kinds.push(OBJECT_KEY);
				const child = edge(graph, object[key]);
				graph.keys.pop();
				graph.key_kinds.pop();
				entries.push([key, child]);
				node.edges.push(child);
			}
			node.kind = Object.getPrototypeOf(object) === null ? 'NullObject' : 'Object';
			node.data = { entries };
		}
	}

	return node;
}

/**
 * @param {Graph} graph
 * @param {unknown} value
 * @returns {ValueRef}
 */
function edge(graph, value) {
	const node = discover(graph, value);
	return node ? { node: node.id } : { value };
}

/**
 * @param {Graph} graph
 * @param {string} message
 * @param {unknown} value
 */
function error(graph, message, value) {
	// Path segments are stored raw during discovery (formatting per child is pure
	// overhead on the happy path) and rendered only when an error is actually thrown.
	const keys = graph.keys.map((key, index) => {
		const kind = graph.key_kinds[index];
		if (kind === ARRAY_INDEX) return `[${key}]`;
		if (kind === OBJECT_KEY) return stringify_key(/** @type {string} */ (key));
		return `.get(${is_primitive(key) ? stringify_primitive(key) : '...'})`;
	});
	return new DevalueError(message, keys, value, graph.root_value);
}
