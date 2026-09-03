/**
 * @import {
 *   AsyncSequenceDescriptor,
 *   AsyncValueDescriptor,
 *   UnevalStreamOptions,
 *   UnevalStreamReplacer,
 *   UnevalStreamResult,
 *   UnevalStreamTail
 * } from './types.js'
 * @import { CapturedGraph, CapturedNode, Classification, ClientPath } from './graph.js'
 */

import { DevalueError, is_primitive, stringify_primitive, stringify_string } from './utils.js';
import {
	capture,
	create_captured_graph,
	discover
} from './graph.js';

const promise_then = Promise.prototype.then;
const TOKEN_PATTERN = /"\d+"/g;
const SOURCE = Symbol('JavaScriptSource');

/** @param {TemplateStringsArray | readonly string[]} strings @param {...unknown} values @returns {JavaScriptSource} */
function js(strings, ...values) {
	return create_source(strings, values);
}

/** @param {readonly string[]} strings @param {readonly unknown[]} values @returns {JavaScriptSource} */
function create_source(strings, values) {
	return { [SOURCE]: true, strings, values };
}

const generic_error = js`new Error("devalue: failed to serialize asynchronous value")`;

/** @param {unknown} value @returns {value is JavaScriptSource} */
function is_source(value) {
	return typeof value === 'object' && value !== null && value[SOURCE] === true;
}

/** @param {string} text @returns {JavaScriptSource} */
function raw_source(text) {
	return create_source([text], []);
}

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
	/** Async descriptor states discovered anywhere in the streamed graph. @type {Set<Source>} */
	#sources = new Set();
	/** Events collected during the current scheduled flush window. @type {Event[]} */
	#batch = [];
	/** Whether the current batch has been finalized and is ready to emit. @type {boolean} */
	#batch_ready = false;
	/** Resolvers for tail reads waiting for delivery or a lifecycle change. @type {Array<() => void>} */
	#waiters = [];
	/** Monotonic observation order assigned before events are batched. @type {number} */
	#sequence = 0;
	/** Number of async sources whose terminal client operation has not been generated. @type {number} */
	#active = 0;
	/** Whether a batch finalization is currently scheduled. @type {boolean} */
	#flushing = false;
	/** Whether server-side observation and queued delivery have been cancelled. @type {boolean} */
	#cancelled = false;
	/** In-flight cleanup shared by repeated cancellation requests. @type {Promise<void> | undefined} */
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
	/** Next collision-proof placeholder id shared by every replacement phase. @type {number} */
	#token = 0;
	/** @type {Map<string, keyof typeof RUNTIMES>} */
	#runtime_tokens = new Map();
	/** @type {Map<string, number>} */
	#promise_tokens = new Map();
	/** Stable AbortSignal listener that forwards cancellation. @type {() => void} */
	#abort;
	/** Canonical captured node for the initial graph root. @type {CapturedNode | undefined} */
	#root;
	/** Committed sources not yet started. @type {Source[]} */
	#unstarted = [];
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
	/** Existing opaque values changed by the active capture. @type {Map<CapturedNode, boolean> | undefined} */
	#capture_opaque;
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
		this.#graph = create_captured_graph(root, (value, node, graph) => this.#classify(value, node, graph));
		this.#abort = () => void this.#cancel(signal?.reason);
		signal?.addEventListener('abort', this.#abort, { once: true });
	}

	/** @param {unknown} value @returns {Promise<UnevalStreamResult>} */
	async serialize(value) {
		try {
			this.#capture(value, true);
			this.#commit();
		} catch (error) {
			await this.#cancel(error);
			throw this.#failure ?? error;
		}
		if (this.#cancelled) {
			await this.#cancel(this.#failure);
			throw this.#failure;
		}

		if (this.#sources.size === 0) {
			return { head: this.#emit_region(value, false).source, tail: empty_tail(), id: this.#id };
		}

		this.#start_sources();
		await this.#initial_window();
		if (this.#failure) throw this.#failure;

		try {
			const head_region = this.#emit_region(value, true);
			this.#assign_references(value, { root: 's.a[0]', segments: [] }, new Map());
			let operations = '';
			if (this.#batch_ready) {
				const batch = { events: this.#batch };
				const emitted = this.#emit_batch(batch, false);
				operations += emitted.source;
				this.#batch = [];
				this.#batch_ready = false;
				for (const source of emitted.close) {
					try {
						await this.#close_sequence(source);
					} catch (error) {
						await this.#cancel(error);
						throw this.#failure ?? error;
					}
				}
				this.#consume(batch);
			}
			this.#start_unstarted();

			if (this.#active === 0 && this.#batch.length === 0) {
				return { head: this.#wrap_head(head_region, operations + this.#cleanup_source()), tail: empty_tail(), id: this.#id };
			}

			this.#emit_dispatch = true;
			return { head: this.#wrap_head(head_region, operations), tail: this.#tail(), id: this.#id };
		} catch (error) {
			await this.#cancel(error);
			throw this.#failure ?? error;
		}
	}

	/**
	 * Returns a placeholder for a session helper (`s.f`, `s.w`, `s.r`, `s.v`). The placeholder is
	 * replaced — and the helper's definition shipped, at most once per session — when a
	 * finished block is assembled, so definitions always precede uses in evaluation order
	 * regardless of hoisting or discovery order.
	 *
	 * @param {keyof typeof RUNTIMES} key
	 * @returns {string}
	 */
	#runtime_token(key) {
		const token = this.#placeholder();
		this.#runtime_tokens.set(token, key);
		return token;
	}

	/**
	 * Returns a placeholder for a native pending-promise construct. At block assembly it
	 * is replaced with a call to the shared `s.w` helper.
	 *
	 * @param {number} pending
	 * @returns {string}
	 */
	#promise_token(pending) {
		const token = this.#placeholder();
		this.#promise_tokens.set(token, pending);
		return token;
	}

	/**
	 * Replaces runtime and promise placeholders in finished block source, returning the
	 * helper definitions that must be evaluated before it. Definitions are emitted at most
	 * once per session.
	 *
	 * @param {string} source
	 * @returns {{ defs: string[], source: string }}
	 */
	#resolve_runtime_declarations(source) {
		/** @type {string[]} */
		const defs = [];
		if (this.#runtime_tokens.size === 0 && this.#promise_tokens.size === 0) return { defs, source };
		/** @param {keyof typeof RUNTIMES} key */
		const define = (key) => {
			const emitted = this.#runtimes_emitted;
			if (emitted[key]) return;
			emitted[key] = true;
			defs.push(`s.${key}=${RUNTIMES[key]}`);
		};
		const resolved = source.replace(TOKEN_PATTERN, (token) => {
			const pending = this.#promise_tokens.get(token);
			if (pending !== undefined) {
				define('w');
				return `s.w(${pending})`;
			}
			const key = this.#runtime_tokens.get(token);
			if (!key) return token;
			define(key);
			return `s.${key}`;
		});
		return { defs, source: resolved };
	}

	/**
	 * Transactionally walks a value's devalue-visible graph and discovers async sources.
	 *
	 * @param {unknown} value
	 * @param {boolean} root
	 * @returns {CapturedNode | undefined}
	 */
	#capture(value, root = false) {
		const pending = this.#pending;
		const native_pending = this.#native_pending;
		const sources = new Set(this.#sources);
		const unstarted = this.#unstarted.length;
		const custom = this.#new_custom.length;
		const opaque = new Map();
		this.#capture_opaque = opaque;
		try {
			const node = capture(this.#graph, value, () => this.#validate_new_custom(custom));
			if (root) this.#root = node;
			return node;
		} catch (error) {
			this.#pending = pending;
			this.#native_pending = native_pending;
			for (let i = this.#unstarted.length - 1; i >= unstarted; i--) {
				const source = this.#unstarted[i];
				source.active = false;
				if (source.observer) source.observer.active = false;
				if (!sources.has(source)) this.#sources.delete(source);
			}
			this.#unstarted.length = unstarted;
			this.#new_custom.length = custom;
			for (const [node, previous] of opaque) {
				if (previous) node.opaque = true;
				else delete node.opaque;
			}
			throw error;
		} finally {
			this.#capture_opaque = undefined;
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
			for (const child of node.data.values) {
				if (child?.kind === 'Custom') validate(child);
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
	 * AsyncIterable. Returning false delegates to graph's built-in discovery.
	 *
	 * @param {unknown} value
	 * @param {CapturedNode} node
	 * @param {CapturedGraph} graph
	 * @returns {Classification | false}
	 */
	#classify(value, node, graph) {
		if (this.#replacer) {
			const result = this.#replacer(value, js);
			if (is_source(result)) {
				const values = source_values(result);
				const dependencies = [];
				const edges = [];
				for (const child of values) {
					const child_node = discover(graph, child);
					dependencies.push(child_node);
					edges.push(child_node ? { node: child_node.id } : { value: child });
					if (child_node) {
						if (this.#capture_opaque && !this.#capture_opaque.has(child_node)) {
							this.#capture_opaque.set(child_node, child_node.opaque === true);
						}
						child_node.opaque = true;
					}
				}
				this.#new_custom.push(node);
				return { kind: 'Custom', data: { source: result, values: dependencies }, edges };
			}
			if (result !== undefined && result !== null && result !== false) {
				if (typeof result !== 'object' || !Object.hasOwn(result, 'type')) {
					throw new TypeError('Invalid unevalStream replacer result');
				}
				if (result.type === 'async-value') {
					this.#validate_value_descriptor(result);
					return this.#add_source(node, result, 'value').classification;
				}
				if (result.type === 'async-sequence') {
					this.#validate_sequence_descriptor(result);
					return this.#add_source(node, result, 'sequence').classification;
				}
				throw new TypeError('Invalid unevalStream replacer result');
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
				let added;
				try {
					added = this.#add_source(node, descriptor, 'native');
					added.state.observer = observer;
					this.#native_pending++;
				} catch (error) {
					observer.active = false;
					throw error;
				}
				return added.classification;
			}

			if (Symbol.asyncIterator in value) {
				return this.#add_source(node, this.#native_sequence_descriptor(value), 'sequence').classification;
			}
		}
		return false;
	}

	/**
	 * Constructs an async descriptor target once and stages its server source state.
	 *
	 * @param {CapturedNode} node
	 * @param {any} descriptor
	 * @param {'value' | 'sequence' | 'native'} type
	 * @returns {{ state: Source, classification: Classification }}
	 */
	#add_source(node, descriptor, type) {
		let captured = false;
		const pending = this.#pending;
		const control = (expression) => {
			if (captured) throw new TypeError('devalue: capture may only be called once');
			if (!is_source(expression)) throw new TypeError('Invalid async descriptor capture');
			captured = true;
			return /** @type {JavaScriptSource} */ ({ [SOURCE]: true, strings: ['', ''], values: [{ type: 'capture', pending, source: expression }] });
		};
		const source = descriptor.construct(control);
		if (!is_source(source)) throw new TypeError('Invalid async descriptor construct result');
		this.#pending = pending + 1;
		/** @type {Source} */
		const state = { node, descriptor, type, started: false, terminal: false, cleaned: false, active: true, flushed_pending: 0 };
		const classification = { kind: 'Async', data: { source, pending, captured, state }, edges: [] };
		this.#sources.add(state);
		this.#unstarted.push(state);
		if (this.#signal?.aborted) throw this.#signal.reason;
		return { state, classification };
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

	/** @param {Promise<unknown>} promise @returns {AsyncValueDescriptor & { manages_pending: true }} */
	#native_descriptor(promise) {
		let pending = -1;
		const settle = (reference, which, value) => {
			const remaining = this.#native_pending--;
			if (this.#runtimes_emitted.r || remaining >= 3) {
				return js`${raw_source(this.#runtime_token('r'))}(${pending},${which},${value})`;
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
				return raw_source(this.#promise_token(pending));
			},
			resolve: (reference, value) => settle(reference, 0, value),
			reject: (reference, reason) => settle(reference, 1, reason)
		};
	}

	/** @param {object} source @returns {AsyncSequenceDescriptor} */
	#native_sequence_descriptor(source) {
		return {
			type: 'async-sequence',
			source: /** @type {AsyncIterable<unknown, unknown, unknown>} */ (source),
			construct: (capture) => js`${raw_source(this.#runtime_token('f'))}(g=>{${capture(js`g`)}})`,
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
		if ((typeof descriptor.source !== 'object' || descriptor.source === null) && typeof descriptor.source !== 'function') {
			throw new TypeError('Invalid async-value source');
		}
		for (const key of ['construct', 'resolve', 'reject']) {
			if (typeof descriptor[key] !== 'function') throw new TypeError(`Invalid async-value ${key}`);
		}
		if (descriptor.cancel !== undefined && typeof descriptor.cancel !== 'function') {
			throw new TypeError('Invalid async-value cancel');
		}
	}

	/**
	 * Validates the synchronous shape of an async sequence descriptor without acquiring an iterator.
	 *
	 * @param {any} descriptor
	 */
	#validate_sequence_descriptor(descriptor) {
		if ((typeof descriptor.source !== 'object' || descriptor.source === null) && typeof descriptor.source !== 'function') {
			throw new TypeError('Invalid async-sequence source');
		}
		for (const key of ['construct', 'next', 'complete', 'error']) {
			if (typeof descriptor[key] !== 'function') throw new TypeError(`Invalid async-sequence ${key}`);
		}
		if (descriptor.cancel !== undefined && typeof descriptor.cancel !== 'function') {
			throw new TypeError('Invalid async-sequence cancel');
		}
	}

	/**
	 * Commits initial capture and initializes the count of client values awaiting termination.
	 *
	 */
	#commit() {
		this.#active = this.#sources.size;
	}

	/** Starts every committed source unless the constructor's AbortSignal listener has cancelled the session. */
	#start_sources() {
		if (this.#signal?.aborted) {
			void this.#cancel(this.#signal.reason);
			return;
		}
		this.#start_unstarted();
	}

	#start_unstarted() {
		const sources = this.#unstarted;
		this.#unstarted = [];
		for (const source of sources) this.#start(source);
	}

	/**
	 * Starts observation or iteration for one committed source exactly once.
	 *
	 * @param {Source} source
	 */
	#start(source) {
		if (source.started || this.#cancelled) return;
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
		if (source.terminal || source.pulling || this.#cancelled) return;
		source.pulling = true;
		source.pulled = new Promise((resolve) => {
			source.pulled_resolve = resolve;
		});
		const finish = () => {
			source.pulling = false;
			source.pulled_resolve?.();
			source.pulled_resolve = undefined;
		};
		const next = source.next;
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
				if (source.terminal || this.#cancelled) return;
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
		if (source.terminal || this.#cancelled) return;
		if (type !== 'next') {
			source.terminal = true;
		}
		const event = { source, type, value, sequence: this.#sequence++, invalid: false };
		const source_count = this.#sources.size;
		try {
			this.#capture(value);
			this.#active += this.#sources.size - source_count;
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
	 * Marks a batch's events as emitted or dequeued and resumes sequence pulling for
	 * sources with no other undelivered events.
	 *
	 * @param {Batch} batch
	 */
	#consume(batch) {
		for (const event of batch.events) event.source.flushed_pending--;
		for (const event of batch.events) {
			if (event.type === 'next' && event.source.flushed_pending === 0) this.#pull(event.source);
		}
	}

	/** Finalizes the current events as one ordered batch and wakes waiting tail reads. */
	#flush() {
		this.#flushing = false;
		if (this.#cancelled || this.#batch.length === 0) return;
		this.#batch.sort((a, b) => a.sequence - b.sequence);
		for (const event of this.#batch) event.source.flushed_pending++;
		this.#batch_ready = true;
		this.#notify();
	}

	/** Waits for the same scheduled flush window used by tail batches before freezing the head. */
	#initial_window() {
		return new Promise(/** @param {(value?: void | PromiseLike<void>) => void} resolve */ (resolve) => {
			const settle = () => setTimeout(() => this.#flushing ? settle() : resolve(), 0);
			settle();
		});
	}

	/**
	 * Emits one walked graph region, optionally retaining references for future regions.
	 *
	 * @param {unknown} value
	 * @param {boolean} persistent
	 * @param {Set<CapturedNode>} [references]
	 * @returns {{ source: string, tokens: Map<string, { node: CapturedNode, reference: ClientPath }> }}
	 */
	#emit_region(value, persistent, references) {
		const retained_references = this.#references;
		/** Canonical node list; recorded edges resolve through indices rather than identity lookups. */
		const nodes_list = this.#graph.nodes;
		const identities = this.#graph.identities;
		/** Resolves a recorded edge to its node, or undefined for a primitive edge. @param {{ node: number } | { value: unknown }} reference */
		const node_of = (reference) => 'node' in reference ? /** @type {CapturedNode} */ (nodes_list[reference.node]) : undefined;

		const region_id = ++this.#region_id;
		/** @type {CapturedNode[]} */
		const order = [];
		/** @param {CapturedNode | undefined} node */
		const visit = (node) => {
			if (!node || retained_references.has(node) || node.region_id === region_id) return;
			node.region_id = region_id;
			node.uses = 0;
			node.hoisted = false;
			node.early = false;
			node.latest = -1;
			node.name = '';
			node.rendering = false;
			// Post-order: children are declared before parents so declarations can embed
			// them as literals; only back-edges (cycles) need post-declaration patches.
			for (const edge of node.edges) visit(node_of(edge));
			node.position = order.push(node) - 1;
		};
		if (!is_primitive(value)) visit(identities.get(/** @type {object} */ (value)));

		/**
		 * Invokes a callback for each represented child node (undefined for primitive
		 * children) with its in-region occurrence count.
		 *
		 * @param {CapturedNode} node
		 * @param {(child: CapturedNode | undefined, occurrences: number) => void} callback
		 */
		const each_child = (node, callback) => {
			switch (node.kind) {
				case 'Array':
				case 'Object':
				case 'NullObject':
					for (const entry of node.data.entries) callback(node_of(entry[1]), 1);
					break;
				case 'Set':
					for (const member of node.data.values) callback(node_of(member), 1);
					break;
				case 'Map':
					for (const entry of node.data.entries) {
						callback(node_of(entry[0]), 1);
						callback(node_of(entry[1]), 1);
					}
					break;
				case 'Custom':
					for (const child of node.data.values) callback(child, 1);
					break;
				default:
					if (is_view(node.kind)) callback(node_of(node.data.buffer), 1);
			}
		};

		// In-region use counts; a node used once can be inlined at its single use site.
		/**
		 * @param {CapturedNode | undefined} node
		 * @param {number} occurrences
		 */
		const bump = (node, occurrences = 1) => {
			if (node?.region_id === region_id) node.uses += occurrences;
		};
		if (!is_primitive(value)) bump(identities.get(/** @type {object} */ (value)));
		for (const node of order) {
			each_child(node, bump);
			// Persistent Set/Map sidecars re-reference each retained element, so those
			// elements must be hoisted names rather than duplicated inline literals.
			if (persistent && (node.kind === 'Set' || node.kind === 'Map')) each_child(node, bump);
		}

		/** @param {CapturedNode} node */
		const is_sparse = (node) => node.kind === 'Array' && node.data.entries.length !== node.data.length;
		let hoisted_count = 0;
		for (const node of order) {
			if (node.uses > 1 || node.opaque || node.kind === 'NullObject' || is_sparse(node)) {
				node.hoisted = true;
				hoisted_count++;
			}
		}

		// Containers that must be declared (empty) ahead of every literal declaration
		// because an atomic node's constructor needs their name before their post-order slot.
		/**
		 * Reports whether a child's expansion reaches a name declared at or after `limit`.
		 *
		 * @param {CapturedNode | undefined} node
		 * @param {number} limit
		 * @param {Set<CapturedNode>} seen
		 * @returns {boolean}
		 */
		const references_later = (node, limit, seen) => {
			if (!node || node.region_id !== region_id) return false;
			if (node.hoisted) return node.early ? false : node.position >= limit;
			if (seen.has(node)) return false;
			seen.add(node);
			let found = false;
			each_child(node, (child) => {
				if (!found && references_later(child, limit, seen)) found = true;
			});
			return found;
		};
		// Atomic nodes (customs, views) embed child expressions in their declaration and
		// cannot defer them to fills. A direct container child whose expansion reaches a name
		// declared at or after the atomic is hoisted (its back-edges become fills); a direct
		// child that is itself a later-declared hoisted container is declared empty up front;
		// a direct atomic child is secured recursively (atomics cannot defer anything).
		/** @param {CapturedNode} node */
		const secure_atomic = (node) => {
			const limit = node.position;
			each_child(node, (child_node) => {
				if (!child_node || child_node.region_id !== region_id) return;
				if (child_node.hoisted) {
					if (!child_node.early && child_node.position >= limit) {
						child_node.early = true;
					}
					return;
				}
				if (!references_later(child_node, limit, new Set())) return;
				if (is_atomic(child_node.kind)) secure_atomic(child_node);
				child_node.hoisted = true;
				hoisted_count++;
			});
		};
		for (const node of order) {
			if (is_atomic(node.kind) && node.hoisted) secure_atomic(node);
		}

		// `hoisted` and `early` are final now, so "does this child's expansion reach a
		// name declared at or after position `limit`?" reduces to one memoized number per
		// node: the latest declaration position its inline expansion can reach. Children
		// precede parents in post-order, and any back-edge target is necessarily hoisted
		// (a cycle entry always has two or more uses), so one bottom-up pass suffices.
		/**
		 * @param {CapturedNode | undefined} node
		 * @returns {number}
		 */
		const latest_of = (node) => {
			if (!node || node.region_id !== region_id) return -1;
			if (node.hoisted) return node.early ? -1 : node.position;
			return node.latest;
		};
		/**
		 * @param {{ node: number } | { value: unknown }} reference
		 * @returns {number}
		 */
		const latest_of_ref = (reference) => 'value' in reference ? -1 : latest_of(/** @type {CapturedNode} */ (nodes_list[reference.node]));
		if (hoisted_count > 0) {
			for (const node of order) {
				if (node.hoisted) continue;
				let reach = -1;
				each_child(node, (child) => {
					const value = latest_of(child);
					if (value > reach) reach = value;
				});
				node.latest = reach;
			}
		}

		let name_count = 0;
		for (const node of order) if (node.hoisted) node.name = `v${name_count++}`;

		/** @type {string[]} */
		const fill = [];
		/** @type {string[]} */
		const sidecars = [];
		/** @type {string[]} */
		const slots = [];
		const tokens = new Map();
		/**
		 * @param {unknown} thing
		 * @returns {string}
		 */
		const expression = (thing) => {
			if (is_primitive(thing)) return stringify_primitive(thing);
			const node = identities.get(/** @type {object} */ (thing));
			if (!node) throw this.#error('Cannot stringify value', thing);
			return expression_node(node);
		};
		/**
		 * @param {CapturedNode} node
		 * @returns {string}
		 */
		const expression_node = (node) => {
			const retained = retained_references.get(node);
			if (retained && node.region_id !== region_id) {
				references?.add(node);
				if (references) {
					const token = this.#placeholder();
					tokens.set(token, { node, reference: retained });
					return token;
				}
				return render_reference(retained);
			}
			if (node.region_id === region_id && node.name) return node.name;
			// `rendering` guards against unexpected re-entry while expanding inline.
			if (node.rendering) throw this.#error('Cannot stringify value', node.value);
			node.rendering = true;
			try {
				return inline(node);
			} finally {
				node.rendering = false;
			}
		};
		/** @param {{ node: number } | { value: unknown }} reference */
		const expression_ref = (reference) =>
			'value' in reference ? stringify_primitive(reference.value) : expression_node(/** @type {CapturedNode} */ (nodes_list[reference.node]));

		/**
		 * Emits the full construction of a single-use node at its use site.
		 *
		 * @param {CapturedNode} node
		 * @returns {string}
		 */
		const inline = (node) => {
			switch (node.kind) {
				case 'Array':
					return `[${node.data.entries.map((/** @type {[string, any]} */ entry) => expression_ref(entry[1])).join(',')}]`;
				case 'Object':
					return `{${node.data.entries.map((/** @type {[string, any]} */ entry) => `${literal_key(entry[0])}:${expression_ref(entry[1])}`).join(',')}}`;
				case 'Set': {
					const members = node.data.values;
					return members.length ? `new Set([${members.map(expression_ref).join(',')}])` : 'new Set';
				}
				case 'Map': {
					const entries = node.data.entries;
					return entries.length
						? `new Map([${entries.map((/** @type {[any, any]} */ entry) => `[${expression_ref(entry[0])},${expression_ref(entry[1])}]`).join(',')}])`
						: 'new Map';
				}
				case 'Async':
					return render_descriptor_source(node.data.source);
				case 'Custom': {
					return render_source(node.data.source, expression);
				}
				default:
					return scalar(node, expression_ref);
			}
		};

		/** @type {string[]} */
		const early_declarations = [];
		/** @type {string[]} */
		const declarations = [];
		for (const node of order) {
			const name = node.name;
			if (name && node.early) {
				// Declared empty ahead of every literal so atomic constructors can reference it.
				switch (node.kind) {
					case 'Array':
						early_declarations.push(`${name}=Array(${node.data.length})`);
						for (const [key, child] of node.data.entries) fill.push(`${name}[${key}]=${expression_ref(child)}`);
						break;
					case 'Object':
					case 'NullObject':
						early_declarations.push(`${name}=${node.kind === 'NullObject' ? 'Object.create(null)' : '{}'}`);
						for (const [key, child] of node.data.entries) fill.push(`${name}${prop(key)}=${expression_ref(child)}`);
						break;
					case 'Set':
						early_declarations.push(`${name}=new Set`);
						for (const child of node.data.values) fill.push(`${name}.add(${expression_ref(child)})`);
						break;
					case 'Map':
						early_declarations.push(`${name}=new Map`);
						for (const [key, child] of node.data.entries) fill.push(`${name}.set(${expression_ref(key)},${expression_ref(child)})`);
						break;
					default:
						throw this.#error('Cannot stringify value', node.value);
				}
			} else if (name) {
				// A child can be embedded in this declaration if its expansion never reaches
				// a name declared at or after this node; back-edges become fills instead.
				const limit = node.position;
				/** @param {{ node: number } | { value: unknown }} child */
				const available = (child) => latest_of_ref(child) < limit;
				switch (node.kind) {
					case 'Array': {
						if (is_sparse(node)) {
							declarations.push(`${name}=Array(${node.data.length})`);
							for (const [key, child] of node.data.entries) fill.push(`${name}[${key}]=${expression_ref(child)}`);
							break;
						}
						const parts = [];
						for (const [key, child] of node.data.entries) {
							if (available(child)) parts.push(expression_ref(child));
							else {
								parts.push('');
								fill.push(`${name}[${key}]=${expression_ref(child)}`);
							}
						}
						// A trailing elision needs one extra comma to preserve length.
						declarations.push(`${name}=[${parts.join(',')}${parts.length && parts[parts.length - 1] === '' ? ',' : ''}]`);
						break;
					}
					case 'Object': {
						const embedded = [];
						for (const [key, child] of node.data.entries) {
							if (available(child)) embedded.push(`${literal_key(key)}:${expression_ref(child)}`);
							else fill.push(`${name}${prop(key)}=${expression_ref(child)}`);
						}
						declarations.push(`${name}={${embedded.join(',')}}`);
						break;
					}
					case 'NullObject': {
						declarations.push(`${name}=Object.create(null)`);
						for (const [key, child] of node.data.entries) fill.push(`${name}${prop(key)}=${expression_ref(child)}`);
						break;
					}
					case 'Set': {
						// Insertion order is observable, so embed only when every member is ready.
						const members = node.data.values;
						if (members.every(available)) {
							declarations.push(`${name}=${members.length ? `new Set([${members.map(expression_ref).join(',')}])` : 'new Set'}`);
						} else {
							declarations.push(`${name}=new Set`);
							for (const child of members) fill.push(`${name}.add(${expression_ref(child)})`);
						}
						break;
					}
					case 'Map': {
						const entries = node.data.entries;
						if (entries.every((/** @type {[any, any]} */ [key, child]) => available(key) && available(child))) {
							declarations.push(`${name}=${entries.length ? `new Map([${entries.map((/** @type {[any, any]} */ [key, child]) => `[${expression_ref(key)},${expression_ref(child)}]`).join(',')}])` : 'new Map'}`);
						} else {
							declarations.push(`${name}=new Map`);
							for (const [key, child] of entries) fill.push(`${name}.set(${expression_ref(key)},${expression_ref(child)})`);
						}
						break;
					}
					default:
						declarations.push(`${name}=${inline(node)}`);
				}
			}
			if (persistent && (node.kind === 'Set' || node.kind === 'Map')) {
				// Retain only non-primitive elements in a flat sidecar so future regions can
				// reference identities that Set/Map containers do not expose through paths.
				/** @type {Array<{ node: number }>} */
				const elements = (node.kind === 'Set' ? node.data.values : node.data.entries.flat())
					.filter((/** @type {{ node: number } | { value: unknown }} */ child) => 'node' in child);
				if (elements.length) {
					const index = this.#collection++;
					sidecars.push(`s.c[${index}]=[${elements.map(expression_ref).join(',')}]`);
					for (let i = 0; i < elements.length; i++) {
						const child = elements[i];
						this.#reference_node(/** @type {CapturedNode} */ (nodes_list[child.node]), { root: `s.c[${index}]`, segments: [`[${i}]`] });
					}
				}
			}
		}

		const root = expression(value);
		if (persistent) {
			for (const node of order) {
				if (!node.opaque) continue;
				const index = this.#slot++;
				slots.push(`s.s[${index}]=${node.name}`);
				const reference = { root: `s.s[${index}]`, segments: [] };
				this.#reference_node(node, reference);
				this.#assign_references(node.value, reference, new Map());
			}
		}
		const all_declarations = early_declarations.concat(declarations);
		const statements = [
			...(all_declarations.length ? [`let ${all_declarations.join(',')}`] : []),
			...fill,
			...sidecars,
			...slots
		];
		const body = [...statements, `return ${root}`].join(';');
		return { source: statements.length ? `(()=>{${body}})()` : root, tokens };
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
		const nodes_list = this.#graph.nodes;
		if (node.kind === 'Array') {
			for (const [key, child] of node.data.entries) {
				if ('node' in child) this.#assign_references_node(nodes_list[child.node], append_reference(reference, `[${key}]`), seen);
			}
		} else if (node.kind === 'Object' || node.kind === 'NullObject') {
			for (const [key, child] of node.data.entries) {
				if ('node' in child) this.#assign_references_node(nodes_list[child.node], append_reference(reference, prop(key)), seen);
			}
		} else if (is_view(node.kind)) {
			const buffer = node.data.buffer;
			if ('node' in buffer) this.#assign_references_node(nodes_list[buffer.node], append_reference(reference, '.buffer'), seen);
		}
	}

	/**
	 * Wraps the head region with client table and session initialization, folding any
	 * pre-head operations (initial batches, cleanup) into the same closure.
	 *
	 * @param {{ source: string }} region
	 * @param {string} [operations]
	 * @returns {string}
	 */
	#wrap_head(region, operations = '') {
		const scope = this.#scope;
		const id = stringify_string(this.#id);
		// The dispatch helper is only defined when a tail exists; every tail block calls
		// it to receive `s`/`n`, replacing a longer per-block lookup preamble.
		const dispatch = this.#emit_dispatch ? ';s.b=f=>f(s,n)' : '';
		const table = `let n=${scope}||(${scope}={__proto__:null}),s=n[${id}]={a:[],s:[],c:[],p:[]}${dispatch}`;
		// Resolve in evaluation order: the root region runs before folded operations.
		const resolved_region = this.#resolve_runtime_declarations(region.source);
		const resolved_operations = this.#resolve_runtime_declarations(operations);
		const defs = resolved_region.defs.concat(resolved_operations.defs);
		const prelude = defs.length ? `;${defs.join(';')}` : '';
		operations = resolved_operations.source;
		if (!operations) return `(()=>{${table}${prelude};return s.a[0]=${resolved_region.source}})()`;
		if (!operations.endsWith(';')) operations += ';';
		return `(()=>{${table}${prelude};let r=s.a[0]=${resolved_region.source};${operations}return r})()`;
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
	 * @param {Batch} batch
	 * @param {boolean} block
	 * @returns {{ source: string, close: Source[] }}
	 */
	#emit_batch(batch, block = true) {
		const prefix = block ? `;${this.#scope}[${stringify_string(this.#id)}].b((s,n)=>{` : '';
		const operations = [];
		/** @type {Set<CapturedNode>} */
		const references = new Set();
		/** @type {Source[]} */
		const close = [];
		for (const event of batch.events) {
			const source = event.source;
			const node = source.node;
			references.add(node);
			const target = source_reference(node, this.#references.get(node));
			const control = node.data.captured ? raw_source(`s.p[${node.data.pending}]`) : undefined;
			const reference = {
				target,
				control
			};
			let value_source;
			/** @type {{ source: JavaScriptSource, write: string, folded: string } | undefined} */
			let anchor;
			if (!event.invalid) {
				// Persistent: async outcomes must retain Map/Set element and opaque custom
				// child identities for future regions, exactly like the head region.
				const region = this.#emit_region(event.value, true, references);
				value_source = region_source(region);
				const rendered_region = render_fragment(value_source, (value) => {
					if (value?.type === 'reference') return render_reference(value.reference ?? this.#references.get(value.node));
					return render_fragment_hole(value);
				});
				if (!is_primitive(event.value)) {
					const index = this.#anchor++;
					this.#assign_references(event.value, { root: `s.a[${index}]`, segments: [] }, new Map());
					const name = `s.a[${index}]`;
					// Implicit anchoring: anchor indices are allocated monotonically and every
					// allocated index is written exactly once in allocation order, so once the
					// push helper pays for itself the client can derive the index positionally
					// (`s.a.push`) instead of receiving it as an explicit assignment. Explicit
					// writes before the switch keep `s.a` dense, so mixing both forms is safe.
					const use_helper = this.#runtimes_emitted.v || index > 5;
					const write = use_helper
						? `${this.#runtime_token('v')}(${rendered_region})`
						: `${name}=${rendered_region}`;
					// Defer the anchor write: when the operation uses the value exactly
					// once, the write is folded into that use site. A helper call is a
					// primary expression; only the assignment form needs parentheses.
					const outcome = { type: 'outcome', source: value_source, anchored: name, folded: use_helper ? write : `(${write})` };
					anchor = { source: outcome, write, folded: outcome.folded };
					value_source = create_source(['', ''], [outcome]);
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
				if (!is_source(operation)) throw new TypeError('Invalid async descriptor operation');
				if (anchor) {
					if (count_source(operation, anchor.source) === 1) anchor.source.render = anchor.folded;
					else {
						operations.push(raw_source(anchor.write));
						anchor.source.render = anchor.source.anchored;
					}
				}
				operations.push(operation);
			} catch (error) {
				if (event.type === 'resolve' || event.type === 'next' || event.type === 'complete') {
					this.#report(error, event.value);
					// The outcome's identities were assigned anchor references, so the anchor
					// must still ship even though the operation falls back to a generic error.
					if (anchor) operations.push(raw_source(anchor.write));
					const fallback = source.type === 'sequence'
						? source.descriptor.error(reference, generic_error)
						: source.descriptor.reject(reference, generic_error);
					if (!is_source(fallback)) throw new TypeError('Invalid async descriptor operation');
					operations.push(fallback);
					event.type = source.type === 'sequence' ? 'error' : 'reject';
				} else {
					throw error;
				}
			}
			if (event.type !== 'next' && node.data.captured && !source.descriptor.manages_pending) {
				operations.push(raw_source(`delete s.p[${node.data.pending}]`));
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
		let body = rendered.join(';');
		if (block) {
			// Standalone blocks are final output; resolve helper placeholders here so every
			// definition is evaluated in the same block as (and before) its first use.
			// Head-folded operations are resolved later by wrap_head instead.
			const resolved = this.#resolve_runtime_declarations(body);
			body = resolved.defs.length ? `${resolved.defs.join(';')};${resolved.source}` : resolved.source;
		}
		return { source: prefix + body + (block ? '})' : rendered.length ? ';' : ''), close };
	}

	/**
	 * Creates persistent client-slot aliases for repeated long paths when profitable in
	 * this batch, then retains those aliases as the nodes' shortest references.
	 *
	 * @param {Array<{ source: string, tokens: Map<string, { node?: CapturedNode, reference?: ClientPath, source?: string }> }>} operations
	 * @param {Set<CapturedNode>} references
	 */
	#render_operations(operations, references) {
		const uses = new Map();
		const imported_references = new Map();
		for (const operation of operations) {
			for (const value of source_holes(operation)) {
				if (value?.type !== 'reference') continue;
				uses.set(value.node, (uses.get(value.node) ?? 0) + 1);
				if (value.reference && !imported_references.has(value.node)) {
					imported_references.set(value.node, value.reference);
				}
			}
		}
		const candidates = [];
		for (const node of references) {
			const reference = this.#references.get(node);
			if (!reference || reference.root.startsWith('s.s[')) continue;
			const path = render_reference(imported_references.get(node) ?? reference);
			const count = uses.get(node) ?? 0;
			if (count < 2) continue;
			candidates.push({ node, path, uses: count });
		}
		candidates.sort((a, b) => b.path.length - a.path.length);
		const aliases = new Map();
		const prefix = [];
		for (const { node, path, uses } of candidates) {
			const slot = `s.s[${this.#slot}]`;
			if (`${slot}=${path};`.length + slot.length * uses >= path.length * uses) continue;
			this.#slot++;
			prefix.push(`${slot}=${path}`);
			aliases.set(node, slot);
			this.#references.set(node, { root: slot, segments: [] });
		}
		const render = (value) => {
			if (value?.type === 'reference') {
				return aliases.get(value.node) ?? render_reference(value.reference ?? this.#references.get(value.node));
			}
			if (value?.type === 'capture') {
				const source = render_fragment(value.source, render);
				return `s.p[${value.pending}]=${needs_parentheses(source) ? `(${source})` : source}`;
			}
			if (value?.type === 'outcome') return value.render ?? render_fragment(value.source, render);
			if (value?.type === 'generated') return value.source;
			return render_fragment_hole(value);
		};
		return prefix.concat(operations.map((operation) => render_fragment(operation, render)));
	}

	/**
	 * Returns a quoted numeric source token. A real string containing the same quote
	 * characters escapes them when serialized, so it cannot contain this exact source.
	 *
	 * @returns {string}
	 */
	#placeholder() {
		return `"${this.#token++}"`;
	}

	/**
	 * Creates the one-shot async iterator that renders finalized batches as executable
	 * blocks and drives sequence backpressure as each batch is dequeued.
	 *
	 * @returns {UnevalStreamTail}
	 */
	#tail() {
		const session = this;
		let pending = false;
		/** @type {Promise<IteratorResult<string, void>> | undefined} */
		let advancing;
		let done = false;
		return {
			[Symbol.asyncIterator]() {
				return this;
			},
			next() {
				if (pending) {
					return Promise.reject(new TypeError('devalue: concurrent tail.next() is not supported'));
				}
				return advancing = advance();
			},
			async return() {
				if (done) return { done: true, value: undefined };
				done = true;
				const cancelling = session.#cancel();
				if (advancing) {
					try {
						await advancing;
					} catch {}
				}
				await cancelling;
				if (session.#failure) throw session.#failure;
				return { done: true, value: undefined };
			}
		};

		/** @returns {Promise<IteratorResult<string, void>>} */
		async function advance() {
				if (done) {
					if (session.#failure) throw session.#failure;
					return { done: true, value: undefined };
				}
				pending = true;
				try {
					while (!session.#batch_ready && session.#active > 0 && !session.#failure && !session.#cancelled) {
						await new Promise(/** @param {(value?: void | PromiseLike<void>) => void} resolve */ (resolve) => session.#waiters.push(resolve));
					}
					if (session.#failure) throw session.#failure;
					if (session.#cancelled) {
						await session.#cancelling;
						done = true;
						if (session.#failure) throw session.#failure;
						return { done: true, value: undefined };
					}
					if (!session.#batch_ready) {
						done = true;
						return { done: true, value: undefined };
					}
					const batch = { events: session.#batch };
					session.#batch = [];
					session.#batch_ready = false;
					let block;
					try {
						block = session.#emit_batch(batch);
					} catch (error) {
						await session.#cancel(error);
						throw session.#failure ?? error;
					}
					let close_failure;
					for (const source of block.close) {
						try {
							await session.#close_sequence(source);
						} catch (error) {
							close_failure ??= error;
						}
					}
					session.#start_unstarted();
					session.#consume(batch);
					if (close_failure) session.#fail(close_failure);
					return { done: false, value: block.source };
				} finally {
					pending = false;
				}
		}
	}

	/** Wakes every tail read currently waiting for delivery or lifecycle state to change. */
	#notify() {
		const waiters = this.#waiters;
		this.#waiters = [];
		for (const resolve of waiters) resolve();
	}

	/**
	 * Idempotently starts server-side cleanup and returns the shared cleanup operation.
	 *
	 * @param {unknown} [reason]
	 * @returns {Promise<void>}
	 */
	async #cancel(reason) {
		if (this.#cancelling) return this.#cancelling;
		this.#cancelled = true;
		this.#notify();
		this.#cancelling = this.#cleanup(reason);
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
		if (source.pulled) await Promise.all([source.pulled, returned]);
		else await returned;
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
 * @param {(value: unknown) => string} expression
 * @returns {string}
 */
function scalar(node, expression) {
	switch (node.kind) {
		case 'Number':
		case 'String':
		case 'Boolean':
		case 'BigInt':
			return `Object(${stringify_primitive(node.data.value)})`;
		case 'Date':
			return `new Date(${node.data.time})`;
		case 'RegExp': {
			return node.data.flags
				? `new RegExp(${stringify_string(node.data.source)},${stringify_string(node.data.flags)})`
				: `new RegExp(${stringify_string(node.data.source)})`;
		}
		case 'URL':
		case 'URLSearchParams':
			return `new ${node.kind}(${stringify_string(node.data.source)})`;
		case 'ArrayBuffer':
			// Native TypedArray join; avoids materializing a JS number array first.
			return `new Uint8Array([${node.data.bytes.toString()}]).buffer`;
		case 'DataView': {
			return `new DataView(${expression(node.data.buffer)},${node.data.byteOffset},${node.data.byteLength})`;
		}
		case 'Temporal.Duration':
		case 'Temporal.Instant':
		case 'Temporal.PlainDate':
		case 'Temporal.PlainTime':
		case 'Temporal.PlainDateTime':
		case 'Temporal.PlainMonthDay':
		case 'Temporal.PlainYearMonth':
		case 'Temporal.ZonedDateTime':
			return `${node.kind}.from(${stringify_string(node.data.source)})`;
		default:
			if (is_view(node.kind)) {
				return `new ${node.kind}(${expression(node.data.buffer)},${node.data.byteOffset},${node.data.length})`;
			}
			throw new Error(`Unknown stream node ${node.kind}`);
	}
}

/**
 * Reports whether a walked node kind is an ArrayBuffer view.
 *
 * @param {string} kind
 * @returns {boolean}
 */
function is_view(kind) {
	return kind === 'DataView' || kind.endsWith('Array') && kind !== 'Array';
}

/**
 * Reports whether a node must be constructed after its represented children.
 *
 * @param {string} kind
 * @returns {boolean}
 */
function is_atomic(kind) {
	return kind === 'Custom' || is_view(kind);
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

/** @param {CapturedNode} node @param {ClientPath | undefined} reference @returns {JavaScriptSource} */
function source_reference(node, reference) {
	return /** @type {JavaScriptSource} */ ({ [SOURCE]: true, strings: ['', ''], values: [{ type: 'reference', node, reference }] });
}

/** @param {{ source: string, tokens: Map<string, { node: CapturedNode, reference: ClientPath }> }} region */
function region_source(region) {
	if (region.tokens.size === 0) return raw_source(region.source);
	const strings = [];
	const values = [];
	let index = 0;
	for (const match of region.source.matchAll(TOKEN_PATTERN)) {
		const token = match[0];
		const reference = region.tokens.get(token);
		if (!reference) continue;
		strings.push(region.source.slice(index, match.index));
		values.push({ type: 'reference', ...reference });
		index = match.index + token.length;
	}
	strings.push(region.source.slice(index));
	return create_source(strings, values);
}

/** Returns ordinary value holes reachable through nested source fragments. @param {JavaScriptSource} source */
function source_values(source) {
	const values = [];
	for (const value of source.values) {
		if (is_source(value)) values.push(...source_values(value));
		else if (!is_internal_hole(value)) values.push(value);
	}
	return values;
}

/** Returns every structural hole reachable through nested source fragments. @param {JavaScriptSource} source */
function source_holes(source) {
	const values = [];
	for (const value of source.values) {
		if (is_source(value)) values.push(...source_holes(value));
		else if (value?.type === 'outcome') values.push(...source_holes(value.source));
		else values.push(value);
	}
	return values;
}

/** @param {JavaScriptSource} source @param {unknown} target */
function count_source(source, target) {
	let count = 0;
	for (const value of source.values) {
		if (value === target) count++;
		else if (is_source(value)) count += count_source(value, target);
	}
	return count;
}

/** @param {JavaScriptSource} source @param {(value: any) => string} render */
function render_fragment(source, render) {
	let result = source.strings[0];
	for (let i = 0; i < source.values.length; i++) {
		const value = source.values[i];
		result += is_source(value) ? render_fragment(value, render) : render(value);
		result += source.strings[i + 1];
	}
	return result;
}

/** @param {any} value */
function render_fragment_hole(value) {
	if (value?.type === 'reference') return render_reference(value.reference);
	if (is_primitive(value)) return stringify_primitive(value);
	throw new TypeError('Invalid JavaScript source interpolation');
}

/** @param {unknown} value */
function is_internal_hole(value) {
	return typeof value === 'object' && value !== null && (value.type === 'reference' || value.type === 'capture' || value.type === 'generated' || value.type === 'outcome');
}

/** @param {JavaScriptSource} source @param {(value: unknown) => string} expression */
function render_source(source, expression) {
	return render_fragment(source, (value) => expression(value));
}

/** @param {JavaScriptSource} source */
function render_descriptor_source(source) {
	return render_fragment(source, (value) => {
		if (value?.type === 'capture') {
			const captured = render_descriptor_source(value.source);
			return `s.p[${value.pending}]=${needs_parentheses(captured) ? `(${captured})` : captured}`;
		}
		if (is_primitive(value)) return stringify_primitive(value);
		throw new TypeError('Invalid JavaScript source interpolation');
	});
}

/** Bare identifiers and bracketed identifier lists, e.g. `g` or `[a,b]`. */
const SAFE_CAPTURE_EXPRESSION = /^(?:[A-Za-z_$][\w$]*|\[[A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)*\])$/;

/**
 * Reports whether a captured expression must be parenthesized before being assigned.
 * Parentheses never change the meaning of a well-formed expression, so anything that is
 * not provably safe (the only under-wrapping hazard is a top-level comma, but classifying
 * arbitrary JavaScript requires a parser) is wrapped.
 *
 * @param {string} expression
 * @returns {boolean}
 */
function needs_parentheses(expression) {
	return !SAFE_CAPTURE_EXPRESSION.test(expression);
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

/**
 * Returns a structured client reference with one additional path segment.
 *
 * @param {ClientPath} reference
 * @param {string} segment
 * @returns {ClientPath}
 */
function append_reference(reference, segment) {
	return { root: reference.root, segments: [...reference.segments, segment] };
}

/**
 * Renders a structured client reference as executable source.
 *
 * @param {ClientPath} reference
 * @returns {string}
 */
function render_reference(reference) {
	return reference.root + reference.segments.join('');
}

/**
 * Computes the rendered length of a structured client reference without allocating it.
 *
 * @param {ClientPath} reference
 * @returns {number}
 */
function reference_length(reference) {
	let length = reference.root.length;
	for (const segment of reference.segments) length += segment.length;
	return length;
}

/**
 * The shared client queue runtime backing every reconstructed native AsyncIterable.
 * A session ships this text once; later sequences reference `s.f` directly.
 */
const SEQUENCE_RUNTIME = '(c)=>{let q=[],w=[],d=0,e,r=(d,v)=>({done:!!d,value:v}),a,f=()=>{while(w.length&&(q.length||d)){a=w.shift();q.length?a[0](r(0,q.shift())):d<2?a[0](r(1,e)):a[1](e)}},g=(o,v)=>d||(o?(d=o,e=v):q.push(v),f());c(g);return{[Symbol.asyncIterator](){return this},async next(){if(q.length)return r(0,q.shift());if(d>1)throw e;return d?r(1,e):new Promise((a,b)=>w.push([a,b]))},async return(v){d||(d=1,e=v,q.length=0,f());return r(1,v)},async throw(v){d||(d=2,e=v,q.length=0,f());throw v}}}';

/**
 * Session helper definitions, shipped at most once per session, always in the same block
 * as (and ahead of) their first use. `w` ships with the first assembled native Promise,
 * while `r` waits until three settlements are in play and `v` until six anchors
 * have been allocated, and `f` with the first sequence (whose reconstruction is
 * impossible without it).
 */
const RUNTIMES = {
	/** Shared buffered-iterator runtime for reconstructed native AsyncIterables. */
	f: SEQUENCE_RUNTIME,
	/** Creates a pending promise whose settlement functions are parked in `s.p`. */
	w: 'i=>new Promise((a,b)=>{s.p[i]=[a,b]})',
	/** Settles a parked pending promise (`j` selects resolve/reject) and frees its slot. */
	r: '(i,j,v)=>(s.p[i][j](v),delete s.p[i])',
	/** Anchors a value at the next positional index (mirrors the server's counter). */
	v: 'v=>(s.a.push(v),v)'
};

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
	/** @type {UnevalStreamTail} */
	const tail = {
		[Symbol.asyncIterator]() {
			return this;
		},
		async next() {
			return { done: true, value: undefined };
		},
		async return() {
			return { done: true, value: undefined };
		}
	};
	return tail;
}

/** @typedef {{ node: CapturedNode, descriptor: any, type: 'value' | 'sequence' | 'native', started: boolean, terminal: boolean, cleaned: boolean, active: boolean, flushed_pending: number, iterator?: any, iterator_closed?: boolean, next?: Function, pulling?: boolean, pulled?: Promise<void>, pulled_resolve?: () => void, observer?: { active: boolean }, early?: ['resolve' | 'reject', unknown] }} Source */
/** @typedef {{ source: Source, type: 'resolve' | 'reject' | 'next' | 'complete' | 'error', value: unknown, sequence: number, invalid: boolean }} Event */
/** @typedef {{ events: Event[] }} Batch */
/** @typedef {{ readonly [SOURCE]: true, readonly strings: readonly string[], readonly values: readonly unknown[] }} JavaScriptSource */
