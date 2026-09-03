/**
 * @import {
 *   AsyncSequenceDescriptor,
 *   AsyncValueDescriptor,
 *   ClientReference,
 *   UnevalStreamOptions,
 *   UnevalStreamReplacer,
 *   UnevalStreamResult,
 *   UnevalStreamTail
 * } from './types.js'
 * @import { AsyncNode, CapturedGraph, CapturedNode, Child, ClientPath, ViewKind } from './graph.js'
 * @import { JavaScriptSource } from './javascript-source.js'
 * @import { Emission } from './stream-source.js'
 */

import { DevalueError, is_primitive, stringify_primitive, stringify_string } from './utils.js';
import { child, create_captured_graph, discover, is_node, roll_back } from './graph.js';
import { is_source, js, raw_source } from './javascript-source.js';
import {
	RUNTIMES,
	append_reference,
	capture_source,
	definitions_source,
	descriptor_source_values,
	describe_received,
	expression_source,
	join_sources,
	map_descriptor_source,
	map_source,
	outcome_source,
	promise_source,
	reference_source,
	reference_length,
	render_reference,
	render_stream_source,
	runtime_source,
	select_outcome_source,
	source_helpers,
	source_instructions,
	source_values,
	template_source
} from './stream-source.js';

const promise_then = Promise.prototype.then;

const generic_error = js`new Error("devalue: failed to serialize asynchronous value")`;

/**
 * Stream executable source while preserving identities across asynchronous regions.
 * @param {unknown} value
 * @param {UnevalStreamReplacer} [replacer]
 * @param {UnevalStreamOptions} [options]
 * @returns {Promise<UnevalStreamResult>}
 */
export async function unevalStream(value, replacer, options = {}) {
	if (options.signal?.aborted) throw options.signal.reason;

	const scope = options.scope ?? 'globalThis.__d';
	const id = options.id ?? create_session_id();
	const session = new Session(scope, id, value, replacer, options);
	return session.serialize(value);
}

/** Coordinates transactional graph capture, durable outcome regions, client references, and tail delivery. */
class Session {
	/** Trusted assignable source expression that locates the client session table. @type {string} */
	#scope;
	/** Unescaped, unique identifier for this stream session. @type {string} */
	#id;
	/** User callback that replaces custom values. @type {UnevalStreamReplacer | undefined} */
	#replacer;
	/** Signal that cancels server-side observation and sequence pulling. @type {AbortSignal | undefined} */
	#signal;
	/** Diagnostic callback for asynchronous outcomes that fail to serialize. @type {UnevalStreamOptions['onerror']} */
	#onerror;
	/** Captured identities shared by all emitted regions. @type {CapturedGraph} */
	#graph;
	/** Async descriptor states in discovery order; a capture appends and a failed capture truncates. @type {Source[]} */
	#sources = [];
	/** Index into `#sources` of the first source not yet started. @type {number} */
	#started = 0;
	/** Events collected during the current scheduled flush window. @type {Event[]} */
	#batch = [];
	/** Whether the current batch is eligible to emit when the consumer takes it. @type {boolean} */
	#batch_ready = false;
	/** Wakes the tail generator when a batch is ready or the lifecycle changes. @type {(() => void) | undefined} */
	#wake;
	/** Number of async sources whose terminal client operation has not been generated. @type {number} */
	#active = 0;
	/** Whether a batch finalization is currently scheduled. @type {boolean} */
	#flushing = false;
	/** Scheduled batch finalization handle. @type {ReturnType<typeof setTimeout> | undefined} */
	#flush_handle;
	/** Explicit session lifecycle, independent of source accounting and reason truthiness. @type {Lifecycle} */
	#status = { state: 'preparing' };
	/** Next client anchor index; index zero is reserved for the head root. @type {number} */
	#anchor = 1;
	/** Next client pending index used to store a descriptor's private control. @type {number} */
	#pending = 0;
	/** Next client slot index used when no stable path can retain an identity. @type {number} */
	#slot = 0;
	/** Next client collection index used for a retained Map or Set sidecar. @type {number} */
	#collection = 0;
	/** Stable AbortSignal listener that forwards cancellation. @type {() => void} */
	#abort;
	/** Canonical captured node for the initial graph root. @type {CapturedNode | undefined} */
	#root;
	/** Session helpers already defined in emitted output. @type {Partial<Record<keyof typeof RUNTIMES, boolean>>} */
	#runtimes_emitted = {};
	/** Native promise sources whose terminal operation has not been emitted. @type {number} */
	#native_pending = 0;
	/** Custom nodes captured since the last atomic-cycle validation. @type {CapturedNode[]} */
	#new_custom = [];
	/** Nodes whose opacity was incremented in an active transaction. @type {CapturedNode[]} */
	#opaque_increments = [];
	/** Number of nested graph/emission transactions currently active. */
	#transaction_depth = 0;
	/** Custom nodes already proven acyclic. @type {Set<CapturedNode>} */
	#validated = new Set();
	/** Whether the head must define the block dispatch helper. @type {boolean} */
	#emit_dispatch = false;
	/** Shortest retained client paths, linked when a later path improves on an earlier one. @type {Map<CapturedNode, RetainedReference>} */
	#references = new Map();
	/** Ordered client-materialization boundary. Zero denotes the initialized head graph. */
	#availability = 0;
	/** Monotonic suffix for block-local outcome bindings. */
	#local = 0;
	/** Monotonic owner tag for reusable node planning scratch. */
	#region_id = 0;
	/** Registry keys claimed by async descriptors in this stream. @type {Set<string>} */
	#keys = new Set();
	/** Whether tail blocks must not depend on the head having been evaluated. @type {boolean} */
	#detached;
	/** Whether the head has been emitted and the graph reset for detached tail blocks. @type {boolean} */
	#detached_tail = false;
	/** Whether a detached tail block has already taken over the saved session. @type {boolean} */
	#detached_started = false;

	/**
	 * Creates an isolated server-side stream session.
	 *
	 * @param {string} scope
	 * @param {string} id
	 * @param {unknown} root
	 * @param {UnevalStreamReplacer | undefined} replacer
	 * @param {UnevalStreamOptions} options
	 */
	constructor(scope, id, root, replacer, options) {
		const signal = options.signal;
		this.#scope = scope;
		this.#id = id;
		this.#replacer = replacer;
		this.#signal = signal;
		this.#onerror = options.onerror;
		this.#graph = create_captured_graph(root, (graph, node, value) => this.#classify(graph, node, value));
		this.#abort = () => void this.#cancel(signal?.reason, true);
		signal?.addEventListener('abort', this.#abort, { once: true });
		this.#detached = options.detached === true;
	}

	/**
	 * @param {unknown} value
	 * @returns {Promise<UnevalStreamResult>}
	 */
	async serialize(value) {
		try {
			// walk the graph and capture the synchronous values and the first layer of async sources
			this.#capture(value, true);
			this.#active = this.#sources.length;
			if (!this.#is_active()) return await this.#throw_failure(undefined);

			if (this.#sources.length === 0) {
				const head = render_stream_source(this.#emit_region(value, false));
				this.#complete();
				return { head, tail: empty_tail(), id: this.#id };
			}

			this.#status = { state: 'streaming' };
			// start observing the async sources
			this.#start_sources();
			// Give newly started sources the same host-scheduled flush window used by tail
			// batching. This is an operational scheduling window, not a task-count guarantee.
			do await macrotask();
			while (this.#flushing && this.#is_active());
			if (!this.#is_active()) return await this.#throw_failure(undefined);

			const head_region = this.#emit_region(value, true, undefined, 0, 0);
			this.#assign_references(value, { kind: 'anchor', index: 0, segments: [] }, new Map(), 0);
			// anything that settled within the window is folded into the head rather than shipped as a block
			const operations = this.#batch_ready
				? await this.#deliver(this.#take_batch(), false)
				: undefined;

			// if everything resolved in 1 task, then we ended up with a single batch, so we don't need to do anything else
			if (this.#active === 0 && this.#batch.length === 0) {
				const final_operations = operations
					? join_sources([operations, this.#cleanup_source()], ';')
					: this.#cleanup_source();
				const head = this.#wrap_head(head_region, final_operations);
				this.#complete();
				return { head, tail: empty_tail(), id: this.#id };
			}

			if (!this.#detached) this.#emit_dispatch = true;
			const head = this.#wrap_head(head_region, operations);
			// Detach only after the head is fully rendered, since rendering records which
			// runtime helpers the head defined and detaching forgets them.
			if (this.#detached) this.#detach();
			return { head, tail: this.#tail(), id: this.#id };
		} catch (error) {
			return await this.#throw_failure(error);
		}
	}

	/**
	 * Collects helpers reachable from a finished structured block, marks only those helpers
	 * as emitted, and renders the block once with definitions at its explicit prelude point.
	 *
	 * @param {Emission} source
	 * @returns {string}
	 */
	#render_final(source) {
		const definitions = source_helpers(source).filter((key) => !this.#runtimes_emitted[key]);
		for (const key of definitions) this.#runtimes_emitted[key] = true;
		return render_stream_source(source, definitions);
	}

	/** Severs tail blocks from positional state created by the head. */
	#detach() {
		for (const source of this.#sources) {
			if (!source.terminal && source.node.data.key === undefined) {
				throw this.#error('Cannot detach an unkeyed asynchronous value', source.node.value);
			}
		}
		this.#references = new Map();
		for (const node of this.#graph.nodes) {
			if (node.kind === 'Async' && node.data.key !== undefined && !node.data.state.terminal) {
				this.#references.set(node, {
					path: { kind: 'key', index: node.data.key, segments: ['[0]'] },
					available: 0,
					previous: undefined
				});
			}
		}
		this.#runtimes_emitted = {};
		this.#availability = 0;
		this.#anchor = 1;
		this.#slot = 0;
		this.#collection = 0;
		this.#detached_tail = true;
	}

	/**
	 * Atomically walks a value's devalue-visible graph and discovers async sources.
	 *
	 * A shared transaction checkpoint restores graph nodes, sources, counters, retained
	 * references, validation state, registry keys, and opacity increments on previously
	 * captured nodes.
	 *
	 * @param {unknown} value
	 * @param {boolean} root
	 * @returns {CapturedNode | undefined}
	 */
	#capture(value, root = false) {
		const checkpoint = this.#begin_transaction();
		try {
			const node = discover(this.#graph, value);
			this.#validate_new_custom(checkpoint.new_custom.length);
			if (!this.#is_active()) throw this.#terminal_reason();
			this.#commit_transaction(checkpoint, true);
			if (root) this.#root = node;
			return node;
		} catch (error) {
			this.#roll_back_transaction(checkpoint, error);
			throw error;
		}
	}

	/** Captures mutable state needed to discard provisional graph/emission work. */
	#begin_transaction() {
		this.#transaction_depth++;
		return {
			nodes: this.#graph.nodes.length,
			sources: this.#sources.length,
			new_custom: this.#new_custom.slice(),
			validated: new Set(this.#validated),
			opaque: this.#opaque_increments.length,
			pending: this.#pending,
			native_pending: this.#native_pending,
			active: this.#active,
			availability: this.#availability,
			anchor: this.#anchor,
			slot: this.#slot,
			collection: this.#collection,
			local: this.#local,
			detached_started: this.#detached_started,
			references: new Map(this.#references)
		};
	}

	/** @param {TransactionCheckpoint} checkpoint @param {boolean} commit_sources */
	#commit_transaction(checkpoint, commit_sources) {
		if (commit_sources) {
			for (let i = checkpoint.sources; i < this.#sources.length; i++) this.#sources[i].committed = true;
		}
		this.#transaction_depth--;
		if (this.#transaction_depth === 0) this.#opaque_increments.length = checkpoint.opaque;
	}

	/** @param {TransactionCheckpoint} checkpoint @param {unknown} error */
	#roll_back_transaction(checkpoint, error) {
		for (let i = this.#opaque_increments.length - 1; i >= checkpoint.opaque; i--) this.#opaque_increments[i].opaque--;
		this.#opaque_increments.length = checkpoint.opaque;
		for (let i = this.#sources.length - 1; i >= checkpoint.sources; i--) {
			const source = this.#sources[i];
			this.#deactivate(source);
			const key = source.node.data.key;
			if (key !== undefined) this.#keys.delete(key);
		}
		this.#sources.length = checkpoint.sources;
		this.#new_custom = checkpoint.new_custom;
		this.#validated = checkpoint.validated;
		this.#pending = checkpoint.pending;
		this.#native_pending = checkpoint.native_pending;
		this.#active = checkpoint.active;
		this.#availability = checkpoint.availability;
		this.#anchor = checkpoint.anchor;
		this.#slot = checkpoint.slot;
		this.#collection = checkpoint.collection;
		this.#local = checkpoint.local;
		this.#detached_started = checkpoint.detached_started;
		this.#references = checkpoint.references;
		roll_back(this.#graph, checkpoint.nodes, error);
		this.#transaction_depth--;
	}

	/** Records an opaque constructor dependency with rollback support. @param {CapturedNode} node */
	#make_opaque(node) {
		node.opaque++;
		this.#opaque_increments.push(node);
	}

	/**
	 * Rejects direct cycles among atomic custom and async constructors, validating only
	 * nodes discovered since the previous validation. Edges are immutable once captured,
	 * so a new cycle always passes through a newly captured node.
	 */
	#validate_new_custom(start = 0) {
		if (this.#new_custom.length === start) return;
		const pending = this.#new_custom.slice(start);
		/** @type {Set<CapturedNode>} */
		const validating = new Set();
		/** @type {Set<CapturedNode>} */
		const validated = new Set();
		/** @param {CapturedNode} node */
		const validate = (node) => {
			if (this.#validated.has(node) || validated.has(node)) return;
			if (validating.has(node)) throw this.#error('Cannot stringify an atomic custom cycle', node.value);
			validating.add(node);
			for (const child of node.children) {
				if (is_node(child) && is_atomic(child)) validate(child);
			}
			validating.delete(node);
			validated.add(node);
		};
		for (const node of pending) validate(node);
		this.#new_custom.splice(start);
		for (const node of validated) this.#validated.add(node);
	}

	/**
	 * Attempts to classify a node as a user replacement, native Promise, or native
	 * AsyncIterable, filling the node in place. Returning false delegates to graph's
	 * built-in discovery.
	 *
	 * @param {CapturedGraph} graph
	 * @param {CapturedNode} node
	 * @param {unknown} value
	 * @returns {boolean}
	 */
	#classify(graph, node, value) {
		if (!this.#is_active()) throw this.#terminal_reason();
		if (this.#replacer) {
			const result = this.#replacer(value, js);
			if (!this.#is_active()) throw this.#terminal_reason();
			if (is_source(result)) {
				const values = source_values(result);
				const children = new Array(values.length);
				for (let i = 0; i < values.length; i++) {
					const captured = child(graph, values[i]);
					children[i] = captured;
					if (is_node(captured)) this.#make_opaque(captured);
				}
				node.kind = 'Custom';
				node.children = children;
				node.data = result;
				this.#new_custom.push(node);
				return true;
			}
			if (result === undefined || result === null || result === false) {
				// Explicitly the complete fallback set. Every other result is validated below.
			} else if (typeof result === 'object' && Object.hasOwn(result, 'type') && result.type === 'async-value') {
				this.#validate_value_descriptor(result);
				this.#add_source(node, result, 'value');
				return true;
			} else if (typeof result === 'object' && Object.hasOwn(result, 'type') && result.type === 'async-sequence') {
				this.#validate_sequence_descriptor(result);
				this.#add_source(node, result, 'sequence');
				return true;
			} else {
				throw new TypeError(`Invalid unevalStream replacer result: received ${describe_received(result)}. Return a js tagged template, a descriptor with its own type of "async-value" or "async-sequence", or undefined, null, or false to serialize normally. The replacer must be synchronous; Promise results are not supported.`);
			}
		}

		if (typeof value === 'object' && value !== null) {
			/** @type {{ active: boolean, dispatch?: (type: 'resolve' | 'reject', result: unknown) => void } | undefined} */
			let observer;
			if (is_native_promise(value)) try {
				/** @type {{ active: boolean, dispatch?: (type: 'resolve' | 'reject', result: unknown) => void }} */
				const current = observer = { active: true };
				/**
				 * Forwards a native Promise fulfillment while its provisional observer is active.
				 *
				 * @param {unknown} result
				 */
				const resolve = (result) => current.active && current.dispatch?.('resolve', result);
				/**
				 * Forwards a native Promise rejection while its provisional observer is active.
				 *
				 * @param {unknown} reason
				 */
				const reject = (reason) => current.active && current.dispatch?.('reject', reason);
				const observed = promise_then.call(
					value,
					resolve,
					reject
				);
				promise_then.call(observed, undefined, () => {});
			} catch {
				observer = undefined;
			}
			if (observer) {
				const descriptor = this.#native_descriptor(/** @type {Promise<unknown>} */ (value));
				try {
					const source = this.#add_source(node, descriptor, 'native', true);
					source.observer = observer;
					observer.dispatch = (type, result) => {
						if (!source.active) return;
						if (source.started) this.#event(source, type, result);
						else source.early = [type, result];
					};
					this.#native_pending++;
				} catch (error) {
					observer.active = false;
					throw error;
				}
				return true;
			}

			if (Symbol.asyncIterator in value) {
				this.#add_source(node, this.#native_sequence_descriptor(value), 'sequence', true);
				return true;
			}
		}
		return false;
	}

	/**
	 * Constructs an async descriptor target once, fills the node as `Async`, and stages
	 * its server source state.
	 *
	 * @param {CapturedNode} node
	 * @param {any} descriptor
	 * @param {'value' | 'sequence' | 'native'} type
	 * @param {boolean} [immediate] Whether this private adapter invokes its outcome exactly once immediately.
	 * @returns {Source}
	 */
	#add_source(node, descriptor, type, immediate = false) {
		/** @type {string | undefined} */
		const key = descriptor.id;
		if (key !== undefined && this.#keys.has(key)) {
			throw this.#error(`Duplicate asynchronous value id ${stringify_string(key)}`, node.value);
		}
		let capture_called = false;
		const pending = this.#pending;
		/** @param {JavaScriptSource} expression */
		const control = (expression) => {
			if (capture_called) throw new TypeError('devalue: capture may only be called once per async descriptor construct(); capture one js expression containing all private controls, such as js`[resolve,reject]`');
			if (!is_source(expression)) throw new TypeError(`Invalid async descriptor capture: capture() received ${describe_received(expression)}. Pass an expression built with the js tagged template, not a raw value or source string.`);
			capture_called = true;
			return capture_source(pending, expression);
		};
		const source = descriptor.construct(control);
		if (!this.#is_active()) throw this.#terminal_reason();
		if (!is_source(source)) throw new TypeError(`Invalid async descriptor construct result: construct() returned ${describe_received(source)}. It must synchronously return a js tagged template representing the client construction expression.`);
		// Reserve the control index and provisional source before recursive hole discovery.
		this.#pending = pending + 1;
		// `node` is reserved but unclassified; this call classifies it, so the cast records
		// the mutation that TypeScript cannot follow.
		const async_node = /** @type {AsyncNode} */ (node);
		/** @type {Source} */
		const state = { node: async_node, descriptor, type, immediate, committed: false, started: false, terminal: false, active: true };
		async_node.kind = 'Async';
		async_node.data = { source, pending, captured: false, state, key };
		this.#sources.push(state);
		if (key !== undefined) this.#keys.add(key);
		const entries = descriptor_source_values(source);
		const children = new Array(entries.length);
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			let captured;
			try {
				captured = child(this.#graph, entry.value);
			} catch (error) {
				throw descriptor_interpolation_error(error, entry.value, entry.capture ? 'async descriptor capture()' : 'async descriptor construct()', entry.index);
			}
			children[i] = captured;
			if (is_node(captured)) this.#make_opaque(captured);
		}
		async_node.children = children;
		async_node.data.captured = capture_called && (descriptor.manages_pending || source_instructions(source).some((instruction) => instruction.type === 'capture' && instruction.pending === pending));
		this.#new_custom.push(async_node);
		if (this.#signal?.aborted) throw this.#signal.reason;
		return state;
	}

	/**
	 * Discovers and eagerly materializes every ordinary value hole in a returned
	 * descriptor fragment. The caller commits only after adding the prerequisites
	 * and lowered operation to ordered output.
	 *
	 * @param {JavaScriptSource} source
	 * @param {string} context
	 * @param {number} available
	 * @param {number} retained_at
	 * @param {Set<CapturedNode>} references
	 */
	#lower_descriptor_source(source, context, available, retained_at, references) {
		const checkpoint = this.#begin_transaction();
		try {
			const entries = descriptor_source_values(source);
			/** @type {Map<object, CapturedNode>} */
			const nodes = new Map();
			for (const entry of entries) {
				try {
					const node = discover(this.#graph, entry.value);
					if (node) nodes.set(/** @type {object} */ (entry.value), node);
				} catch (error) {
					throw descriptor_interpolation_error(error, entry.value, context, entry.index);
				}
			}
			this.#validate_new_custom(checkpoint.new_custom.length);
			if (!this.#is_active()) throw this.#terminal_reason();
			this.#active += this.#sources.length - checkpoint.sources;

			/** One eager binding per ordinary object identity in this operation. @type {Map<CapturedNode, JavaScriptSource>} */
			const bindings = new Map();
			/** @type {Emission[]} */
			const prerequisites = [];
			// Arbitrary descriptor payloads are materialized immediately before these
			// prerequisites, so their retained identities already exist at this event boundary.
			let prerequisite_available = retained_at;
			for (const entry of entries) {
				if (is_primitive(entry.value)) continue;
				const node = nodes.get(/** @type {object} */ (entry.value));
				if (!node || bindings.has(node)) continue;
				references.add(node);
				const retained = this.#reference_at(node, prerequisite_available);
				/** @type {Emission} */
				let expression;
				if (retained) {
					expression = reference_source(node, retained.path);
				} else {
					const region = this.#emit_region(node.value, true, references, prerequisite_available, retained_at);
					this.#resolve_references(region, prerequisite_available);
					const index = this.#anchor++;
					const path = { kind: /** @type {const} */ ('anchor'), index, segments: [] };
					this.#assign_references(node.value, path, new Map(), retained_at);
					expression = join_sources([`s.a[${index}]=`, region]);
					prerequisite_available = retained_at;
				}
				const local = `o${this.#local++}`;
				prerequisites.push(join_sources([`const ${local}=`, expression]));
				bindings.set(node, raw_source(local));
			}

			const lowered = map_descriptor_source(source, (value, index) => {
				if (is_primitive(value)) {
					if (typeof value === 'symbol') throw descriptor_interpolation_error(undefined, value, context, index);
					return stringify_primitive(value);
				}
				const node = nodes.get(/** @type {object} */ (value));
				const binding = node && bindings.get(node);
				if (!binding) throw this.#error('Cannot stringify value: a descriptor template hole was not captured before lowering (internal emitter error)', value);
				return binding;
			});
			return { checkpoint, prerequisites, source: lowered };
		} catch (error) {
			this.#roll_back_transaction(checkpoint, error);
			throw error;
		}
	}

	/**
	 * @param {Promise<unknown>} promise
	 * @returns {AsyncValueDescriptor & { manages_pending: true }}
	 */
	#native_descriptor(promise) {
		let pending = -1;
		/**
		 * @param {ClientReference} reference
		 * @param {0 | 1} which `0` resolves, `1` rejects.
		 * @param {JavaScriptSource} value
		 */
		const settle = (reference, which, value) => {
			const remaining = this.#native_pending--;
			if (this.#runtimes_emitted.r || remaining >= 3) {
				return js`${runtime_source('r')}(${pending},${which},${value})`;
			}
			return js`${reference.control}[${which}](${value});delete ${reference.control}`;
		};
		return {
			type: 'async-value',
			source: promise,
			manages_pending: true,
			construct: (capture) => {
				capture(js`[a,b]`);
				pending = this.#pending;
				return promise_source(pending);
			},
			resolve: (reference, value) => settle(reference, 0, value),
			reject: (reference, reason) => settle(reference, 1, reason)
		};
	}

	/**
	 * @param {object} source
	 * @returns {AsyncSequenceDescriptor}
	 */
	#native_sequence_descriptor(source) {
		return {
			type: 'async-sequence',
			source: /** @type {AsyncIterable<unknown, unknown, unknown>} */ (source),
			construct: (capture) => js`${runtime_source('f')}(g=>{${capture(js`g`)}})`,
			next: ({ control }, value) => js`${control}(0,${value})`,
			complete: ({ control }, value) => js`${control}(1,${value})`,
			error: ({ control }, reason) => js`${control}(2,${reason})`
		};
	}

	/**
	 * Validates the synchronous shape of a one-shot async descriptor without observing its source.
	 *
	 * @param {any} descriptor
	 */
	#validate_value_descriptor(descriptor) {
		if (descriptor.id !== undefined && typeof descriptor.id !== 'string') {
			throw new TypeError(`Invalid async-value id: received ${describe_received(descriptor.id)}. Omit id or provide a string unique within the stream.`);
		}
		const source = descriptor.source;
		if ((typeof source !== 'object' || source === null) && typeof source !== 'function') {
			throw new TypeError(`Invalid async-value source: received ${describe_received(source)}. The source must be a Promise or a Promise-like object or function with a callable then method.`);
		}
		for (const key of ['construct', 'resolve', 'reject']) {
			const method = descriptor[key];
			if (typeof method !== 'function') throw new TypeError(`Invalid async-value ${key}: received ${describe_received(method)}. The descriptor must provide a ${key}() function.`);
		}
		const cancel = descriptor.cancel;
		if (cancel !== undefined && typeof cancel !== 'function') {
			throw new TypeError(`Invalid async-value cancel: received ${describe_received(cancel)}. Omit cancel or provide a cleanup function.`);
		}
	}

	/**
	 * Validates the synchronous shape of an async sequence descriptor without acquiring an iterator.
	 *
	 * @param {any} descriptor
	 */
	#validate_sequence_descriptor(descriptor) {
		if (descriptor.id !== undefined && typeof descriptor.id !== 'string') {
			throw new TypeError(`Invalid async-sequence id: received ${describe_received(descriptor.id)}. Omit id or provide a string unique within the stream.`);
		}
		const source = descriptor.source;
		if ((typeof source !== 'object' || source === null) && typeof source !== 'function') {
			throw new TypeError(`Invalid async-sequence source: received ${describe_received(source)}. The source must be an async iterable with a callable Symbol.asyncIterator method.`);
		}
		for (const key of ['construct', 'next', 'complete', 'error']) {
			const method = descriptor[key];
			if (typeof method !== 'function') throw new TypeError(`Invalid async-sequence ${key}: received ${describe_received(method)}. The descriptor must provide a ${key}() function.`);
		}
		const cancel = descriptor.cancel;
		if (cancel !== undefined && typeof cancel !== 'function') {
			throw new TypeError(`Invalid async-sequence cancel: received ${describe_received(cancel)}. Omit cancel or provide a cleanup function.`);
		}
	}

	/** Starts every committed source unless the constructor's AbortSignal listener has cancelled the session. */
	#start_sources() {
		if (this.#signal?.aborted) {
			void this.#cancel(this.#signal.reason, true);
			return;
		}
		this.#start_unstarted();
	}

	/** Starts every source appended since the previous call. */
	#start_unstarted() {
		const sources = this.#sources;
		const end = sources.length;
		for (let i = this.#started; i < end && this.#is_active(); i++) this.#start(sources[i]);
		this.#started = end;
	}

	/**
	 * Starts observation or iteration for one committed source exactly once.
	 *
	 * @param {Source} source
	 */
	#start(source) {
		if (source.started || !this.#is_active()) return;
		source.started = true;
		if (source.type === 'sequence') {
			this.#start_sequence(source);
			return;
		}
		if (source.type === 'native') {
			if (source.early) this.#event(source, source.early[0], source.early[1]);
			return;
		}
		try {
			const then = source.descriptor.source.then;
			if (!this.#is_active()) return;
			if (typeof then !== 'function') throw new TypeError('then is not callable');
			new Promise((resolve, reject) => {
				try {
					then.call(source.descriptor.source, resolve, reject);
				} catch (error) {
					reject(error);
				}
			}).then(
				(value) => this.#event(source, 'resolve', value),
				(reason) => this.#event(source, 'reject', reason)
			);
		} catch (error) {
			this.#event(source, 'reject', error);
		}
	}

	/**
	 * Acquires and validates an async iterator, then begins its first bounded pull.
	 *
	 * @param {Source} source
	 */
	#start_sequence(source) {
		source.acquiring = true;
		try {
			const method = source.descriptor.source[Symbol.asyncIterator];
			if (!this.#is_active()) return this.#finish_acquisition(source);
			if (typeof method !== 'function') throw new TypeError('async iterator is not callable');
			const iterator = method.call(source.descriptor.source);
			if ((typeof iterator !== 'object' || iterator === null) && typeof iterator !== 'function') {
				throw new TypeError('async iterator is not an object');
			}
			source.iterator = iterator;
			if (!this.#is_active()) return this.#finish_acquisition(source);
			const next = iterator.next;
			if (!this.#is_active()) return this.#finish_acquisition(source);
			if (typeof next !== 'function') throw new TypeError('async iterator next is not callable');
			source.next = next;
			source.acquiring = false;
			this.#pull(source);
		} catch (error) {
			source.acquiring = false;
			if (this.#is_active()) this.#event(source, 'error', error);
			else {
				this.#close_sequence(source);
				this.#cancel_source(source);
			}
		}
	}

	/**
	 * Completes reentrant iterator acquisition after cancellation in return-before-cancel order.
	 * @param {Source} source
	 */
	#finish_acquisition(source) {
		source.acquiring = false;
		this.#close_sequence(source);
		this.#cancel_source(source);
	}

	/**
	 * Performs at most one outstanding sequence pull and converts its result into a raw event.
	 *
	 * @param {Source} source
	 */
	#pull(source) {
		// `next` is set by #start_sequence before the first pull, and later pulls are only
		// triggered by 'next' events, which require an earlier successful pull.
		const next = source.next;
		if (!next || source.terminal || source.pulling || !this.#is_active()) return;
		source.pulling = true;
		const finish = () => {
			source.pulling = false;
		};
		let result;
		try {
			result = next.call(source.iterator);
		} catch (error) {
			finish();
			this.#event(source, 'error', error);
			return;
		}
		Promise.resolve(result).then(
			(result) => {
				finish();
				if (source.terminal || !this.#is_active()) return;
				try {
					if ((typeof result !== 'object' || result === null) && typeof result !== 'function') {
						throw new TypeError('async iterator result is not an object');
					}
					const done = result.done;
					const value = result.value;
					this.#event(source, done ? 'complete' : 'next', value);
				} catch (error) {
					this.#event(source, 'error', error);
				}
			},
			(error) => {
				finish();
				this.#event(source, 'error', error);
			}
		);
	}

	/**
	 * Walks an observed async outcome and queues it in monotonic observation order.
	 *
	 * @param {Source} source
	 * @param {Event['type']} type
	 * @param {unknown} value
	 */
	#event(source, type, value) {
		if (source.terminal || !this.#is_active()) return;
		if (type !== 'next') {
			source.terminal = true;
		}
		const event = { source, type, value, invalid: false };
		const source_count = this.#sources.length;
		try {
			this.#capture(value);
			this.#active += this.#sources.length - source_count;
		} catch (error) {
			if (!this.#is_active()) return;
			this.#report(error, value);
			event.type = source.type === 'sequence' ? 'error' : 'reject';
			event.value = undefined;
			event.invalid = true;
		}
		this.#batch.push(event);
		if (!this.#flushing) {
			this.#flushing = true;
			this.#flush_handle = setTimeout(() => this.#flush(), 0);
		}
		// Iterators contribute at most one item to each batch. The next pull starts when
		// this batch is consumed, preventing an immediately-ready iterator from starving
		// other sources or growing the head without bound.
	}

	/**
	 * Marks a batch's events as emitted and resumes sequence pulling. A sequence only pulls
	 * once its previous `next` event is consumed, so each sequence has at most one
	 * unconsumed `next` event and every such event resumes exactly one pull.
	 *
	 * @param {Event[]} events
	 */
	#consume(events) {
		for (const event of events) {
			if (event.type === 'next') this.#pull(event.source);
		}
	}

	/** Makes the current ordered events eligible for delivery and wakes the tail. */
	#flush() {
		this.#flushing = false;
		this.#flush_handle = undefined;
		if (!this.#is_active() || this.#batch.length === 0) return;
		this.#batch_ready = true;
		this.#notify();
	}

	/**
	 * Takes the ready batch. Until this happens, later events may still join it.
	 *
	 * @returns {Event[]}
	 */
	#take_batch() {
		const events = this.#batch;
		this.#batch = [];
		this.#batch_ready = false;
		return events;
	}

	/**
	 * Renders a batch, closes any sequences that failed within it, starts sources discovered by
	 * it, and resumes pulling. Generation failures are fatal and cancel the session.
	 *
	 * @param {Event[]} events
	 * @param {boolean} block whether to wrap the operations as a standalone tail block
	 * @returns {Promise<Emission>}
	 */
	async #deliver(events, block) {
		try {
			const emitted = this.#emit_batch(events, block);
			if (!this.#is_active()) return await this.#throw_failure(undefined);
			for (const source of emitted.close) this.#close_failed_sequence(source);
			this.#start_unstarted();
			this.#consume(events);
			if (!this.#is_active()) return await this.#throw_failure(undefined);
			const source = block ? this.#render_final(emitted.source) : emitted.source;
			if (block && this.#active === 0 && this.#batch.length === 0) this.#complete();
			return source;
		} catch (error) {
			return await this.#throw_failure(error);
		}
	}

	/**
	 * Emits one walked graph region, optionally retaining references for future regions.
	 *
	 * @param {unknown} value
	 * @param {boolean} persistent
	 * @param {Set<CapturedNode>} [references]
	 * @param {number} [available] Paths usable while constructing this region.
	 * @param {number} [retained_at] Boundary after which paths created by this region exist.
	 * @returns {Emission}
	 */
	#emit_region(value, persistent, references, available = this.#availability, retained_at = available) {
		// A primitive region has neither graph planning nor unresolved source dependencies.
		if (is_primitive(value)) {
			if (typeof value === 'symbol') throw this.#error('Cannot stringify a Symbol primitive', value);
			return stringify_primitive(value);
		}
		const identities = this.#graph.identities;
		const region_id = ++this.#region_id;
		/** @type {CapturedNode[]} */
		const order = [];
		/** @param {CapturedNode} node */
		const visit = (node) => {
			if (this.#reference_at(node, available) || node.region_id === region_id) return;
			node.region_id = region_id;
			node.uses = 0;
			node.hoisted = false;
			node.early = false;
			node.latest = -1;
			node.name = '';
			node.rendering = false;
			// Post-order: children are declared before parents so declarations can embed
			// them as literals; only back-edges (cycles) need post-declaration patches.
			const children = node.children;
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (is_node(child)) visit(child);
			}
			node.position = order.push(node) - 1;
		};
		const root_node = is_primitive(value) ? undefined : identities.get(/** @type {object} */ (value));
		if (root_node) visit(root_node);

		// In-region use counts; a node used once can be inlined at its single use site.
		// Persistent Set/Map sidecars re-reference each retained element, so those
		// elements must be hoisted names rather than duplicated inline literals.
		if (root_node?.region_id === region_id) root_node.uses++;
		for (const node of order) {
			const weight = persistent && (node.kind === 'Set' || node.kind === 'Map') ? 2 : 1;
			const children = node.children;
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (is_node(child) && child.region_id === region_id) child.uses += weight;
			}
		}

		/** @param {CapturedNode} node */
		const is_sparse = (node) => node.kind === 'Array' && node.keys.length !== node.data;
		let hoisted_count = 0;
		/** Keyed async values need a name so the registry sidecar can capture their target. @param {CapturedNode} node */
		const is_keyed = (node) => node.kind === 'Async' && node.data.key !== undefined;
		for (const node of order) {
			if (node.uses > 1 || node.opaque > 0 || node.kind === 'NullObject' || is_sparse(node) || is_keyed(node)) {
				node.hoisted = true;
				hoisted_count++;
			}
		}

		// Containers that must be declared (empty) ahead of every literal declaration
		// because an atomic node's constructor needs their name before their post-order slot.
		/**
		 * Reports whether a child's expansion reaches a name declared at or after `limit`.
		 *
		 * @param {CapturedNode} node
		 * @param {number} limit
		 * @param {Set<CapturedNode>} seen
		 * @returns {boolean}
		 */
		const references_later = (node, limit, seen) => {
			if (node.region_id !== region_id) return false;
			if (node.hoisted) return node.early ? false : node.position >= limit;
			if (seen.has(node)) return false;
			seen.add(node);
			const children = node.children;
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (is_node(child) && references_later(child, limit, seen)) return true;
			}
			return false;
		};
		// Atomic nodes (customs, views) embed child expressions in their declaration and
		// cannot defer them to fills. A direct container child whose expansion reaches a name
		// declared at or after the atomic is hoisted (its back-edges become fills); a direct
		// child that is itself a later-declared hoisted container is declared empty up front;
		// a direct atomic child is secured recursively (atomics cannot defer anything).
		/** @param {CapturedNode} node */
		const secure_atomic = (node) => {
			const limit = node.position;
			const children = node.children;
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (!is_node(child) || child.region_id !== region_id) continue;
				if (child.hoisted) {
					if (!child.early && child.position >= limit) child.early = true;
					continue;
				}
				if (!references_later(child, limit, new Set())) continue;
				if (is_atomic(child)) secure_atomic(child);
				child.hoisted = true;
				hoisted_count++;
			}
		};
		for (const node of order) {
			if (node.hoisted && is_atomic(node)) secure_atomic(node);
		}

		// `hoisted` and `early` are final now, so "does this child's expansion reach a
		// name declared at or after position `limit`?" reduces to one memoized number per
		// node: the latest declaration position its inline expansion can reach. Children
		// precede parents in post-order, and any back-edge target is necessarily hoisted
		// (a cycle entry always has two or more uses), so one bottom-up pass suffices.
		/**
		 * @param {Child} child
		 * @returns {number}
		 */
		const latest_of = (child) => {
			if (!is_node(child) || child.region_id !== region_id) return -1;
			if (child.hoisted) return child.early ? -1 : child.position;
			return child.latest;
		};
		if (hoisted_count > 0) {
			for (const node of order) {
				if (node.hoisted) continue;
				let reach = -1;
				const children = node.children;
				for (let i = 0; i < children.length; i++) {
					const value = latest_of(children[i]);
					if (value > reach) reach = value;
				}
				node.latest = reach;
			}
		}

		let name_count = 0;
		for (const node of order) if (node.hoisted) node.name = `v${name_count++}`;

		/** @type {Emission[]} */
		const fill = [];
		/** @type {Emission[]} */
		const sidecars = [];
		/** Best paths visited while retaining stable descendants from this region's sidecars. @type {Map<CapturedNode, number>} */
		const sidecar_seen = new Map();
		/** @type {Emission[]} */
		const slots = [];
		/**
		 * Renders a raw value interpolated by a custom replacer template.
		 *
		 * @param {unknown} thing
		 * @returns {Emission}
		 */
		const expression = (thing) => {
			if (is_primitive(thing)) {
				if (typeof thing === 'symbol') throw this.#error('Cannot stringify a Symbol primitive', thing);
				return stringify_primitive(thing);
			}
			const node = identities.get(/** @type {object} */ (thing));
			if (!node) throw this.#error('Cannot stringify value: a custom template hole was not discovered in the captured graph; do not change template holes after the replacer returns', thing);
			return expression_node(node);
		};
		/**
		 * @param {CapturedNode} node
		 * @returns {Emission}
		 */
		const expression_node = (node) => {
			const retained = this.#reference_at(node, available);
			if (retained && node.region_id !== region_id) {
				references?.add(node);
				return reference_source(node, retained.path);
			}
			if (node.region_id === region_id && node.name) return node.name;
			// `rendering` guards against unexpected re-entry while expanding inline.
			if (node.rendering) throw this.#error('Cannot stringify value: inline construction re-entered the same node without a declared reference (internal emitter error)', node.value);
			node.rendering = true;
			try {
				return inline(node);
			} finally {
				node.rendering = false;
			}
		};
		/** @param {Child} child */
		const expression_child = (child) => {
			if (is_node(child)) return expression_node(child);
			if (typeof child === 'symbol') throw this.#error('Cannot stringify a Symbol primitive', child);
			return stringify_primitive(child);
		};

		/** @param {Child[]} children */
		const set_literal = (children) => children.length
			? join_sources(['new Set([', join_sources(children.map(expression_child), ','), '])'])
			: 'new Set';
		/** @param {Child[]} children */
		const map_literal = (children) => {
			if (children.length === 0) return 'new Map';
			/** @type {Emission[]} */
			const entries = [];
			for (let i = 0; i < children.length; i += 2) {
				entries.push(join_sources(['[', expression_child(children[i]), ',', expression_child(children[i + 1]), ']']));
			}
			return join_sources(['new Map([', join_sources(entries, ','), '])']);
		};

		/**
		 * Emits the full construction of a single-use node at its use site.
		 *
		 * @param {CapturedNode} node
		 * @returns {Emission}
		 */
		const inline = (node) => {
			const children = node.children;
			switch (node.kind) {
				case 'Array':
					return join_sources(['[', join_sources(children.map(expression_child), ','), ']']);
				case 'Object': {
					const keys = node.keys;
					/** @type {Emission[]} */
					const properties = [];
					for (let i = 0; i < keys.length; i++) {
						properties.push(join_sources([`${literal_key(keys[i])}:`, expression_child(children[i])]));
					}
					return join_sources(['{', join_sources(properties, ','), '}']);
				}
				case 'Set':
					return set_literal(children);
				case 'Map':
					return map_literal(children);
				case 'Async':
					return expression_source(map_descriptor_source(node.data.source, expression));
				case 'Custom':
					return expression_source(map_source(node.data, expression));
				default:
					return scalar(node, expression_child);
			}
		};

		/** @type {Emission[]} */
		const early_declarations = [];
		/** @type {Emission[]} */
		const declarations = [];
		for (const node of order) {
			const name = node.name;
			const children = node.children;
			const keys = node.keys;
			if (name && node.early) {
				// Declared empty ahead of every literal so atomic constructors can reference it.
				switch (node.kind) {
					case 'Array':
						early_declarations.push(`${name}=Array(${node.data})`);
						for (let i = 0; i < keys.length; i++) fill.push(join_sources([`${name}[${keys[i]}]=`, expression_child(children[i])]));
						break;
					case 'Object':
					case 'NullObject':
						early_declarations.push(`${name}=${node.kind === 'NullObject' ? 'Object.create(null)' : '{}'}`);
						for (let i = 0; i < keys.length; i++) fill.push(join_sources([`${name}${prop(keys[i])}=`, expression_child(children[i])]));
						break;
					case 'Set':
						early_declarations.push(`${name}=new Set`);
						for (let i = 0; i < children.length; i++) fill.push(join_sources([`${name}.add(`, expression_child(children[i]), ')']));
						break;
					case 'Map':
						early_declarations.push(`${name}=new Map`);
						for (let i = 0; i < children.length; i += 2) fill.push(join_sources([`${name}.set(`, expression_child(children[i]), ',', expression_child(children[i + 1]), ')']));
						break;
					default:
						throw this.#error(`Cannot stringify value: a ${node.kind} node was scheduled for empty construction, but only mutable containers support it (internal emitter error)`, node.value);
				}
			} else if (name) {
				// A child can be embedded in this declaration if its expansion never reaches
				// a name declared at or after this node; back-edges become fills instead.
				const limit = node.position;
				/** @param {Child} child */
				const available = (child) => latest_of(child) < limit;
				switch (node.kind) {
					case 'Array': {
						if (is_sparse(node)) {
							declarations.push(`${name}=Array(${node.data})`);
							for (let i = 0; i < keys.length; i++) fill.push(join_sources([`${name}[${keys[i]}]=`, expression_child(children[i])]));
							break;
						}
						/** @type {Emission[]} */
						const parts = [];
						for (let i = 0; i < children.length; i++) {
							const child = children[i];
							if (available(child)) parts.push(expression_child(child));
							else {
								parts.push('');
								fill.push(join_sources([`${name}[${keys[i]}]=`, expression_child(child)]));
							}
						}
						// A trailing elision needs one extra comma to preserve length.
						const trailing = parts.length && !available(children[children.length - 1]) ? ',' : '';
						declarations.push(join_sources([`${name}=[`, join_sources(parts, ','), `${trailing}]`]));
						break;
					}
					case 'Object': {
						/** @type {Emission[]} */
						const embedded = [];
						let filling = false;
						for (let i = 0; i < children.length; i++) {
							const child = children[i];
							if (!filling && available(child)) {
								embedded.push(join_sources([`${literal_key(keys[i])}:`, expression_child(child)]));
							} else {
								// Once one key must wait for a later declaration, every following key is
								// populated through ordered fills so no available value leapfrogs it.
								filling = true;
								fill.push(join_sources([`${name}${prop(keys[i])}=`, expression_child(child)]));
							}
						}
						declarations.push(join_sources([`${name}={`, join_sources(embedded, ','), '}']));
						break;
					}
					case 'NullObject': {
						declarations.push(`${name}=Object.create(null)`);
						for (let i = 0; i < keys.length; i++) fill.push(join_sources([`${name}${prop(keys[i])}=`, expression_child(children[i])]));
						break;
					}
					case 'Set': {
						// Insertion order is observable, so embed only when every member is ready.
						if (children.every(available)) {
							declarations.push(join_sources([`${name}=`, set_literal(children)]));
						} else {
							declarations.push(`${name}=new Set`);
							for (let i = 0; i < children.length; i++) fill.push(join_sources([`${name}.add(`, expression_child(children[i]), ')']));
						}
						break;
					}
					case 'Map': {
						if (children.every(available)) {
							declarations.push(join_sources([`${name}=`, map_literal(children)]));
						} else {
							declarations.push(`${name}=new Map`);
							for (let i = 0; i < children.length; i += 2) fill.push(join_sources([`${name}.set(`, expression_child(children[i]), ',', expression_child(children[i + 1]), ')']));
						}
						break;
					}
					default:
						declarations.push(join_sources([`${name}=`, inline(node)]));
				}
			}
			if (persistent && (node.kind === 'Set' || node.kind === 'Map')) {
				// Store non-primitive elements in a flat sidecar because Set/Map containers do
				// not expose paths to them, then retain stable descendants below each element.
				/** @type {CapturedNode[]} */
				const elements = [];
				for (let i = 0; i < children.length; i++) {
					const child = children[i];
					if (is_node(child)) elements.push(child);
				}
				if (elements.length) {
					const index = this.#collection++;
					sidecars.push(join_sources([`s.c[${index}]=[`, join_sources(elements.map(expression_node), ','), ']']));
					for (let i = 0; i < elements.length; i++) {
						this.#assign_references_node(elements[i], { kind: 'collection', index, segments: [`[${i}]`] }, sidecar_seen, retained_at);
					}
				}
			}
		}

		const root = expression(value);
		for (const node of order) {
			if (node.kind !== 'Async' || node.data.key === undefined) continue;
			// Register `[target, control]` so settlements from any session can address it by key.
			const control = node.data.captured ? `,s.p[${node.data.pending}]` : '';
			sidecars.push(`(s.k||(s.k={__proto__:null}))[${stringify_string(node.data.key)}]=[${node.name}${control}]`);
		}
		if (persistent) {
			for (const node of order) {
				if (node.opaque === 0) continue;
				const index = this.#slot++;
				slots.push(`s.s[${index}]=${node.name}`);
				/** @type {ClientPath} */
				const reference = { kind: 'slot', index, segments: [] };
				this.#reference_node(node, reference, retained_at);
				this.#assign_references(node.value, reference, new Map(), retained_at);
			}
		}
		const all_declarations = early_declarations.concat(declarations);
		const statements = [
			...(all_declarations.length ? [join_sources(['let ', join_sources(all_declarations, ',')])] : []),
			...fill,
			...sidecars,
			...slots
		];
		return statements.length
			? join_sources(['(()=>{', join_sources([...statements, join_sources(['return ', root])], ';'), '})()'])
			: root;
	}

	/**
	 * Records a client reference when it improves the shortest known source expression for an identity.
	 * Older records remain linked so source generated for an earlier boundary cannot select a path
	 * that only comes into existence later.
	 *
	 * @param {CapturedNode} node
	 * @param {ClientPath} reference
	 * @param {number} available
	 */
	#reference_node(node, reference, available) {
		const previous = this.#references.get(node);
		if (!previous || reference_length(reference) < reference_length(previous.path)) {
			this.#references.set(node, { path: reference, available, previous });
		}
	}

	/**
	 * Returns the shortest retained path that exists at an ordered client boundary.
	 * @param {CapturedNode} node
	 * @param {number} available
	 * @returns {RetainedReference | undefined}
	 */
	#reference_at(node, available) {
		let reference = this.#references.get(node);
		let selected;
		while (reference) {
			if (reference.available <= available && (!selected || reference_length(reference.path) < reference_length(selected.path))) {
				selected = reference;
			}
			reference = reference.previous;
		}
		return selected;
	}

	/**
	 * Resolves a reference hole to a concrete client path: the path fixed when the hole
	 * was created, or else the node's shortest committed path. Every node that reaches
	 * a batch has been anchored by an earlier region, so a miss is an internal error.
	 *
	 * @param {import('./stream-source.js').ReferenceInstruction} hole
	 * @returns {ClientPath}
	 */
	#resolve_reference(hole, available = this.#availability) {
		const reference = hole.path ?? this.#reference_at(hole.node, available)?.path;
		if (!reference) throw this.#error('Cannot stringify value: a client identity has no retained anchor, slot, or collection path before operation generation (internal emitter error)', hole.node.value);
		return reference;
	}

	/** Resolves every reachable structured reference before final rendering. @param {Emission} source */
	#resolve_references(source, available = this.#availability) {
		for (const instruction of source_instructions(source)) {
			if (instruction.type === 'reference') instruction.path = this.#resolve_reference(instruction, available);
		}
	}

	/**
	 * Walks stable graph edges and assigns the cheapest reachable client reference to each node.
	 *
	 * @param {unknown} value
	 * @param {ClientPath} reference
	 * @param {Map<CapturedNode, number>} seen
	 * @param {number} available
	 */
	#assign_references(value, reference, seen, available) {
		if (is_primitive(value)) return;
		const node = this.#graph.identities.get(/** @type {object} */ (value));
		if (node) this.#assign_references_node(node, reference, seen, available);
	}

	/**
	 * @param {CapturedNode} node
	 * @param {ClientPath} reference
	 * @param {Map<CapturedNode, number>} seen
	 * @param {number} available
	 */
	#assign_references_node(node, reference, seen, available) {
		this.#reference_node(node, reference, available);
		const length = reference_length(reference);
		const previous = seen.get(node);
		if (previous !== undefined && previous <= length) return;
		seen.set(node, length);
		const children = node.children;
		if (node.kind === 'Array') {
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (is_node(child)) this.#assign_references_node(child, append_reference(reference, `[${node.keys[i]}]`), seen, available);
			}
		} else if (node.kind === 'Object' || node.kind === 'NullObject') {
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (is_node(child)) this.#assign_references_node(child, append_reference(reference, prop(node.keys[i])), seen, available);
			}
		} else if (is_view(node)) {
			this.#assign_references_node(node.children[0], append_reference(reference, '.buffer'), seen, available);
		}
	}

	/**
	 * Wraps the head region with client table and session initialization, folding any
	 * pre-head operations (initial batches, cleanup) into the same closure.
	 *
	 * @param {Emission} region
	 * @param {Emission} [operations]
	 * @returns {string}
	 */
	#wrap_head(region, operations) {
		const scope = this.#scope;
		const id = stringify_string(this.#id);
		// The dispatch helper is only defined when a tail exists; every tail block calls
		// it to receive `s`/`n`, replacing a longer per-block lookup preamble.
		const dispatch = this.#emit_dispatch ? ';s.b=f=>f(s,n)' : '';
		const table = `let n=${scope}||(${scope}={__proto__:null}),s=n[${id}]={a:[],s:[],c:[],p:[]}${dispatch};`;
		const definitions = definitions_source();
		const source = operations === undefined
			? join_sources(['(()=>{', table, definitions, ';return s.a[0]=', region, '})()'])
			: join_sources(['(()=>{', table, definitions, ';let r=s.a[0]=', region, ';', operations, ';return r})()']);
		return this.#render_final(source);
	}

	/**
	 * Emits source that removes a session from the retained table.
	 *
	 * @param {string} id
	 * @returns {string}
	 */
	#cleanup_source(id = this.#id) {
		return `delete n[${stringify_string(id)}]`;
	}

	/**
	 * Generates ordered client operations for a batch taken by the consumer. Emission is
	 * transactional so a fatal failure publishes none of its provisional graph state.
	 *
	 * @param {Event[]} events
	 * @param {boolean} block
	 * @returns {{ source: Emission, close: Source[] }}
	 */
	#emit_batch(events, block = true) {
		const transaction = this.#begin_transaction();
		try {
			let prefix = '';
			let suffix = '';
			if (block && this.#detached) {
				prefix = `;(()=>{let n=${this.#scope},s=n?.[${stringify_string(this.#id)}];`;
				if (!this.#detached_started) prefix += `if(!s)throw new Error(${stringify_string(`devalue: missing session ${this.#id}`)});s.a=[];s.s=[];s.c=[];s.p=[];`;
				this.#detached_started = true;
				suffix = '})()';
			} else if (block) {
				prefix = `;${this.#scope}[${stringify_string(this.#id)}].b((s,n)=>{`;
				suffix = '})';
			}
			const block_start = this.#availability;
			/** @type {Emission[]} */
			const operations = [];
			/** @type {Set<CapturedNode>} */
			const references = new Set();
			/** @type {Source[]} */
			const close = [];
			for (const event of events) {
			if (!this.#is_active()) throw this.#terminal_reason();
			const source = event.source;
			const node = source.node;
			const available = this.#availability;
			const retained_at = ++this.#availability;
			references.add(node);
			const entry = node.data.key === undefined ? undefined : `s.k[${stringify_string(node.data.key)}]`;
			const guard = node.data.key === undefined ? '' : `if(!s.k?.[${stringify_string(node.data.key)}])throw new Error(${stringify_string(`devalue: missing asynchronous value ${node.data.key}`)});`;
			const target = entry ? raw_source(`${entry}[0]`) : reference_source(node, this.#reference_at(node, available)?.path);
			const control = entry ? raw_source(`${entry}[1]`) : node.data.captured ? raw_source(`s.p[${node.data.pending}]`) : undefined;
			const reference = {
				target,
				control
			};
			/** @type {JavaScriptSource | undefined} */
			let value_source;
			/** @type {{ source: JavaScriptSource, write: Emission } | undefined} */
			let anchor;
			/** @type {Emission | undefined} */
			let materialization;
			if (!event.invalid) {
				if (!is_primitive(event.value)) {
					const outcome_node = this.#graph.identities.get(/** @type {object} */ (event.value));
					const retained = outcome_node && this.#reference_at(outcome_node, available);
					/** @type {Emission} */
					let expression;
					if (retained) {
						expression = reference_source(outcome_node, retained.path);
					} else {
						// Persistent: async outcomes must retain Map/Set element and opaque custom
						// child identities for future regions, exactly like the head region.
						const region = this.#emit_region(event.value, true, references, available, retained_at);
						this.#resolve_references(region, available);
						const index = this.#anchor++;
						const path = { kind: /** @type {const} */ ('anchor'), index, segments: [] };
						this.#assign_references(event.value, path, new Map(), retained_at);
						const name = `s.a[${index}]`;
						// Anchor indices are allocated only for new roots, monotonically and densely.
						// Once the push helper pays for itself the client can derive the position.
						const use_helper = this.#runtimes_emitted.v || index > 5;
						const write = use_helper
							? join_sources([runtime_source('v'), '(', region, ')'])
							: join_sources([name, '=', region]);
						expression = write;
						if (source.immediate) {
							const folded = use_helper ? write : join_sources(['(', write, ')']);
							const outcome = outcome_source(region, name, folded);
							select_outcome_source(outcome, 'folded');
							anchor = { source: outcome, write };
							value_source = outcome;
						}
					}
					if (!source.immediate) {
						const local = `o${this.#local++}`;
						materialization = join_sources([`const ${local}=`, expression]);
						value_source = raw_source(local);
					} else if (!value_source) {
						value_source = template_source(expression);
					}
				} else {
					const region = this.#emit_region(event.value, true, references, available, retained_at);
					this.#resolve_references(region, available);
					value_source = template_source(region);
				}
			} else {
				if (source.immediate) {
					value_source = generic_error;
				} else {
					const local = `o${this.#local++}`;
					materialization = `const ${local}=new Error("devalue: failed to serialize asynchronous value")`;
					value_source = raw_source(local);
				}
			}
			if (!value_source) throw this.#error('Cannot stringify value: an async outcome has no materialized client expression before operation generation (internal emitter error)', event.value);

			try {
				let operation;
				if (event.type === 'resolve') operation = source.descriptor.resolve(reference, value_source);
				else if (event.type === 'reject') operation = source.descriptor.reject(reference, value_source);
				else if (event.type === 'next') operation = source.descriptor.next(reference, value_source);
				else if (event.type === 'complete') operation = source.descriptor.complete(reference, value_source);
				else operation = source.descriptor.error(reference, value_source);
				if (!this.#is_active()) throw this.#terminal_reason();
				if (!is_source(operation)) throw new TypeError(`Invalid async descriptor operation: ${event.type}() returned ${describe_received(operation)}. It must synchronously return a js tagged template containing client statements; use js\`\` for an empty operation.`);
				const lowered = this.#lower_descriptor_source(operation, `async descriptor ${event.type}()`, available, retained_at, references);
				if (materialization) operations.push(materialization);
				operations.push(...lowered.prerequisites);
				operations.push(guard ? join_sources([guard, lowered.source]) : lowered.source);
				this.#commit_transaction(lowered.checkpoint, false);
			} catch (error) {
				if (!this.#is_active()) throw error;
				if (event.type === 'resolve' || event.type === 'next' || event.type === 'complete') {
					this.#report(error, event.value);
					// A privately folded adapter is switched back to its separately emitted anchor
					// if its callback unexpectedly fails. Arbitrary operations were already planned
					// around an eager local and publish that materialization exactly once.
					if (anchor) {
						operations.push(anchor.write);
						select_outcome_source(anchor.source, 'anchored');
					} else if (materialization) {
						operations.push(materialization);
					}
					let fallback_value = generic_error;
					if (!source.immediate) {
						const local = `o${this.#local++}`;
						operations.push(`const ${local}=new Error("devalue: failed to serialize asynchronous value")`);
						fallback_value = raw_source(local);
					}
					const fallback = source.type === 'sequence'
						? source.descriptor.error(reference, fallback_value)
						: source.descriptor.reject(reference, fallback_value);
					if (!this.#is_active()) throw this.#terminal_reason();
					if (!is_source(fallback)) throw new TypeError(`Invalid async descriptor operation: fallback ${source.type === 'sequence' ? 'error' : 'reject'}() returned ${describe_received(fallback)}. It must synchronously return a js tagged template containing client statements; use js\`\` for an empty operation.`);
					const context = source.type === 'sequence' ? 'async descriptor fallback error()' : 'async descriptor fallback reject()';
					const lowered = this.#lower_descriptor_source(fallback, context, available, retained_at, references);
					operations.push(...lowered.prerequisites, lowered.source);
					this.#commit_transaction(lowered.checkpoint, false);
					event.type = source.type === 'sequence' ? 'error' : 'reject';
				} else {
					throw error;
				}
			}
			if (event.type !== 'next' && node.data.captured && !source.descriptor.manages_pending) {
				operations.push(`delete s.p[${node.data.pending}]`);
			}
			if (event.type !== 'next') {
				this.#active--;
				if (source.type === 'sequence' && event.type === 'error') close.push(source);
			}
			}
			const rendered = this.#render_operations(operations, references, block_start);
			if (block && this.#active === 0 && this.#batch.length === 0) {
				rendered.push(this.#cleanup_source());
			}
			const body = join_sources(rendered, ';');
			const structured = block
				? join_sources([prefix, definitions_source(), ';', body, suffix])
				: rendered.length ? join_sources([';', body]) : '';
			const result = { source: structured, close };
			this.#commit_transaction(transaction, true);
			return result;
		} catch (error) {
			this.#roll_back_transaction(transaction, error);
			throw error;
		}
	}

	/**
	 * Creates persistent client-slot aliases for repeated long paths when profitable in
	 * this batch, then retains those aliases as the nodes' shortest references.
	 *
	 * @param {Emission[]} operations
	 * @param {Set<CapturedNode>} references
	 * @param {number} available Paths committed before this batch began.
	 * @returns {Emission[]}
	 */
	#render_operations(operations, references, available) {
		/** @type {Map<CapturedNode, number>} */
		const uses = new Map();
		for (const operation of operations) {
			for (const value of source_instructions(operation)) {
				if (value.type !== 'reference') continue;
				uses.set(value.node, (uses.get(value.node) ?? 0) + 1);
			}
		}
		/** @type {{ node: CapturedNode, path: ClientPath, uses: number }[]} */
		const candidates = [];
		for (const node of references) {
			const reference = this.#reference_at(node, available)?.path;
			if (!reference || reference.kind === 'slot') continue;
			const count = uses.get(node) ?? 0;
			if (count < 2) continue;
			candidates.push({ node, path: reference, uses: count });
		}
		candidates.sort((a, b) => reference_length(b.path) - reference_length(a.path));
		/** @type {Map<CapturedNode, ClientPath>} */
		const aliases = new Map();
		/** @type {string[]} */
		const prefix = [];
		for (const { node, path, uses } of candidates) {
			const reference = { kind: /** @type {const} */ ('slot'), index: this.#slot, segments: [] };
			const slot = render_reference(reference);
			const path_length = reference_length(path);
			if (reference_length(reference) + 1 + path_length + 1 + reference_length(reference) * uses >= path_length * uses) continue;
			this.#slot++;
			prefix.push(`${slot}=${render_reference(path)}`);
			aliases.set(node, reference);
			this.#reference_node(node, reference, available);
		}
		for (const operation of operations) {
			for (const instruction of source_instructions(operation)) {
				if (instruction.type !== 'reference') continue;
				instruction.path = aliases.get(instruction.node) ?? this.#resolve_reference(instruction, available);
			}
		}
		return /** @type {Emission[]} */ (prefix).concat(operations);
	}

	/**
	 * Creates the one-shot async iterator that renders ready batches as executable
	 * blocks and drives sequence backpressure as each batch is dequeued.
	 *
	 * @returns {UnevalStreamTail}
	 */
	#tail() {
		const session = this;
		const generator = this.#blocks();
		// Tracks whether the generator has completed, so that `return()` after completion is a
		// no-op like any other async generator instead of re-running cancellation.
		let done = false;
		/** @param {Promise<IteratorResult<string, void>>} result */
		const track = (result) =>
			result.then(
				(result) => {
					if (result.done) done = true;
					return result;
				},
				(error) => {
					done = true;
					throw error;
				}
			);
		/** @type {UnevalStreamTail} */
		const tail = {
			[Symbol.asyncIterator]() {
				return this;
			},
			next: () => track(generator.next()),
			return: async () => {
				if (done) return generator.return();
				done = true;
				// An async generator queues `return()` behind an in-flight `next()`, and `next()`
				// may be parked waiting on a source that never settles. Cancelling first wakes the
				// generator so the pending `next()` completes and the queued `return()` can run.
				const cancelling = session.#cancel();
				const result = await generator.return();
				await cancelling;
				session.#throw_terminal_reason();
				return result;
			}
		};
		return tail;
	}

	/**
	 * Yields each ready batch as an executable block, waiting for sources between
	 * batches. Ends once every source has emitted its terminal operation, or once the session
	 * is cancelled — after cleanup finishes, so consumers observe cleanup failures.
	 *
	 * @returns {AsyncGenerator<string, void, void>}
	 */
	async *#blocks() {
		while (true) {
			while (!this.#batch_ready && this.#active > 0 && this.#is_active()) await this.#sleep();
			if (!this.#is_active()) {
				if (this.#status.state === 'cancelled' || this.#status.state === 'failed') {
					await this.#status.cleanup;
					this.#throw_terminal_reason();
				}
				return;
			}
			if (this.#active === 0) {
				this.#complete();
				return;
			}
			yield /** @type {string} */ (await this.#deliver(this.#take_batch(), true));
		}
	}

	/** Suspends the tail generator until the next `#notify`. The generator is the only waiter. */
	#sleep() {
		return new Promise(/** @param {(value?: void | PromiseLike<void>) => void} resolve */ (resolve) => {
			this.#wake = resolve;
		});
	}

	/** Wakes the tail generator if it is waiting for delivery or a lifecycle change. */
	#notify() {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}

	/**
	 * Reports whether the session may still discover, observe, or generate work.
	 *
	 * @returns {boolean}
	 */
	#is_active() {
		return this.#status.state === 'preparing' || this.#status.state === 'streaming';
	}

	/** Returns the exact terminal reason, including a falsy reason. */
	#terminal_reason() {
		const status = this.#status;
		return status.state === 'cancelled' || status.state === 'failed' ? status.reason : undefined;
	}

	/** Throws the terminal reason when one is present, independently of its truthiness. */
	#throw_terminal_reason() {
		const status = this.#status;
		if ((status.state === 'cancelled' || status.state === 'failed') && status.has_reason) throw status.reason;
	}

	/**
	 * Idempotently records successful completion before releasing lifecycle ownership.
	 * Normal completion never invokes iterator or descriptor cancellation hooks.
	 */
	#complete() {
		if (!this.#is_active()) return;
		this.#status = { state: 'completed' };
		this.#release_lifecycle();
		for (const source of this.#sources) this.#deactivate(source);
		this.#notify();
	}

	/**
	 * Stops source callbacks and releases detachable native observer closures.
	 * @param {Source} source
	 */
	#deactivate(source) {
		source.active = false;
		if (source.observer) {
			source.observer.active = false;
			source.observer.dispatch = undefined;
		}
	}

	/** Detaches externally owned wakeups and discards batches that can no longer be emitted. */
	#release_lifecycle() {
		this.#signal?.removeEventListener('abort', this.#abort);
		if (this.#flush_handle !== undefined) clearTimeout(this.#flush_handle);
		this.#flush_handle = undefined;
		this.#flushing = false;
		this.#batch = [];
		this.#batch_ready = false;
	}

	/**
	 * Transitions to cancellation before synchronously initiating cleanup for every committed source.
	 *
	 * @param {unknown} [reason]
	 * @param {boolean} [has_reason]
	 * @returns {Promise<void>}
	 */
	#cancel(reason, has_reason = arguments.length !== 0) {
		if (!this.#is_active()) {
			const status = this.#status;
			if (status.state === 'cancelled' && has_reason && !status.has_reason) {
				status.has_reason = true;
				status.reason = reason;
			}
			return status.state === 'cancelled' || status.state === 'failed' ? status.cleanup : Promise.resolve();
		}
		return this.#terminate('cancelled', reason, has_reason);
	}

	/**
	 * Makes a generation failure authoritative, waits for cleanup, then throws the exact primary reason.
	 *
	 * @param {unknown} error
	 * @returns {Promise<never>}
	 */
	async #throw_failure(error) {
		const cleanup = this.#is_active()
			? this.#terminate('failed', error, true)
			: this.#status.state === 'cancelled' || this.#status.state === 'failed'
				? this.#status.cleanup
				: Promise.resolve();
		await cleanup;
		this.#throw_terminal_reason();
		throw error;
	}

	/**
	 * Enters a terminal state before callbacks run, starts every close/cancel operation without
	 * awaiting inside the discovery-order loop, and shares one cleanup completion under reentry.
	 *
	 * @param {'cancelled' | 'failed'} state
	 * @param {unknown} reason
	 * @param {boolean} has_reason
	 * @returns {Promise<void>}
	 */
	#terminate(state, reason, has_reason) {
		/** @type {(value?: void | PromiseLike<void>) => void} */
		let finish = () => {};
		const cleanup = new Promise((resolve) => { finish = resolve; });
		/** @type {TerminatingLifecycle} */
		const status = { state, has_reason, reason, cleanup, operations: [] };
		this.#status = status;
		this.#release_lifecycle();
		this.#notify();

		for (const source of this.#sources) {
			if (!source.committed) continue;
			this.#deactivate(source);
			if (source.acquiring) continue;
			const close = this.#close_sequence(source);
			if (close && !status.operations.includes(close)) status.operations.push(close);
			const cancel = this.#cancel_source(source);
			if (cancel && !status.operations.includes(cancel)) status.operations.push(cancel);
		}

		// Reentrant callbacks may finish iterator acquisition after the terminal transition.
		// Settle in the next microtask so those synchronously initiated operations join cleanup.
		void Promise.resolve().then(() => this.#settle_cleanup(status)).then(finish);
		return cleanup;
	}

	/**
	 * Selects cleanup failures deterministically after every initiated operation settles.
	 *
	 * @param {TerminatingLifecycle} status
	 */
	async #settle_cleanup(status) {
		const operations = status.operations;
		const results = await Promise.all(operations.map((operation) => operation.result));
		let primary = -1;
		if (!status.has_reason) {
			primary = results.findIndex((result) => !result.ok);
			if (primary !== -1) {
				const result = results[primary];
				if (result.ok) throw new Error('devalue: cleanup result selection failed');
				status.has_reason = true;
				status.reason = result.error;
			}
		}
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			if (i !== primary && !result.ok) this.#report_cleanup(operations[i], result.error);
		}
		this.#notify();
	}

	/**
	 * Starts a sequence iterator's optional `return()` method at most once, without waiting for
	 * an outstanding pull. Getter, call, and asynchronous failures are immediately observed.
	 *
	 * @param {Source} source
	 * @returns {CleanupOperation | undefined}
	 */
	#close_sequence(source) {
		if (source.close_operation) return source.close_operation;
		if (source.iterator_closed || !source.iterator) return;
		source.iterator_closed = true;
		const operation = this.#create_cleanup(source, 'return');
		source.close_operation = operation;
		try {
			const method = source.iterator.return;
			if (typeof method !== 'function') {
				operation.settle({ ok: true });
				return operation;
			}
			this.#settle_invocation(operation, method.call(source.iterator));
		} catch (error) {
			operation.settle({ ok: false, error });
		}
		return operation;
	}

	/**
	 * Starts one descriptor cancellation hook at most once.
	 * @param {Source} source
	 * @returns {CleanupOperation | undefined}
	 */
	#cancel_source(source) {
		if (source.cancel_operation) return source.cancel_operation;
		if (source.cancel_started) return;
		source.cancel_started = true;
		const operation = this.#create_cleanup(source, 'cancel');
		source.cancel_operation = operation;
		try {
			const cancel = source.descriptor.cancel;
			if (typeof cancel !== 'function') {
				operation.settle({ ok: true });
				return operation;
			}
			this.#settle_invocation(operation, cancel.call(source.descriptor));
		} catch (error) {
			operation.settle({ ok: false, error });
		}
		return operation;
	}

	/**
	 * Creates and registers an always-fulfilled cleanup result before invoking user code, making
	 * getter/callback reentry idempotent and preserving deterministic operation order.
	 * @param {Source} source
	 * @param {'return' | 'cancel'} kind
	 * @returns {CleanupOperation}
	 */
	#create_cleanup(source, kind) {
		/** @type {(result: CleanupResult) => void} */
		let settle = () => {};
		const result = new Promise((resolve) => { settle = resolve; });
		/** @type {CleanupOperation} */
		const operation = { source, kind, reported: false, result, settle };
		const status = this.#status;
		if (status.state === 'cancelled' || status.state === 'failed') status.operations.push(operation);
		return operation;
	}

	/**
	 * Immediately observes an invoked cleanup result and settles its non-rejecting record.
	 * @param {CleanupOperation} operation
	 * @param {unknown} result
	 */
	#settle_invocation(operation, result) {
		Promise.resolve(result).then(
			() => operation.settle({ ok: true }),
			(error) => operation.settle({ ok: false, error })
		);
	}

	/**
	 * Closes a failed sequence diagnostically without delaying delivery of its generated error.
	 * @param {Source} source
	 */
	#close_failed_sequence(source) {
		const operation = this.#close_sequence(source);
		if (!operation) return;
		void operation.result.then((result) => {
			if (!result.ok) this.#report_cleanup(operation, result.error);
		});
	}

	/**
	 * Reports a cleanup failure at most once, preserving the source iterable as diagnostic context.
	 * @param {CleanupOperation} operation
	 * @param {unknown} error
	 */
	#report_cleanup(operation, error) {
		if (operation.reported) return;
		operation.reported = true;
		this.#report(error, operation.source.descriptor.source);
	}

	/**
	 * Forwards a recovered serialization failure to the diagnostic callback. The callback
	 * must never affect stream control flow, so its own exceptions are swallowed.
	 *
	 * @param {unknown} error
	 * @param {unknown} value
	 */
	#report(error, value) {
		try {
			this.#onerror?.(error, value);
		} catch {}
	}

	/**
	 * Creates a DevalueError associated with the initial streamed root.
	 *
	 * @param {string} message
	 * @param {unknown} value
	 * @returns {DevalueError}
	 */
	#error(message, value) {
		return new DevalueError(message, [], value, this.#root?.value);
	}
}

/**
 * Emits a constructor expression for a captured non-container built-in.
 *
 * @param {CapturedNode} node
 * @param {(child: Child) => Emission} expression
 * @returns {Emission}
 */
function scalar(node, expression) {
	switch (node.kind) {
		case 'Number':
		case 'String':
		case 'Boolean':
		case 'BigInt':
			return `Object(${stringify_primitive(node.data)})`;
		case 'Date':
			return `new Date(${node.data})`;
		case 'RegExp': {
			return node.data.flags
				? `new RegExp(${stringify_string(node.data.source)},${stringify_string(node.data.flags)})`
				: `new RegExp(${stringify_string(node.data.source)})`;
		}
		case 'URL':
		case 'URLSearchParams':
			return `new ${node.kind}(${stringify_string(node.data)})`;
		case 'ArrayBuffer':
			// Native TypedArray join; avoids materializing a JS number array first.
			return `new Uint8Array([${node.data.toString()}]).buffer`;
		case 'DataView': {
			return join_sources(['new DataView(', expression(node.children[0]), `,${node.data.byteOffset},${node.data.byteLength})`]);
		}
		case 'Temporal.Duration':
		case 'Temporal.Instant':
		case 'Temporal.PlainDate':
		case 'Temporal.PlainTime':
		case 'Temporal.PlainDateTime':
		case 'Temporal.PlainMonthDay':
		case 'Temporal.PlainYearMonth':
		case 'Temporal.ZonedDateTime':
			return `${node.kind}.from(${stringify_string(node.data)})`;
		default:
			if (is_view(node)) {
				return join_sources([`new ${node.kind}(`, expression(node.children[0]), `,${node.data.byteOffset},${node.data.length})`]);
			}
			throw new Error(`Unknown stream node ${node.kind}`);
	}
}

/**
 * Reports whether a node is an ArrayBuffer view.
 *
 * @param {CapturedNode} node
 * @returns {node is CapturedNode & { kind: ViewKind }}
 */
function is_view(node) {
	const kind = node.kind;
	return kind === 'DataView' || kind.endsWith('Array') && kind !== 'Array';
}

/**
 * Reports whether a node must be constructed after its represented children.
 *
 * @param {CapturedNode} node
 * @returns {boolean}
 */
function is_atomic(node) {
	return node.kind === 'Custom' || node.kind === 'Async' || is_view(node);
}

/**
 * Adds descriptor callback and local-hole context while preserving graph diagnostics.
 * @param {unknown} error
 * @param {unknown} value
 * @param {string} context
 * @param {number} index
 */
function descriptor_interpolation_error(error, value, context, index) {
	const detail = typeof value === 'symbol' ? ' Symbol values cannot be serialized as data.'
		: error instanceof Error ? ` ${error.message}` : '';
	return new TypeError(`Invalid JavaScript source interpolation in ${context}, template hole ${index + 1}: received ${describe_received(value)}.${detail}`);
}

/** @param {object} value */
function is_native_promise(value) {
	// Fast rejection for the common case (plain objects/arrays): a native promise is
	// either same-realm `instanceof Promise` or carries the well-known tag on its
	// prototype chain, which the authoritative walk below requires anyway.
	if (!(value instanceof Promise) && !(Symbol.toStringTag in value)) return false;
	let prototype = Object.getPrototypeOf(value);
	while (prototype) {
		if (Object.prototype.toString.call(prototype) === '[object Promise]') return true;
		prototype = Object.getPrototypeOf(prototype);
	}
	return false;
}

/**
 * Emits the shortest safe property access segment for a string key.
 *
 * @param {string} key
 * @returns {string}
 */
function prop(key) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key) ? `.${key}` : `[${stringify_string(key)}]`;
}

/**
 * Emits the shortest safe object-literal key for a string key.
 *
 * @param {string} key
 * @returns {string}
 */
function literal_key(key) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key) ? key : stringify_string(key);
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Generates a short session key. Session ids only need to be unique within one
 * client table (a collision overwrites a concurrent session), so 48 bits keeps
 * the per-block lookup cost low while making accidental collisions negligible.
 */
function create_session_id() {
	const bytes = new Uint8Array(8);
	if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	return Array.from(bytes, (byte) => ID_ALPHABET[byte & 63]).join('');
}

/** Returns a completed tail iterator for graphs with no asynchronous work. */
function empty_tail() {
	return (async function* () {})();
}

/** Resolves in a fresh macrotask, after any flush already scheduled with `setTimeout(..., 0)`. */
function macrotask() {
	return new Promise(/** @param {(value?: void | PromiseLike<void>) => void} resolve */ (resolve) => setTimeout(resolve, 0));
}

/** @typedef {{ path: ClientPath, available: number, previous: RetainedReference | undefined }} RetainedReference */
/** @typedef {{ nodes: number, sources: number, new_custom: CapturedNode[], validated: Set<CapturedNode>, opaque: number, pending: number, native_pending: number, active: number, availability: number, anchor: number, slot: number, collection: number, local: number, detached_started: boolean, references: Map<CapturedNode, RetainedReference> }} TransactionCheckpoint */
/** @typedef {{ state: 'preparing' | 'streaming' } | { state: 'completed' } | TerminatingLifecycle} Lifecycle */
/** @typedef {{ state: 'cancelled' | 'failed', has_reason: boolean, reason: unknown, cleanup: Promise<void>, operations: CleanupOperation[] }} TerminatingLifecycle */
/** @typedef {{ ok: true } | { ok: false, error: unknown }} CleanupResult */
/** @typedef {{ source: Source, kind: 'return' | 'cancel', reported: boolean, result: Promise<CleanupResult>, settle: (result: CleanupResult) => void }} CleanupOperation */
/** @typedef {{ node: AsyncNode, descriptor: any, type: 'value' | 'sequence' | 'native', immediate: boolean, committed: boolean, started: boolean, terminal: boolean, active: boolean, iterator?: AsyncIterator<unknown>, iterator_closed?: boolean, acquiring?: boolean, next?: AsyncIterator<unknown>['next'], pulling?: boolean, observer?: { active: boolean, dispatch?: (type: 'resolve' | 'reject', result: unknown) => void }, early?: ['resolve' | 'reject', unknown], close_operation?: CleanupOperation, cancel_started?: boolean, cancel_operation?: CleanupOperation }} Source */
/** @typedef {{ source: Source, type: 'resolve' | 'reject' | 'next' | 'complete' | 'error', value: unknown, invalid: boolean }} Event */
