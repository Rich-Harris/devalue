/**
 * @import {
 *   ClientReference as ClientReferenceType,
 *   JavaScriptSource as JavaScriptSourceType,
 *   JavaScriptTag as JavaScriptTagType,
 *   UnevalReplacer as UnevalReplacerType,
 *   AsyncValueDescriptor as AsyncValueDescriptorType,
 *   AsyncSequenceDescriptor as AsyncSequenceDescriptorType,
 *   UnevalStreamReplacer as UnevalStreamReplacerType,
 *   UnevalStreamOptions as UnevalStreamOptionsType,
 *   UnevalStreamTail as UnevalStreamTailType,
 *   UnevalStreamResult as UnevalStreamResultType,
 *   StringValueTag as StringValueTagType,
 *   ViewTag as ViewTagType,
 *   StringifyOperations as StringifyOperationsType,
 *   DefaultStringifyOperations as DefaultStringifyOperationsType,
 *   StringifyOptions as StringifyOptionsType,
 *   ParseOperations as ParseOperationsType,
 *   DefaultParseOperations as DefaultParseOperationsType,
 *   ParseOptions as ParseOptionsType
 * } from './src/types.js'
 */

export { uneval } from './src/uneval.js';
export { unevalStream } from './src/uneval-stream.js';
export { parse, unflatten } from './src/parse.js';
export { stringify, stringifyAsync } from './src/stringify.js';
export {
	default_stringify_operations as defaultStringifyOperations,
	default_parse_operations as defaultParseOperations
} from './src/operations.js';
export { DevalueError, filter_array_indices as filterArrayIndices } from './src/utils.js';

/**
 * JavaScript source references for a reconstructed async value and its optional private control.
 * @typedef {ClientReferenceType} ClientReference
 */
/** @typedef {JavaScriptSourceType} JavaScriptSource */
/** @typedef {JavaScriptTagType} JavaScriptTag */
/** @typedef {UnevalReplacerType} UnevalReplacer */
/**
 * Describes how a server Promise-like value is constructed and settled on the client.
 * @template [T=unknown]
 * @typedef {AsyncValueDescriptorType<T>} AsyncValueDescriptor
 */
/**
 * Describes how server AsyncIterable events construct and update a client value.
 * @template [T=unknown], [TReturn=unknown]
 * @typedef {AsyncSequenceDescriptorType<T, TReturn>} AsyncSequenceDescriptor
 */
/**
 * Synchronously replaces values with tagged JavaScript source or asynchronous descriptors.
 * @typedef {UnevalStreamReplacerType} UnevalStreamReplacer
 */
/**
 * Configures streamed source namespacing, identity, and cancellation.
 * @typedef {UnevalStreamOptionsType} UnevalStreamOptions
 */
/**
 * A one-shot async iterator of executable JavaScript update statements.
 * @typedef {UnevalStreamTailType} UnevalStreamTail
 */
/**
 * The initial executable graph source, its update iterator, and its session ID.
 * @typedef {UnevalStreamResultType} UnevalStreamResult
 */
/** @typedef {StringValueTagType} StringValueTag */
/** @typedef {ViewTagType} ViewTag */
/** @typedef {StringifyOperationsType} StringifyOperations */
/** @typedef {DefaultStringifyOperationsType} DefaultStringifyOperations */
/** @typedef {StringifyOptionsType} StringifyOptions */
/** @typedef {ParseOperationsType} ParseOperations */
/** @typedef {DefaultParseOperationsType} DefaultParseOperations */
/** @typedef {ParseOptionsType} ParseOptions */
