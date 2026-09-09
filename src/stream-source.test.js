import { suite } from 'uvu';
import * as assert from 'uvu/assert';
import vm from 'node:vm';
import { SOURCE, js, raw_source } from './javascript-source.js';
import { stringify_primitive } from './utils.js';
import {
	capture_source,
	count_source,
	definitions_source,
	describe_received,
	expression_source,
	is_stream_instruction,
	join_sources,
	map_source,
	outcome_source,
	promise_source,
	reference_source,
	render_stream_source,
	runtime_source,
	select_outcome_source,
	source_helpers,
	source_instructions,
	source_values,
	template_source
} from './stream-source.js';

const test = suite('structured stream source');

test('brands instructions with a private non-enumerable symbol rather than shape', () => {
	const node = /** @type {any} */ ({});
	const source = reference_source(node, { kind: 'anchor', index: 0, segments: [] });
	const instruction = source[SOURCE].values[0];
	assert.ok(is_stream_instruction(instruction));
	assert.equal(Object.keys(instruction), ['type', 'node', 'path']);
	const [brand] = Object.getOwnPropertySymbols(instruction);
	assert.is(instruction[brand], true);
	for (const value of [
		{ type: 'reference', node },
		{ type: 'capture', pending: 0, source: raw_source('x') },
		{ type: 'outcome', source: raw_source('x') },
		Object.create({ type: 'reference' })
	]) {
		assert.is(is_stream_instruction(value), false);
	}
});

test('keeps nested fragment composition verbatim and groups only expression boundaries', () => {
	const partial = js`Math.max(`;
	const nested = js`${partial}${js`1,2`})`;
	assert.is(render_stream_source(nested), 'Math.max(1,2)');
	assert.is(render_stream_source(expression_source(js`1,2`)), '(1,2)');
	assert.is(render_stream_source(js`[${expression_source(js`1,2`)}]`), '[(1,2)]');
});

test('composes ordered statements without flattening children', () => {
	const source = join_sources(['(()=>{', join_sources([
		js`const a=1`,
		join_sources(['return ', expression_source(js`a,2`)])
	], ';'), '})()']);
	assert.is(render_stream_source(source), '(()=>{const a=1;return (a,2)})()');
	assert.is(render_stream_source(join_sources([js`a`, js`b`, js`c`], ',')), 'a,b,c');
});

test('collects helpers only through the selected reachable outcome', () => {
	const outcome = outcome_source(
		runtime_source('f'),
		raw_source('s.a[1]'),
		runtime_source('v')
	);
	assert.equal(source_helpers(outcome), ['f']);
	select_outcome_source(outcome, 'anchored');
	assert.equal(source_helpers(outcome), []);
	select_outcome_source(outcome, 'folded');
	assert.equal(source_helpers(outcome), ['v']);
});

test('renders helper definitions before structured uses', () => {
	const source = join_sources([
		definitions_source(),
		';',
		promise_source(12),
		';',
		runtime_source('r'),
		'(12,0,"0")'
	]);
	const rendered = render_stream_source(source, source_helpers(source));
	assert.ok(rendered.indexOf('s.w=') < rendered.indexOf('s.w(12)'));
	assert.ok(rendered.indexOf('s.r=') < rendered.indexOf('s.r(12'));
});

test('groups capture assignments', () => {
	const capture = capture_source(0, js`1,2`);
	assert.is(render_stream_source(js`f(${capture})`), 'f((s.p[0]=(1,2)))');
});

test('describes rejected holes without invoking user conversion or inspection hooks', () => {
	const value = {
		get constructor() { assert.unreachable('read constructor'); },
		get [Symbol.toStringTag]() { assert.unreachable('read toStringTag'); },
		[Symbol.toPrimitive]() { assert.unreachable('converted value'); },
		toString() { assert.unreachable('called toString'); }
	};
	assert.throws(() => render_stream_source(js`${value}`),
		/source rendering: received an object.*internal emitter error/);
	assert.throws(() => render_stream_source(js`${Symbol('data')}`),
		/received a Symbol.*Symbol values cannot be serialized as data/);
	assert.is(describe_received(value), 'an object');
	const proxy = Proxy.revocable({}, {});
	proxy.revoke();
	assert.is(describe_received(proxy.proxy), 'an object');
});

test('describes rejected primitive categories without printing user payloads', () => {
	for (const [value, description] of [
		[undefined, 'undefined'], [null, 'null'], [false, 'false'], [true, 'true'],
		[0, 'a number (0)'], [-0, 'a number (-0)'], [NaN, 'a number (NaN)'],
		[1n, 'a bigint'], ['private text', 'a string'], [Symbol('private'), 'a Symbol']
	]) assert.is(describe_received(value), description);
});

test('explains internal outcome and unresolved-reference failures', () => {
	assert.throws(() => select_outcome_source(js`0`, 'folded'), /expects the fragment returned by outcome_source\(\)/);
	assert.throws(() => render_stream_source(reference_source(/** @type {any} */ ({}), undefined)),
		/no assigned anchor, slot, or collection path before rendering.*internal emitter error/);
});

test('ordinary instruction-shaped objects remain data holes', () => {
	const inherited = Object.create({ type: 'outcome' });
	const values = [{ type: 'reference' }, { type: 'capture' }, { type: 'outcome' }, inherited];
	assert.equal(source_values(js`${values[0]}${js`${values[1]}`}${values[2]}${inherited}`), values);
});

test('keeps resolved emission as strings, including expressions and statements', () => {
	assert.is(join_sources([]), '');
	assert.is(join_sources([], ','), '');
	assert.is(join_sources(['', '', ''], ','), ',,');
	const object = join_sources(['{value:', join_sources(['1', '2'], '+'), '}']);
	assert.is(object, '{value:1+2}');
	assert.is(expression_source(object), '({value:1+2})');
	const statements = join_sources(['let a=1', join_sources(['a=', expression_source('a,2')])], ';');
	assert.is(statements, 'let a=1;a=(a,2)');
	assert.equal(source_helpers(statements), []);
	assert.equal(source_instructions(statements), []);
	assert.is(render_stream_source(object), object);
});

test('retains only structured children when joining text and instructions', () => {
	const pending = promise_source(12);
	const source = join_sources(['{text:', '"0"', ',pending:', pending, ',other:', '"001"', '}']);
	assert.equal(source[SOURCE].strings, ['{text:"0",pending:', ',other:"001"}']);
	assert.equal(source[SOURCE].values, [pending]);
	assert.equal(source_helpers(source), ['w']);
	assert.is(render_stream_source(source), '{text:"0",pending:s.w(12),other:"001"}');
	assert.is(render_stream_source(join_sources([pending, '"0"', pending], ',')), 's.w(12),"0",s.w(12)');
});

test('compiles nested partial templates without confusing data strings with source', () => {
	const text = '</script>"0"';
	const source = js`${js`Math.max(`}${1},${2})`;
	assert.is(map_source(source, stringify_primitive), 'Math.max(1,2)');
	const compiled = expression_source(map_source(js`{value:${text}}`, stringify_primitive));
	assert.is(typeof compiled, 'string');
	assert.not.match(compiled, /<\/script>/);
	assert.is(vm.runInNewContext(compiled).value, text);
	// Only a public descriptor boundary wraps generated text; js string holes remain data.
	assert.is(render_stream_source(js`${template_source(compiled)}.value`), `${compiled}.value`);
	assert.is(render_stream_source(js`${'1,2'}`), '"1,2"');
});

test('keeps references and helper requests structured when compiling custom templates', () => {
	const node = /** @type {any} */ ({});
	const reference = reference_source(node, { kind: 'slot', index: 0, segments: [] });
	const pending = promise_source(1);
	const source = map_source(js`[${'0'},${reference},${pending}]`, stringify_primitive);
	const instructions = source_instructions(source);
	assert.equal(instructions.map((instruction) => instruction.type), ['reference', 'promise']);
	assert.is(instructions[0], source_instructions(reference)[0]);
	assert.equal(source_helpers(source), ['w']);
	assert.is(render_stream_source(source), '["0",s.s[0],s.w(1)]');
});

test('retains outcome selection and counting with textual and structured children', () => {
	const outcome = outcome_source('"0"', 's.a[1]', join_sources([runtime_source('v'), '("0")']));
	const operation = js`f(${outcome},${js`${outcome}`})`;
	assert.is(count_source(operation, outcome), 2);
	assert.is(count_source(outcome, outcome), 1);
	assert.equal(source_helpers(operation), []);
	select_outcome_source(outcome, 'folded');
	assert.equal(source_helpers(operation), ['v']);
	assert.is(render_stream_source(operation), 'f(s.v("0"),s.v("0"))');
	select_outcome_source(outcome, 'anchored');
	assert.equal(source_helpers(operation), []);
	assert.is(render_stream_source(operation), 'f(s.a[1],s.a[1])');
});

test('traverses structured dependencies inside capture assignments with textual siblings', () => {
	const capture = capture_source(0, join_sources(['"0",', promise_source(12)]));
	const source = join_sources(['f(', capture, ')']);
	assert.equal(source_helpers(source), ['w']);
	assert.is(render_stream_source(source), 'f((s.p[0]=("0",s.w(12))))');
});

test.run();
