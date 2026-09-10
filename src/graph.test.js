import { suite } from 'uvu';
import * as assert from 'uvu/assert';
import { child, create_captured_graph, discover, roll_back } from './graph.js';
import { DevalueError } from './utils.js';

const test = suite('shared graph');
const create_test_graph = (root) => create_captured_graph(root, () => false);

test('records one node per identity', () => {
	const shared = {};
	const root = { first: shared, second: shared };
	root.self = root;
	const graph = create_test_graph(root);
	discover(graph, root);

	assert.is(graph.nodes.length, 2);
	assert.is(graph.identities.get(root), graph.nodes[0]);
	assert.is(graph.identities.get(shared), graph.nodes[1]);
});

test('captures sparse arrays and container order as direct children', () => {
	const key = {};
	const array = Array(5);
	array[3] = key;
	array[4] = 'primitive';
	const map = new Map([[key, array]]);
	const set = new Set([array, key]);
	const root = { map, set };
	const graph = create_test_graph(root);
	discover(graph, root);

	const array_node = graph.identities.get(array);
	const key_node = graph.identities.get(key);
	assert.equal(array_node?.keys, ['3', '4']);
	assert.equal(array_node?.children, [key_node, 'primitive']);
	assert.is(array_node?.data, 5);
	assert.equal(graph.identities.get(map)?.children, [key_node, array_node]);
	assert.equal(graph.identities.get(set)?.children, [array_node, key_node]);
});

test('applies classifications while graph owns recursive discovery', () => {
	class Box {
		constructor(value) {
			this.value = value;
		}
	}
	const inner = {};
	const root = new Box(inner);
	const graph = create_captured_graph(root, (graph, node, value) => {
		if (!(value instanceof Box)) return false;
		node.kind = 'Box';
		node.children = [child(graph, value.value)];
		return true;
	});
	const node = discover(graph, root);

	assert.is(node?.kind, 'Box');
	assert.is(node?.children[0], graph.identities.get(inner));
	assert.is(graph.nodes.length, 2);
});

test('rolls back appended identities without touching earlier captures', () => {
	const shared = {};
	const graph = create_test_graph(shared);
	discover(graph, shared);
	const value = { shared, extra: {} };
	const mark = graph.nodes.length;
	discover(graph, value);
	assert.is(graph.nodes.length, 3);
	roll_back(graph, mark);
	assert.is(graph.nodes.length, 1);
	assert.is(graph.identities.size, 1);
	assert.is(graph.identities.has(value), false);
	assert.is(graph.identities.get(shared), graph.nodes[0]);
});

test('rolls back an entire failed recursive discovery', () => {
	const root = { child: {}, invalid: () => {} };
	const graph = create_test_graph(root);
	let error;
	try {
		discover(graph, root);
	} catch (e) {
		error = e;
	}
	roll_back(graph, 0, error);

	assert.is(graph.nodes.length, 0);
	assert.is(graph.unwind.length, 0);
	assert.is(graph.identities.size, 0);
	assert.is(error.path, '.invalid');
});

test('assembles error paths while unwinding', () => {
	class Whatever {}
	const root = {
		ok: [1, 2],
		foo: { 'string-key': new Map([['key', [null, new Whatever()]]]) }
	};
	const graph = create_test_graph(root);
	let error;
	try {
		discover(graph, root);
	} catch (e) {
		error = e;
	}
	roll_back(graph, 0, error);

	assert.is(error.name, 'DevalueError');
	assert.is(error.message, 'Cannot stringify arbitrary non-POJOs');
	assert.is(error.path, '.foo["string-key"].get("key")[1]');
	assert.is(error.root, root);
	assert.is(graph.nodes.length, 0);
});

test('reports __proto__ keys at the owning object', () => {
	const inner = JSON.parse('{"__proto__":1}');
	const root = { foo: inner };
	const graph = create_test_graph(root);
	let error;
	try {
		discover(graph, root);
	} catch (e) {
		error = e;
	}
	roll_back(graph, 0, error);

	assert.is(error.message, 'Cannot stringify objects with __proto__ keys');
	assert.is(error.path, '.foo');
	assert.is(error.value, inner);
});

test('does not mutate external errors or retain their unwind path', () => {
	const preserved = {};
	const graph = create_test_graph(preserved);
	discover(graph, preserved);
	const mark = graph.nodes.length;
	const external_value = {};
	const external_root = {};
	const external = new DevalueError('external failure', ['.external'], external_value, external_root);
	Object.freeze(external);
	const failed = {};
	Object.defineProperty(failed, 'prop', { enumerable: true, get() { throw external; } });
	let thrown;
	try {
		discover(graph, failed);
	} catch (error) {
		thrown = error;
	}
	roll_back(graph, mark, thrown);

	assert.is(thrown, external);
	assert.is(external.path, '.external');
	assert.is(external.value, external_value);
	assert.is(external.root, external_root);
	assert.is(graph.unwind.length, 0);
	assert.is(graph.nodes.length, mark);
	assert.is(graph.identities.get(preserved), graph.nodes[0]);
	assert.is(graph.identities.has(failed), false);

	const invalid = { deep: { bad: () => {} } };
	try {
		discover(graph, invalid);
	} catch (error) {
		thrown = error;
	}
	roll_back(graph, mark, thrown);
	assert.is(thrown.path, '.deep.bad');
	assert.is(graph.unwind.length, 0);
	assert.is(graph.nodes.length, mark);
});

test('clears unwind after a revoked value is thrown', () => {
	const graph = create_test_graph(null);
	const { proxy, revoke } = Proxy.revocable({}, {});
	revoke();
	const failed = {};
	Object.defineProperty(failed, 'prop', { enumerable: true, get() { throw proxy; } });
	let thrown;
	try {
		discover(graph, failed);
	} catch (error) {
		thrown = error;
	}
	roll_back(graph, 0, thrown);
	assert.is(thrown, proxy);
	assert.is(graph.unwind.length, 0);
	assert.is(graph.nodes.length, 0);
});

test('does not claim an error owned by a different graph', () => {
	const first = create_test_graph(null);
	let foreign;
	try {
		discover(first, { original: () => {} });
	} catch (error) {
		foreign = error;
	}
	roll_back(first, 0, foreign);
	assert.is(foreign.path, '.original');

	const second = create_test_graph(null);
	const failed = {};
	Object.defineProperty(failed, 'foreign', { enumerable: true, get() { throw foreign; } });
	let thrown;
	try {
		discover(second, failed);
	} catch (error) {
		thrown = error;
	}
	roll_back(second, 0, thrown);
	assert.is(thrown, foreign);
	assert.is(foreign.path, '.original');
	assert.is(second.unwind.length, 0);
});

test.run();
