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
