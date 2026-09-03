import {
	DevalueError,
	enumerable_symbols,
	get_type,
	is_plain_object,
	is_primitive,
	stringify_key,
	stringify_primitive,
	valid_array_indices
} from './utils.js';

/** @typedef {{ node: number } | { value: unknown }} ValueRef */
/**
 * A stream-specific reconstruction plan returned instead of built-in discovery.
 * A custom classifier discovers any children through its `CapturedGraph` argument and returns
 * their direct reconstruction dependencies in `edges`.
 * @typedef {{ kind: string, data: any, edges: ValueRef[] }} Classification
 */
/**
 * A source expression for reaching a non-primitive value created on the client.
 *
 * @typedef {object} ClientPath
 * @property {string} root Expression that evaluates to the reference's starting object.
 * @property {string[]} segments Property-access segments appended to `root`.
 */
/**
 * A captured non-primitive value. Discovery fills `value` through `edges`; streaming
 * emission temporarily fills `region_id` through `rendering` while planning its output.
 *
 * @typedef {object} CapturedNode
 * @property {number} id Index of this node in `CapturedGraph.nodes`; non-primitive `ValueRef`s store this number.
 * @property {any} value The original value represented by this node. Its contents are not read again during emission.
 * @property {string} kind The reconstruction tag, such as `Array`, `Map`, `Custom`, or `Async`.
 * @property {any} data Captured reconstruction- or classification-specific data.
 * @property {ValueRef[]} edges Direct captured dependencies needed to reconstruct this value.
 * @property {number} region_id Identifies the emitted region for which the following planning fields are valid.
 * @property {number} position This node's position in the current emission's child-before-parent order.
 * @property {number} uses Number of references to this node in the current emission.
 * @property {boolean} hoisted Whether this node must be assigned to a temporary variable.
 * @property {boolean} early Whether an empty container must be created before normal declarations.
 * @property {number} latest Furthest declaration position reached by expanding this node inline.
 * @property {string} name Temporary variable name, or an empty string when the node is inlined.
 * @property {boolean} rendering Whether this node is currently being expanded inline.
 * @property {number} opaque Number of custom constructors embedding this node; when positive, emission must preserve it as a named value rather than duplicate it inline.
 */
/**
 * A reusable snapshot of the non-primitive values discovered during one stream session.
 *
 * @typedef {object} CapturedGraph
 * @property {unknown} root_value The initial value, retained to provide context in serialization errors.
 * @property {CapturedNode[]} nodes Every captured non-primitive value, in discovery order. A node's `id` is its index here.
 * @property {Map<object, CapturedNode>} identities Maps each original non-primitive identity to its canonical node, preserving sharing and cycles.
 * @property {(value: unknown, node: CapturedNode) => Classification} classify Produces a custom or built-in reconstruction plan for a reserved node.
 * @property {unknown[]} keys Raw property, array-index, or map-key segments leading to the value currently being discovered.
 * @property {number[]} key_kinds How each entry in `keys` should be formatted in an error path: array index, property, or map key.
 */

const ARRAY_INDEX = 0;
const OBJECT_KEY = 1;
const MAP_KEY = 2;

/**
 * Builds a snapshot of a value and everything it contains. Each non-primitive identity gets one node,
 * even when it appears more than once, and each node records the values it refers to.
 * Later code can therefore generate output from this snapshot without reading the
 * original objects again.
 *
 * Streaming output reuses this graph across multiple emitted values. Before emitting
 * one value, `uneval-stream` walks only the nodes reachable from that value and works
 * out how to reproduce their object identity. A value used once can usually be written
 * inline, while a shared or cyclic value needs a temporary variable so every reference
 * points to the same object. The `region_id` through `rendering` fields on each node hold
 * this per-emission analysis. They are reset for nodes in the current walk; `region_id`
 * distinguishes those results from values left on nodes by previous walks.
 *
 * The graph is append-only. A caller that needs atomic discovery records `nodes.length`
 * before calling `discover` and passes it to `rollback` if discovery throws: every node
 * appended since is removed along with its identity entry, so no per-addition tagging
 * is needed and the success path pays nothing.
 *
 * @param {unknown} root
 * @param {(value: unknown, node: CapturedNode, graph: CapturedGraph) => Classification | false} custom_classify
 * @returns {CapturedGraph}
 */
export function create_captured_graph(root, custom_classify) {
	/** @type {CapturedGraph} */
	const graph = {
		root_value: root,
		nodes: [],
		identities: new Map(),
		classify: (value, node) => custom_classify(value, node, graph) || builtin_classify(graph, value),
		keys: [],
		key_kinds: []
	};
	return graph;
}

/**
 * Removes every node appended since `mark` (a previously observed `nodes.length`) and
 * clears the error-path stack left behind by an interrupted walk.
 *
 * @param {CapturedGraph} graph
 * @param {number} mark
 */
export function rollback(graph, mark) {
	const nodes = graph.nodes;
	const identities = graph.identities;
	for (let i = nodes.length - 1; i >= mark; i--) identities.delete(nodes[i].value);
	nodes.length = mark;
	graph.keys.length = 0;
	graph.key_kinds.length = 0;
}

/**
 * Discovers a value into the graph and returns its canonical node, or undefined for primitives.
 * Top-level discovery is never re-entered while in progress; nested calls from a custom
 * classifier share the walk in progress.
 *
 * @param {CapturedGraph} graph
 * @param {unknown} value
 * @returns {CapturedNode | undefined}
 */
export function discover(graph, value) {
	if (is_primitive(value)) {
		if (typeof value === 'symbol') throw error(graph, 'Cannot stringify a Symbol primitive', value);
		return undefined;
	}

	const identity = /** @type {object} */ (value);
	const existing = graph.identities.get(identity);
	if (existing) return existing;

	/** @type {CapturedNode} */
	const node = {
		id: graph.nodes.length,
		value,
		kind: '',
		data: undefined,
		edges: [],
		opaque: 0,
		region_id: 0,
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

	const classification = graph.classify(value, node);
	node.kind = classification.kind;
	node.data = classification.data;
	node.edges = classification.edges;
	return node;
}

/**
 * Captures the built-in reconstruction plan for a reserved non-primitive value.
 * @param {CapturedGraph} graph
 * @param {any} value
 * @returns {Classification}
 */
function builtin_classify(graph, value) {
	if (typeof value === 'function') throw error(graph, 'Cannot stringify a function', value);
	const type = get_type(value);

	switch (type) {
		case 'Number':
		case 'String':
		case 'Boolean':
		case 'BigInt':
			return { kind: type, data: { value: value.valueOf() }, edges: [] };
		case 'Date':
			return { kind: type, data: { time: /** @type {Date} */ (value).getTime() }, edges: [] };
		case 'RegExp': {
			const regexp = /** @type {RegExp} */ (value);
			return { kind: type, data: { source: regexp.source, flags: regexp.flags }, edges: [] };
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
			return { kind: type, data: { source: String(value) }, edges: [] };
		case 'ArrayBuffer':
			return { kind: type, data: { bytes: new Uint8Array(/** @type {ArrayBuffer} */ (value)) }, edges: [] };
		case 'Array': {
			const array = /** @type {unknown[]} */ (value);
			/** @type {Array<[keyof unknown[], ValueRef]>} */
			const entries = [];
			/** @type {ValueRef[]} */
			const edges = [];
			for (const key of valid_array_indices(array)) {
				graph.keys.push(key);
				graph.key_kinds.push(ARRAY_INDEX);
				const child = edge(graph, array[key]);
				graph.keys.pop();
				graph.key_kinds.pop();
				entries.push([key, child]);
				edges.push(child);
			}
			return { kind: type, data: { length: array.length, entries }, edges };
		}
		case 'Set': {
			const values = Array.from(/** @type {Set<unknown>} */ (value), (child) => edge(graph, child));
			return { kind: type, data: { values }, edges: values };
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
			return { kind: type, data: { entries }, edges: entries.flat() };
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
			return {
				kind: type,
				data: { buffer, byteOffset: view.byteOffset, byteLength: view.byteLength, length: view.length },
				edges: [buffer]
			};
		}
		default: {
			const object = /** @type {Record<string | symbol, unknown>} */ (value);
			if (!is_plain_object(object)) throw error(graph, 'Cannot stringify arbitrary non-POJOs', value);
			if (enumerable_symbols(object).length) {
				throw error(graph, 'Cannot stringify POJOs with symbolic keys', value);
			}
			/** @type {Array<[string, ValueRef]>} */
			const entries = [];
			/** @type {ValueRef[]} */
			const edges = [];
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
				edges.push(child);
			}
			return {
				kind: Object.getPrototypeOf(object) === null ? 'NullObject' : 'Object',
				data: { entries },
				edges
			};
		}
	}
}

/**
 * @param {CapturedGraph} graph
 * @param {unknown} value
 * @returns {ValueRef}
 */
function edge(graph, value) {
	const node = discover(graph, value);
	return node ? { node: node.id } : { value };
}

/**
 * @param {CapturedGraph} graph
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
