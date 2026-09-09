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
	assert_descriptor_source,
	capture_source,
	count_source,
	definitions_source,
	describe_received,
	expression_source,
	join_sources,
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
	/** Whether the current batch has been finalized and is ready to emit. @type {boolean} */
	#batch_ready = false;
	/** Wakes the tail generator when a batch is ready or the lifecycle changes. @type {(() => void) | undefined} */
	#wake;
	/** Number of async sources whose terminal client operation has not been generated. @type {number} */
	#active = 0;
	/** Whether a batch finalization is currently scheduled. @type {boolean} */
	#flushing = false;
	/** In-flight cleanup; defined once the session has been cancelled. @type {Promise<void> | undefined} */
	#cancelling;
	/** Fatal generation error, cancellation reason, or first cleanup failure. @type {unknown} */
	#failure;
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
	/** Custom nodes already proven acyclic. @type {Set<CapturedNode>} */
	#validated = new Set();
	/** Whether the head must define the block dispatch helper. @type {boolean} */
	#emit_dispatch = false;
	/** Shortest committed client path for each captured identity. @type {Map<CapturedNode, ClientPath>} */
	#references = new Map();
	/** Monotonic owner tag for reusable node planning scratch. */
	#region_id = 0;

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
		this.#abort = () => void this.#cancel(signal?.reason);
		signal?.addEventListener('abort', this.#abort, { once: true });
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
			if (this.#cancelling) throw this.#failure;
		} catch (error) {
			await this.#cancel(error);
			throw this.#failure ?? error;
		}

		if (this.#sources.length === 0) {
			return { head: render_stream_source(this.#emit_region(value, false)), tail: empty_tail(), id: this.#id };
		}

		// start observing the async sources
		this.#start_sources();
		// give them a 1-task window in which they can resolve to be batched into the initial body.
		// Sources settle in microtasks after this point, so always wait at least one macrotask,
		// then keep waiting while a flush is scheduled so the window matches tail batching.
		do await macrotask();
		while (this.#flushing);
		if (this.#failure) throw this.#failure;

		try {
			const head_region = this.#emit_region(value, true);
			this.#assign_references(value, { kind: 'anchor', index: 0, segments: [] }, new Map());
			// anything that settled within the window is folded into the head rather than shipped as a block
			const operations = this.#batch_ready
				? await this.#deliver(this.#take_batch(), false)
				: undefined;

			// if everything resolved in 1 task, then we ended up with a single batch, so we don't need to do anything else
			if (this.#active === 0 && this.#batch.length === 0) {
				const final_operations = operations
					? join_sources([operations, this.#cleanup_source()], ';')
					: this.#cleanup_source();
				return { head: this.#wrap_head(head_region, final_operations), tail: empty_tail(), id: this.#id };
			}

			this.#emit_dispatch = true;
			return { head: this.#wrap_head(head_region, operations), tail: this.#tail(), id: this.#id };
		} catch (error) {
			await this.#cancel(error);
			throw this.#failure ?? error;
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

	/**
	 * Atomically walks a value's devalue-visible graph and discovers async sources.
	 *
	 * Everything a walk touches is either append-only (graph nodes, sources, new custom
	 * nodes) or a counter (pending indices, opaque use counts), so a checkpoint is a few
	 * integers and rollback truncates back to them. Success costs nothing beyond the walk.
	 *
	 * @param {unknown} value
	 * @param {boolean} root
	 * @returns {CapturedNode | undefined}
	 */
	#capture(value, root = false) {
		const graph = this.#graph;
		const nodes = graph.nodes.length;
		const sources = this.#sources.length;
		const custom = this.#new_custom.length;
		const pending = this.#pending;
		const native_pending = this.#native_pending;
		try {
			const node = discover(graph, value);
			this.#validate_new_custom(custom);
			if (root) this.#root = node;
			return node;
		} catch (error) {
			this.#pending = pending;
			this.#native_pending = native_pending;
			for (let i = this.#sources.length - 1; i >= sources; i--) {
				const source = this.#sources[i];
				source.active = false;
				if (source.observer) source.observer.active = false;
			}
			this.#sources.length = sources;
			for (let i = this.#new_custom.length - 1; i >= custom; i--) {
				const children = this.#new_custom[i].children;
				for (let j = 0; j < children.length; j++) {
					const child = children[j];
					if (is_node(child)) child.opaque--;
				}
			}
			this.#new_custom.length = custom;
			roll_back(graph, nodes, error);
			throw error;
		}
	}

	/**
	 * Rejects direct cycles among atomic custom constructors, validating only custom
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
				if (is_node(child) && child.kind === 'Custom') validate(child);
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
		if (this.#replacer) {
			const result = this.#replacer(value, js);
			if (is_source(result)) {
				const values = source_values(result);
				const children = new Array(values.length);
				for (let i = 0; i < values.length; i++) {
					const captured = child(graph, values[i]);
					children[i] = captured;
					if (is_node(captured)) captured.opaque++;
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
			/** @type {{ active: boolean } | undefined} */
			let observer;
			if (is_native_promise(value)) try {
				const current = observer = { active: true };
				/**
				 * Forwards a native Promise fulfillment while its provisional observer is active.
				 *
				 * @param {unknown} result
				 */
				const resolve = (result) => current.active && this.#native_event(value, 'resolve', result);
				/**
				 * Forwards a native Promise rejection while its provisional observer is active.
				 *
				 * @param {unknown} reason
				 */
				const reject = (reason) => current.active && this.#native_event(value, 'reject', reason);
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
					this.#add_source(node, descriptor, 'native').observer = observer;
					this.#native_pending++;
				} catch (error) {
					observer.active = false;
					throw error;
				}
				return true;
			}

			if (Symbol.asyncIterator in value) {
				this.#add_source(node, this.#native_sequence_descriptor(value), 'sequence');
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
	 * @returns {Source}
	 */
	#add_source(node, descriptor, type) {
		let captured = false;
		const pending = this.#pending;
		/** @param {JavaScriptSource} expression */
		const control = (expression) => {
			if (captured) throw new TypeError('devalue: capture may only be called once per async descriptor construct(); capture one js expression containing all private controls, such as js`[resolve,reject]`');
			if (!is_source(expression)) throw new TypeError(`Invalid async descriptor capture: capture() received ${describe_received(expression)}. Pass an expression built with the js tagged template, not a raw value or source string.`);
			assert_descriptor_source(expression, 'async descriptor capture()');
			captured = true;
			return capture_source(pending, expression);
		};
		const source = descriptor.construct(control);
		if (!is_source(source)) throw new TypeError(`Invalid async descriptor construct result: construct() returned ${describe_received(source)}. It must synchronously return a js tagged template representing the client construction expression.`);
		assert_descriptor_source(source, 'async descriptor construct()');
		this.#pending = pending + 1;
		// `node` is reserved but unclassified; this call classifies it, so the cast records
		// the mutation that TypeScript cannot follow.
		const async_node = /** @type {AsyncNode} */ (node);
		/** @type {Source} */
		const state = { node: async_node, descriptor, type, started: false, terminal: false, cleaned: false, active: true };
		async_node.kind = 'Async';
		async_node.data = { source, pending, captured, state };
		this.#sources.push(state);
		if (this.#signal?.aborted) throw this.#signal.reason;
		return state;
	}

	/**
	 * Routes a native Promise outcome to its source, retaining outcomes observed before startup.
	 *
	 * @param {unknown} value
	 * @param {'resolve' | 'reject'} type
	 * @param {unknown} result
	 */
	#native_event(value, type, result) {
		const node = this.#graph.identities.get(/** @type {object} */ (value));
		if (!node) return;
		const source = node.kind === 'Async' ? node.data.state : undefined;
		if (!source?.active) return;
		if (source?.started) this.#event(source, type, result);
		else if (source) source.early = [type, result];
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
			void this.#cancel(this.#signal.reason);
			return;
		}
		this.#start_unstarted();
	}

	/** Starts every source appended since the previous call. */
	#start_unstarted() {
		const sources = this.#sources;
		const end = sources.length;
		for (let i = this.#started; i < end; i++) this.#start(sources[i]);
		this.#started = end;
	}

	/**
	 * Starts observation or iteration for one committed source exactly once.
	 *
	 * @param {Source} source
	 */
	#start(source) {
		if (source.started || this.#cancelling) return;
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
		try {
			const method = source.descriptor.source[Symbol.asyncIterator];
			if (typeof method !== 'function') throw new TypeError('async iterator is not callable');
			const iterator = method.call(source.descriptor.source);
			if ((typeof iterator !== 'object' || iterator === null) && typeof iterator !== 'function') {
				throw new TypeError('async iterator is not an object');
			}
			const next = iterator.next;
			if (typeof next !== 'function') throw new TypeError('async iterator next is not callable');
			source.iterator = iterator;
			source.next = next;
			this.#pull(source);
		} catch (error) {
			this.#event(source, 'error', error);
		}
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
		if (!next || source.terminal || source.pulling || this.#cancelling) return;
		source.pulling = true;
		source.pulled = new Promise((resolve) => {
			source.pulled_resolve = resolve;
		});
		const finish = () => {
			source.pulling = false;
			source.pulled_resolve?.();
			source.pulled_resolve = undefined;
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
				if (source.terminal || this.#cancelling) return;
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
		if (source.terminal || this.#cancelling) return;
		if (type !== 'next') {
			source.terminal = true;
		}
		const event = { source, type, value, invalid: false };
		const source_count = this.#sources.length;
		try {
			this.#capture(value);
			this.#active += this.#sources.length - source_count;
		} catch (error) {
			this.#report(error, value);
			event.type = source.type === 'sequence' ? 'error' : 'reject';
			event.value = undefined;
			event.invalid = true;
		}
		this.#batch.push(event);
		if (!this.#flushing) {
			this.#flushing = true;
			setTimeout(() => this.#flush(), 0);
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

	/** Finalizes the current events as one batch and wakes the tail. Events are already in observation order. */
	#flush() {
		this.#flushing = false;
		if (this.#cancelling || this.#batch.length === 0) return;
		this.#batch_ready = true;
		this.#notify();
	}

	/**
	 * Detaches the finalized batch so new events accumulate separately while it is delivered.
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
		let emitted;
		try {
			emitted = this.#emit_batch(events, block);
		} catch (error) {
			await this.#cancel(error);
			throw this.#failure ?? error;
		}
		for (const source of emitted.close) {
			try {
				await this.#close_sequence(source);
			} catch (error) {
				// The iterator already failed and its client error operation is in this batch, so a
				// failing `return()` has nothing left to affect. Report it and keep streaming.
				this.#report(error, source.descriptor.source);
			}
		}
		this.#start_unstarted();
		this.#consume(events);
		return block ? this.#render_final(emitted.source) : emitted.source;
	}

	/**
	 * Emits one walked graph region, optionally retaining references for future regions.
	 *
	 * @param {unknown} value
	 * @param {boolean} persistent
	 * @param {Set<CapturedNode>} [references]
	 * @returns {Emission}
	 */
	#emit_region(value, persistent, references) {
		// A primitive region has neither graph planning nor unresolved source dependencies.
		if (is_primitive(value)) {
			if (typeof value === 'symbol') throw this.#error('Cannot stringify a Symbol primitive', value);
			return stringify_primitive(value);
		}
		const retained_references = this.#references;
		const identities = this.#graph.identities;
		const region_id = ++this.#region_id;
		/** @type {CapturedNode[]} */
		const order = [];
		/** @param {CapturedNode} node */
		const visit = (node) => {
			if (retained_references.has(node) || node.region_id === region_id) return;
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
		for (const node of order) {
			if (node.uses > 1 || node.opaque > 0 || node.kind === 'NullObject' || is_sparse(node)) {
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
			const retained = retained_references.get(node);
			if (retained && node.region_id !== region_id) {
				references?.add(node);
				return reference_source(node, retained);
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
					return expression_source(node.data.source);
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
						for (let i = 0; i < children.length; i++) {
							const child = children[i];
							if (available(child)) embedded.push(join_sources([`${literal_key(keys[i])}:`, expression_child(child)]));
							else fill.push(join_sources([`${name}${prop(keys[i])}=`, expression_child(child)]));
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
				// Retain only non-primitive elements in a flat sidecar so future regions can
				// reference identities that Set/Map containers do not expose through paths.
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
						this.#reference_node(elements[i], { kind: 'collection', index, segments: [`[${i}]`] });
					}
				}
			}
		}

		const root = expression(value);
		if (persistent) {
			for (const node of order) {
				if (node.opaque === 0) continue;
				const index = this.#slot++;
				slots.push(`s.s[${index}]=${node.name}`);
				/** @type {ClientPath} */
				const reference = { kind: 'slot', index, segments: [] };
				this.#reference_node(node, reference);
				this.#assign_references(node.value, reference, new Map());
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
	 * Records a client reference when it is the shortest known source expression for an identity.
	 *
	 * @param {CapturedNode} node
	 * @param {ClientPath} reference
	 */
	#reference_node(node, reference) {
		const previous = this.#references.get(node);
		if (!previous || reference_length(reference) < reference_length(previous)) {
			this.#references.set(node, reference);
		}
	}

	/**
	 * Resolves a reference hole to a concrete client path: the path fixed when the hole
	 * was created, or else the node's shortest committed path. Every node that reaches
	 * a batch has been anchored by an earlier region, so a miss is an internal error.
	 *
	 * @param {import('./stream-source.js').ReferenceInstruction} hole
	 * @returns {ClientPath}
	 */
	#resolve_reference(hole) {
		const reference = hole.path ?? this.#references.get(hole.node);
		if (!reference) throw this.#error('Cannot stringify value: a client identity has no retained anchor, slot, or collection path before operation generation (internal emitter error)', hole.node.value);
		return reference;
	}

	/** Resolves every reachable structured reference before final rendering. @param {Emission} source */
	#resolve_references(source) {
		for (const instruction of source_instructions(source)) {
			if (instruction.type === 'reference') instruction.path = this.#resolve_reference(instruction);
		}
	}

	/**
	 * Walks stable graph edges and assigns the cheapest reachable client reference to each node.
	 *
	 * @param {unknown} value
	 * @param {ClientPath} reference
	 * @param {Map<CapturedNode, number>} seen
	 */
	#assign_references(value, reference, seen) {
		if (is_primitive(value)) return;
		const node = this.#graph.identities.get(/** @type {object} */ (value));
		if (node) this.#assign_references_node(node, reference, seen);
	}

	/**
	 * @param {CapturedNode} node
	 * @param {ClientPath} reference
	 * @param {Map<CapturedNode, number>} seen
	 */
	#assign_references_node(node, reference, seen) {
		this.#reference_node(node, reference);
		const length = reference_length(reference);
		const previous = seen.get(node);
		if (previous !== undefined && previous <= length) return;
		seen.set(node, length);
		const children = node.children;
		if (node.kind === 'Array') {
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (is_node(child)) this.#assign_references_node(child, append_reference(reference, `[${node.keys[i]}]`), seen);
			}
		} else if (node.kind === 'Object' || node.kind === 'NullObject') {
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (is_node(child)) this.#assign_references_node(child, append_reference(reference, prop(node.keys[i])), seen);
			}
		} else if (is_view(node)) {
			this.#assign_references_node(node.children[0], append_reference(reference, '.buffer'), seen);
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
	 * Emits source that removes this session from the retained table.
	 *
	 * @returns {string}
	 */
	#cleanup_source() {
		const id = stringify_string(this.#id);
		return `delete n[${id}]`;
	}

	/**
	 * Generates ordered client operations for a finalized event batch. Failures here are
	 * fatal to the session, so emission mutates session state directly.
	 *
	 * @param {Event[]} events
	 * @param {boolean} block
	 * @returns {{ source: Emission, close: Source[] }}
	 */
	#emit_batch(events, block = true) {
		const prefix = block ? `;${this.#scope}[${stringify_string(this.#id)}].b((s,n)=>{` : '';
		/** @type {Emission[]} */
		const operations = [];
		/** @type {Set<CapturedNode>} */
		const references = new Set();
		/** @type {Source[]} */
		const close = [];
		for (const event of events) {
			const source = event.source;
			const node = source.node;
			references.add(node);
			const target = reference_source(node, this.#references.get(node));
			const control = node.data.captured ? raw_source(`s.p[${node.data.pending}]`) : undefined;
			const reference = {
				target,
				control
			};
			/** @type {JavaScriptSource} */
			let value_source;
			/** @type {{ source: JavaScriptSource, write: Emission } | undefined} */
			let anchor;
			if (!event.invalid) {
				// Persistent: async outcomes must retain Map/Set element and opaque custom
				// child identities for future regions, exactly like the head region.
				const region = this.#emit_region(event.value, true, references);
				this.#resolve_references(region);
				if (!is_primitive(event.value)) {
					const index = this.#anchor++;
					this.#assign_references(event.value, { kind: 'anchor', index, segments: [] }, new Map());
					const name = `s.a[${index}]`;
					// Implicit anchoring: anchor indices are allocated monotonically and every
					// allocated index is written exactly once in allocation order, so once the
					// push helper pays for itself the client can derive the index positionally
					// (`s.a.push`) instead of receiving it as an explicit assignment. Explicit
					// writes before the switch keep `s.a` dense, so mixing both forms is safe.
					const use_helper = this.#runtimes_emitted.v || index > 5;
					const write = use_helper
						? join_sources([runtime_source('v'), '(', region, ')'])
						: join_sources([name, '=', region]);
					// Defer the anchor write: when the operation uses the value exactly
					// once, the write is folded into that use site. A helper call is a
					// primary expression; only the assignment form needs parentheses.
					const folded = use_helper ? write : join_sources(['(', write, ')']);
					const outcome = outcome_source(region, name, folded);
					anchor = { source: outcome, write };
					value_source = outcome;
				} else {
					value_source = template_source(region);
				}
			} else {
				value_source = generic_error;
			}

			try {
				let operation;
				if (event.type === 'resolve') operation = source.descriptor.resolve(reference, value_source);
				else if (event.type === 'reject') operation = source.descriptor.reject(reference, value_source);
				else if (event.type === 'next') operation = source.descriptor.next(reference, value_source);
				else if (event.type === 'complete') operation = source.descriptor.complete(reference, value_source);
				else operation = source.descriptor.error(reference, value_source);
				if (!is_source(operation)) throw new TypeError(`Invalid async descriptor operation: ${event.type}() returned ${describe_received(operation)}. It must synchronously return a js tagged template containing client statements; use js\`\` for an empty operation.`);
				assert_descriptor_source(operation, `async descriptor ${event.type}()`);
				if (anchor) {
					if (count_source(operation, anchor.source) === 1) select_outcome_source(anchor.source, 'folded');
					else {
						operations.push(anchor.write);
						select_outcome_source(anchor.source, 'anchored');
					}
				}
				operations.push(operation);
			} catch (error) {
				if (event.type === 'resolve' || event.type === 'next' || event.type === 'complete') {
					this.#report(error, event.value);
					// The outcome's identities were assigned anchor references, so the anchor
					// must still ship even though the operation falls back to a generic error.
					if (anchor) operations.push(anchor.write);
					const fallback = source.type === 'sequence'
						? source.descriptor.error(reference, generic_error)
						: source.descriptor.reject(reference, generic_error);
					if (!is_source(fallback)) throw new TypeError(`Invalid async descriptor operation: fallback ${source.type === 'sequence' ? 'error' : 'reject'}() returned ${describe_received(fallback)}. It must synchronously return a js tagged template containing client statements; use js\`\` for an empty operation.`);
					assert_descriptor_source(fallback, source.type === 'sequence' ? 'async descriptor fallback error()' : 'async descriptor fallback reject()');
					operations.push(fallback);
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
		const rendered = this.#render_operations(operations, references);
		if (block && this.#active === 0 && this.#batch.length === 0) {
			rendered.push(this.#cleanup_source());
		}
		const body = join_sources(rendered, ';');
		const structured = block
			? join_sources([prefix, definitions_source(), ';', body, '})'])
			: rendered.length ? join_sources([';', body]) : '';
		return { source: structured, close };
	}

	/**
	 * Creates persistent client-slot aliases for repeated long paths when profitable in
	 * this batch, then retains those aliases as the nodes' shortest references.
	 *
	 * @param {Emission[]} operations
	 * @param {Set<CapturedNode>} references
	 * @returns {Emission[]}
	 */
	#render_operations(operations, references) {
		/** @type {Map<CapturedNode, number>} */
		const uses = new Map();
		/** @type {Map<CapturedNode, ClientPath>} */
		const imported_references = new Map();
		for (const operation of operations) {
			for (const value of source_instructions(operation)) {
				if (value.type !== 'reference') continue;
				uses.set(value.node, (uses.get(value.node) ?? 0) + 1);
				if (value.path && !imported_references.has(value.node)) {
					imported_references.set(value.node, value.path);
				}
			}
		}
		/** @type {{ node: CapturedNode, path: string, uses: number }[]} */
		const candidates = [];
		for (const node of references) {
			const reference = this.#references.get(node);
			if (!reference || reference.kind === 'slot') continue;
			const path = render_reference(imported_references.get(node) ?? reference);
			const count = uses.get(node) ?? 0;
			if (count < 2) continue;
			candidates.push({ node, path, uses: count });
		}
		candidates.sort((a, b) => b.path.length - a.path.length);
		/** @type {Map<CapturedNode, ClientPath>} */
		const aliases = new Map();
		/** @type {string[]} */
		const prefix = [];
		for (const { node, path, uses } of candidates) {
			const reference = { kind: /** @type {const} */ ('slot'), index: this.#slot, segments: [] };
			const slot = render_reference(reference);
			if (reference_length(reference) + 1 + path.length + 1 + reference_length(reference) * uses >= path.length * uses) continue;
			this.#slot++;
			prefix.push(`${slot}=${path}`);
			aliases.set(node, reference);
			this.#references.set(node, reference);
		}
		for (const operation of operations) {
			for (const instruction of source_instructions(operation)) {
				if (instruction.type !== 'reference') continue;
				instruction.path = aliases.get(instruction.node) ?? this.#resolve_reference(instruction);
			}
		}
		return /** @type {Emission[]} */ (prefix).concat(operations);
	}

	/**
	 * Creates the one-shot async iterator that renders finalized batches as executable
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
				if (session.#failure) throw session.#failure;
				return result;
			}
		};
		return tail;
	}

	/**
	 * Yields each finalized batch as an executable block, waiting for sources between
	 * batches. Ends once every source has emitted its terminal operation, or once the session
	 * is cancelled — after cleanup finishes, so consumers observe cleanup failures.
	 *
	 * @returns {AsyncGenerator<string, void, void>}
	 */
	async *#blocks() {
		while (true) {
			while (!this.#batch_ready && this.#active > 0 && !this.#cancelling) await this.#sleep();
			if (this.#cancelling) {
				await this.#cancelling;
				if (this.#failure) throw this.#failure;
				return;
			}
			if (this.#active === 0) return;
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
	 * Idempotently starts server-side cleanup and returns the shared cleanup operation.
	 * `#cancelling` doubles as the cancelled flag for source callbacks and the tail.
	 *
	 * @param {unknown} [reason]
	 * @returns {Promise<void>}
	 */
	#cancel(reason) {
		if (this.#cancelling) return this.#cancelling;
		this.#cancelling = this.#cleanup(reason);
		this.#notify();
		return this.#cancelling;
	}

	/**
	 * Stops all sources, runs every cleanup hook, and records the first resulting failure.
	 *
	 * @param {unknown} reason
	 */
	async #cleanup(reason) {
		this.#signal?.removeEventListener('abort', this.#abort);
		let failure;
		for (const source of this.#sources) {
			if (source.cleaned) continue;
			source.cleaned = true;
			source.active = false;
			if (source.observer) source.observer.active = false;
			try {
				await this.#close_sequence(source);
			} catch (error) {
				failure ??= error;
			}
			try {
				await source.descriptor.cancel?.();
			} catch (error) {
				failure ??= error;
			}
		}
		this.#batch = [];
		this.#batch_ready = false;
		this.#failure ??= failure ?? reason;
		this.#notify();
	}

	/**
	 * Calls a sequence iterator's optional `return()` method at most once.
	 *
	 * @param {Source} source
	 */
	async #close_sequence(source) {
		if (source.iterator_closed || !source.iterator) return;
		source.iterator_closed = true;
		const method = source.iterator.return;
		if (typeof method !== 'function') {
			if (source.pulled) await source.pulled;
			return;
		}
		const returned = Promise.resolve().then(() => method.call(source.iterator));
    if (source.pulled) {
      await Promise.all([source.pulled, returned]);
    }
    else {
      await returned;
    }
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
	 * Records an unrecoverable protocol failure and asynchronously cancels the session.
	 *
	 * @param {unknown} error
	 */
	#fail(error) {
		this.#failure = error;
		void this.#cancel(error);
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
	return node.kind === 'Custom' || is_view(node);
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

/** @typedef {{ node: AsyncNode, descriptor: any, type: 'value' | 'sequence' | 'native', started: boolean, terminal: boolean, cleaned: boolean, active: boolean, iterator?: AsyncIterator<unknown>, iterator_closed?: boolean, next?: AsyncIterator<unknown>['next'], pulling?: boolean, pulled?: Promise<void>, pulled_resolve?: () => void, observer?: { active: boolean }, early?: ['resolve' | 'reject', unknown] }} Source */
/** @typedef {{ source: Source, type: 'resolve' | 'reject' | 'next' | 'complete' | 'error', value: unknown, invalid: boolean }} Event */
