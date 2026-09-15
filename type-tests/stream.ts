import {
	unevalStream,
	type AsyncSequenceDescriptor,
	type AsyncValueDescriptor,
	type ClientReference,
	type JavaScriptSource,
	type JavaScriptTag,
	type UnevalStreamOptions,
	type UnevalStreamReplacer,
	type UnevalStreamResult,
	type UnevalStreamTail
} from 'devalue';

const promise = Promise.resolve(1);
const sequence = (async function* (): AsyncGenerator<number, string, unknown> {
	yield 1;
	return 'complete';
})();
const config = { retries: 2 };

function useSource(_source: JavaScriptSource) {}
function useReference(reference: ClientReference) {
	useSource(reference.target);
	if (reference.control) useSource(reference.control);
}

function valueDescriptor(js: JavaScriptTag): AsyncValueDescriptor<number> {
	return {
		type: 'async-value',
		source: promise,
		construct: (capture) => js`new RemoteValue(${config},${capture(js`[${config}]`)})`,
		resolve: (reference, result) => {
			useReference(reference);
			return js`${reference.target}.resolve(${result},${config})`;
		},
		reject: ({ target }, reason) => js`${target}.reject(${reason},${config})`
	};
}

function sequenceDescriptor(js: JavaScriptTag): AsyncSequenceDescriptor<number, string> {
	return {
		type: 'async-sequence',
		source: sequence,
		construct: (capture) => js`new RemoteSequence(${config},${capture(js`(type,value)=>dispatch(type,value,${config})`)})`,
		next: ({ control }, item) => js`${control}(0,${item},${config})`,
		complete: ({ control }, result) => js`${control}(1,${result},${config})`,
		error: ({ control }, reason) => js`${control}(2,${reason},${config})`
	};
}

const replacer: UnevalStreamReplacer = (candidate, js) => {
	if (candidate === promise) return valueDescriptor(js);
	if (candidate === sequence) return sequenceDescriptor(js);
	return js`new Remote(${config})`;
};
const falseFallback: UnevalStreamReplacer = () => false;
const nullFallback: UnevalStreamReplacer = () => null;

// @ts-expect-error raw strings are not synchronous replacement source
const rawReplacement: UnevalStreamReplacer = () => 'new Remote()';

function invalidValueDescriptor(js: JavaScriptTag): AsyncValueDescriptor<number> {
	return {
		type: 'async-value',
		source: promise,
		// @ts-expect-error construct must return branded JavaScriptSource
		construct: () => 'new RemoteValue()',
		// @ts-expect-error operations must return branded JavaScriptSource
		resolve: () => 'resolve()',
		reject: () => js`reject()`
	};
}

function invalidCaptureDescriptor(js: JavaScriptTag): AsyncValueDescriptor<number> {
	return {
		type: 'async-value',
		source: promise,
		construct: (capture) => {
			// @ts-expect-error capture requires branded JavaScriptSource
			capture('[resolve,reject]');
			return js`new RemoteValue()`;
		},
		resolve: () => js`resolve()`,
		reject: () => js`reject()`
	};
}

function incompatibleSequenceDescriptors(js: JavaScriptTag) {
	const wrongItemSource: AsyncSequenceDescriptor<string, string> = {
		type: 'async-sequence',
		// @ts-expect-error the sequence yields numbers, not strings
		source: sequence,
		construct: () => js`new RemoteSequence()`,
		next: () => js``,
		complete: () => js``,
		error: () => js``
	};

	const wrongReturnSource: AsyncSequenceDescriptor<number, number> = {
		type: 'async-sequence',
		// @ts-expect-error the sequence returns a string, not a number
		source: sequence,
		construct: () => js`new RemoteSequence()`,
		next: () => js``,
		complete: () => js``,
		error: () => js``
	};
	return [wrongItemSource, wrongReturnSource];
}

const options: UnevalStreamOptions = { id: 'typed' };
const result: UnevalStreamResult = await unevalStream(sequence, replacer, options);
const { head, tail, id }: { head: string; tail: UnevalStreamTail; id: string } = result;
await tail.return();
void falseFallback;
void nullFallback;
void rawReplacement;
void invalidValueDescriptor;
void invalidCaptureDescriptor;
void incompatibleSequenceDescriptors;
void head;
void id;

// @ts-expect-error internal protocol type
import type { Session } from 'devalue';
// @ts-expect-error internal protocol type
import type { Region } from 'devalue';
// @ts-expect-error internal protocol type
import type { PathReference } from 'devalue';

void (null as unknown as Session);
void (null as unknown as Region);
void (null as unknown as PathReference);
