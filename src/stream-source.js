import { SOURCE, create_source, is_source, raw_source } from './javascript-source.js';
import { is_primitive, stringify_primitive, stringify_string } from './utils.js';

/** Internal stream instructions are branded with a non-enumerable module-private key. */
const INSTRUCTION = Symbol('StreamInstruction');

/**
 * @template {UnbrandedStreamInstruction} T
 * @param {T} instruction
 * @returns {T & InstructionBrand}
 */
function brand(instruction) {
	Object.defineProperty(instruction, INSTRUCTION, { value: true });
	return /** @type {T & InstructionBrand} */ (instruction);
}

/**
 * @param {unknown} value
 * @returns {value is StreamInstruction}
 */
export function is_stream_instruction(value) {
	return !!/** @type {Partial<InstructionBrand> | null | undefined} */ (value)?.[INSTRUCTION];
}

/**
 * @param {StreamInstruction} instruction
 * @returns {JavaScriptSource}
 */
function instruction_source(instruction) {
	return create_source(['', ''], [instruction]);
}

/**
 * @param {CapturedNode} node
 * @param {ClientPath | undefined} path
 * @returns {JavaScriptSource}
 */
export function reference_source(node, path) {
	return instruction_source(brand({ type: 'reference', node, path }));
}

/**
 * @param {number} pending
 * @param {Emission} source
 * @returns {JavaScriptSource}
 */
export function capture_source(pending, source) {
	return instruction_source(brand({ type: 'capture', pending, source }));
}

/**
 * @param {Emission} source
 * @returns {Emission}
 */
export function expression_source(source) {
	return typeof source === 'string' ? `(${source})` : instruction_source(brand({ type: 'expression', source }));
}

/**
 * @param {keyof typeof RUNTIMES} key
 * @returns {JavaScriptSource}
 */
export function runtime_source(key) {
	return instruction_source(brand({ type: 'runtime', key }));
}

/**
 * @param {number} pending
 * @returns {JavaScriptSource}
 */
export function promise_source(pending) {
	return instruction_source(brand({ type: 'promise', pending }));
}

/** Marks the position where definitions for this final source are emitted. @returns {JavaScriptSource} */
export function definitions_source() {
	return instruction_source(brand({ type: 'definitions' }));
}

/**
 * @param {Emission} source
 * @param {Emission} anchored
 * @param {Emission} folded
 */
export function outcome_source(source, anchored, folded) {
	return instruction_source(brand({ type: 'outcome', source, anchored, folded, mode: 'source' }));
}

/**
 * @param {JavaScriptSource} source
 * @param {'anchored' | 'folded'} mode
 */
export function select_outcome_source(source, mode) {
	const instruction = source[SOURCE].values[0];
	if (!is_stream_instruction(instruction) || instruction.type !== 'outcome') {
		throw new TypeError('Invalid outcome source: select_outcome_source() expects the fragment returned by outcome_source(), not an arbitrary JavaScriptSource');
	}
	instruction.mode = mode;
}

/**
 * Strings here are already-generated source, never user data holes. Allocate a fragment
 * only if an unresolved structured child survives composition.
 * @param {readonly Emission[]} sources
 * @param {string} [separator]
 * @returns {Emission}
 */
export function join_sources(sources, separator = '') {
	let text = '';
	/** @type {string[] | undefined} */
	let strings;
	/** @type {JavaScriptSource[] | undefined} */
	let values;
	for (let i = 0; i < sources.length; i++) {
		if (i) text += separator;
		const source = sources[i];
		if (typeof source === 'string') text += source;
		else {
			(strings ??= []).push(text);
			(values ??= []).push(source);
			text = '';
		}
	}
	if (!strings) return text;
	strings.push(text);
	return create_source(strings, /** @type {JavaScriptSource[]} */ (values));
}

/**
 * Compiles a user template's holes, preserving nested partial syntax and unresolved
 * instructions. Fully textual subtrees collapse without creating a source wrapper.
 * @param {JavaScriptSource} source
 * @param {(value: unknown) => Emission} map
 * @returns {Emission}
 */
export function map_source(source, map) {
	const { strings, values } = source[SOURCE];
	let text = strings[0];
	/** @type {string[] | undefined} */
	let output_strings;
	/** @type {JavaScriptSource[] | undefined} */
	let output_values;
	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		const mapped = is_source(value) ? map_source(value, map)
			: is_stream_instruction(value) ? instruction_source(value) : map(value);
		if (typeof mapped === 'string') text += mapped;
		else {
			(output_strings ??= []).push(text);
			(output_values ??= []).push(mapped);
			text = '';
		}
		text += strings[i + 1];
	}
	if (!output_strings) return text;
	output_strings.push(text);
	return create_source(output_strings, /** @type {JavaScriptSource[]} */ (output_values));
}

/**
 * Compiles ordinary holes in a descriptor result. Unlike a synchronous custom
 * replacement, a descriptor may place data inside the expression passed to its
 * private capture instruction, so that selected instruction child is mapped too.
 * Other branded instructions remain indivisible internal semantics.
 * @param {JavaScriptSource} source
 * @param {(value: unknown, index: number) => Emission} map
 * @returns {Emission}
 */
export function map_descriptor_source(source, map) {
	const { strings, values } = source[SOURCE];
	let text = strings[0];
	/** @type {string[] | undefined} */
	let output_strings;
	/** @type {JavaScriptSource[] | undefined} */
	let output_values;
	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		const mapped = is_source(value) ? map_descriptor_source(value, map)
			: is_stream_instruction(value) ? map_descriptor_instruction(value, map) : map(value, i);
		if (typeof mapped === 'string') text += mapped;
		else {
			(output_strings ??= []).push(text);
			(output_values ??= []).push(mapped);
			text = '';
		}
		text += strings[i + 1];
	}
	if (!output_strings) return text;
	output_strings.push(text);
	return create_source(output_strings, /** @type {JavaScriptSource[]} */ (output_values));
}

/**
 * @param {StreamInstruction} instruction
 * @param {(value: unknown, index: number) => Emission} map
 * @returns {JavaScriptSource}
 */
function map_descriptor_instruction(instruction, map) {
	if (instruction.type !== 'capture') return instruction_source(instruction);
	const source = typeof instruction.source === 'string'
		? instruction.source
		: map_descriptor_source(instruction.source, map);
	return instruction_source(brand({ ...instruction, source }));
}

/** Wrap generated text only at a descriptor's public JavaScriptSource boundary. @param {Emission} source */
export function template_source(source) {
	return typeof source === 'string' ? raw_source(source) : source;
}

/**
 * Returns ordinary data holes reachable through nested trusted fragments. Instructions are
 * deliberately skipped only after their private symbol brand has been checked.
 * @param {JavaScriptSource} source
 * @returns {unknown[]}
 */
export function source_values(source) {
	/** @type {unknown[]} */
	const values = [];
	for (const value of source[SOURCE].values) {
		if (is_source(value)) values.push(...source_values(value));
		else if (!is_stream_instruction(value)) values.push(value);
	}
	return values;
}

/**
 * Returns ordinary descriptor data holes, including those in reachable private
 * capture expressions. Hole indices are local to the fragment that owns them.
 * @param {JavaScriptSource} source
 * @returns {{ value: unknown, index: number, capture: boolean }[]}
 */
export function descriptor_source_values(source) {
	/** @type {{ value: unknown, index: number, capture: boolean }[]} */
	const values = [];
	/** @param {JavaScriptSource} fragment @param {boolean} capture */
	const walk = (fragment, capture) => {
		const source_values = fragment[SOURCE].values;
		for (let i = 0; i < source_values.length; i++) {
			const value = source_values[i];
			if (is_source(value)) walk(value, capture);
			else if (is_stream_instruction(value)) {
				if (value.type === 'capture' && typeof value.source !== 'string') walk(value.source, true);
			} else values.push({ value, index: i, capture });
		}
	};
	walk(source, false);
	return values;
}

/**
 * @param {Emission} source
 * @returns {StreamInstruction[]}
 */
export function source_instructions(source) {
	/** @type {StreamInstruction[]} */
	const found = [];
	visit(source, (instruction) => found.push(instruction));
	return found;
}

/**
 * @param {JavaScriptSource} source
 * @param {JavaScriptSource} target
 */
export function count_source(source, target) {
	let count = 0;
	visit_sources(source, (fragment) => {
		if (fragment === target) count++;
	});
	return count;
}

/**
 * Collects reachable helper dependencies without rendering or mutating session state.
 * @param {Emission} source
 * @returns {(keyof typeof RUNTIMES)[]}
 */
export function source_helpers(source) {
	/** @type {(keyof typeof RUNTIMES)[]} */
	const helpers = [];
	const seen = new Set();
	visit(source, (instruction) => {
		const key = instruction.type === 'runtime' ? instruction.key : instruction.type === 'promise' ? 'w' : undefined;
		if (key && !seen.has(key)) {
			seen.add(key);
			helpers.push(key);
		}
	});
	return helpers;
}

/**
 * Renders one complete structured source. `definitions` are inserted only at an explicit
 * definitions instruction, allowing helper discovery to happen before the single text render.
 * @param {Emission} source
 * @param {(keyof typeof RUNTIMES)[]} [definitions]
 */
export function render_stream_source(source, definitions = []) {
	if (typeof source === 'string') return source;
	const definition_source = definitions.map((key) => `s.${key}=${RUNTIMES[key]}`).join(';');
	/** @param {Emission} fragment */
	const render = (fragment) => {
		if (typeof fragment === 'string') return fragment;
		const { strings, values } = fragment[SOURCE];
		let result = strings[0];
		for (let i = 0; i < values.length; i++) {
			const value = values[i];
			result += is_source(value) ? render(value) : is_stream_instruction(value) ? render_instruction(value) : render_hole(value);
			result += strings[i + 1];
		}
		return result;
	};
	/** @param {StreamInstruction} instruction */
	const render_instruction = (instruction) => {
		switch (instruction.type) {
			case 'reference':
				if (!instruction.path) throw new TypeError('Unresolved stream reference: a client identity has no assigned anchor, slot, or collection path before rendering (internal emitter error)');
				return render_reference(instruction.path);
			case 'capture':
				return `(s.p[${instruction.pending}]=(${render(instruction.source)}))`;
			case 'expression':
				return `(${render(instruction.source)})`;
			case 'runtime':
				return `s.${instruction.key}`;
			case 'promise':
				return `s.w(${instruction.pending})`;
			case 'definitions':
				return definition_source;
			case 'outcome':
				return render(instruction.mode === 'folded' ? instruction.folded : instruction.mode === 'anchored' ? instruction.anchored : instruction.source);
		}
	};
	return render(source);
}

/** @param {unknown} value */
function render_hole(value) {
	if (!is_primitive(value) || typeof value === 'symbol') throw interpolation_error(value, 'source rendering');
	return stringify_primitive(value);
}

/**
 * Describe rejected values without reading their properties, inspecting prototypes, or
 * invoking user conversion hooks. Called only on error paths, never during emission.
 * @param {unknown} value
 */
export function describe_received(value) {
	if (value === null) return 'null';
	switch (typeof value) {
		case 'undefined': return 'undefined';
		case 'boolean': return String(value);
		case 'number': return `a number (${Object.is(value, -0) ? '-0' : value})`;
		case 'bigint': return 'a bigint';
		case 'string': return 'a string';
		case 'symbol': return 'a Symbol';
		case 'function': return 'a function';
		default: return 'an object';
	}
}

/**
 * @param {unknown} value
 * @param {string} context
 */
function interpolation_error(value, context) {
	const reason = typeof value === 'symbol'
		? 'Symbol values cannot be serialized as data. If you intended trusted JavaScript, write it in a nested js tagged template instead.'
		: 'This ordinary value reached source rendering without first being serialized through the captured graph (internal emitter error).';
	return new TypeError(`Invalid JavaScript source interpolation in ${context}: received ${describe_received(value)}. ${reason}`);
}

/**
 * @param {Emission} source
 * @param {(instruction: StreamInstruction) => void} callback
 */
function visit(source, callback) {
	if (typeof source === 'string') return;
	for (const value of source[SOURCE].values) {
		if (is_source(value)) visit(value, callback);
		else if (is_stream_instruction(value)) {
			callback(value);
			if (value.type === 'capture' || value.type === 'expression') visit(value.source, callback);
			else if (value.type === 'outcome') {
				const selected = value.mode === 'folded' ? value.folded : value.mode === 'anchored' ? value.anchored : value.source;
				visit(selected, callback);
			}
		}
	}
}

/**
 * @param {Emission} source
 * @param {(source: JavaScriptSource) => void} callback
 */
function visit_sources(source, callback) {
	if (typeof source === 'string') return;
	callback(source);
	for (const value of source[SOURCE].values) {
		if (is_source(value)) visit_sources(value, callback);
		else if (is_stream_instruction(value)) {
			if (value.type === 'capture' || value.type === 'expression') visit_sources(value.source, callback);
			else if (value.type === 'outcome') {
				const selected = value.mode === 'folded' ? value.folded : value.mode === 'anchored' ? value.anchored : value.source;
				visit_sources(selected, callback);
			}
		}
	}
}

/** @param {ClientPath} reference */
export function render_reference(reference) {
	const index = reference.kind === 'key' ? stringify_string(String(reference.index)) : reference.index;
	return `s.${reference.kind[0]}[${index}]` + reference.segments.join('');
}

/** @param {ClientPath} reference */
export function reference_length(reference) {
	const index = reference.kind === 'key' ? stringify_string(String(reference.index)) : reference.index;
	let length = 5 + String(index).length;
	for (const segment of reference.segments) length += segment.length;
	return length;
}

/**
 * @param {ClientPath} reference
 * @param {string} segment
 * @returns {ClientPath}
 */
export function append_reference(reference, segment) {
	return { kind: reference.kind, index: reference.index, segments: [...reference.segments, segment] };
}

/**
 * Session helper definitions. They remain data until the final reachable source is rendered.
 *
 * The sequence runtime keeps four concerns separate: `q`/`i` are buffered yields,
 * `w`/`j` are pending client reads, `t`/`e`/`x` are the server terminal outcome and
 * whether it was consumed, and `l` is local client closure. Queue indices avoid
 * repeatedly shifting potentially large buffers. Keep this as the authoritative
 * implementation evaluated by runtime tests and emitted to clients.
 */
export const RUNTIMES = {
	f: `(c)=>{
	let q=[],i=0; // buffered yields and next unread index
	let w=[],j=0; // pending reads and next unsettled index
	let t=0,e,x=0; // server terminal type, value/reason, and consumed flag
	let l=0; // local client closure
	let r=(d,v)=>({done:!!d,value:v});
	let f=()=>{
		while(j<w.length&&(i<q.length||t||l)){
			let a=w[j++];
			if(l)a[0](r(1));
			else if(i<q.length)a[0](r(0,q[i++]));
			else if(!x){
				x=1;
				t<2?a[0](r(1,e)):a[1](e);
			}else a[0](r(1));
		}
		if(i===q.length)q=[],i=0;
		if(j===w.length)w=[],j=0;
	};
	let g=(o,v)=>{
		if(l||t)return;
		o?(t=o,e=v):q.push(v);
		f();
	};
	let k=(v,n)=>{
		if(l)return;
		l=1;
		q=[];i=0;t=0;e=void 0;x=1;
		for(;j<w.length;j++)n?w[j][1](v):w[j][0](r(1));
		w=[];j=0;
	};
	c(g);
	return{
		[Symbol.asyncIterator](){return this},
		async next(){
			if(l)return r(1);
			if(i<q.length){
				let v=q[i++];
				if(i===q.length)q=[],i=0;
				return r(0,v);
			}
			if(t&&!x){
				x=1;
				if(t>1)throw e;
				return r(1,e);
			}
			if(t)return r(1);
			return new Promise((a,b)=>w.push([a,b]));
		},
		async return(v){k(v,0);return r(1,v)},
		async throw(v){k(v,1);throw v}
	};
}`,
	w: 'i=>{let p=new Promise((a,b)=>{s.p[i]=[a,b]});p.catch(()=>{});return p}',
	r: '(i,j,v)=>(s.p[i][j](v),delete s.p[i])',
	v: 'v=>(s.a.push(v),v)'
};

/** @typedef {import('./javascript-source.js').JavaScriptSource} JavaScriptSource */
/** Generated text or a fragment carrying unresolved semantics. Not a user interpolation type. @typedef {string | JavaScriptSource} Emission */
/** @typedef {import('./graph.js').CapturedNode} CapturedNode */
/** @typedef {import('./graph.js').ClientPath} ClientPath */
/** @typedef {{ type: 'reference', node: CapturedNode, path: ClientPath | undefined }} ReferenceInstruction */
/** @typedef {{ type: 'capture', pending: number, source: Emission }} CaptureInstruction */
/** @typedef {{ type: 'expression', source: Emission }} ExpressionInstruction */
/** @typedef {{ type: 'runtime', key: keyof typeof RUNTIMES }} RuntimeInstruction */
/** @typedef {{ type: 'promise', pending: number }} PromiseInstruction */
/** @typedef {{ type: 'definitions' }} DefinitionsInstruction */
/** @typedef {{ type: 'outcome', source: Emission, anchored: Emission, folded: Emission, mode: 'source' | 'anchored' | 'folded' }} OutcomeInstruction */
/** @typedef {ReferenceInstruction | CaptureInstruction | ExpressionInstruction | RuntimeInstruction | PromiseInstruction | DefinitionsInstruction | OutcomeInstruction} UnbrandedStreamInstruction */
/** @typedef {{ readonly [INSTRUCTION]: true }} InstructionBrand */
/** @typedef {UnbrandedStreamInstruction & InstructionBrand} StreamInstruction */
