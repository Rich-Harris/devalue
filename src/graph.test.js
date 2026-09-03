import { suite } from 'uvu';
import * as assert from 'uvu/assert';
import { child, create_captured_graph, discover, rollback } from './graph.js';

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
	const graph = create_captured_graph(root, (value, node, graph) => {
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
	rollback(graph, mark);
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
	rollback(graph, 0, error);

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
	rollback(graph, 0, error);

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
	rollback(graph, 0, error);

	assert.is(error.message, 'Cannot stringify objects with __proto__ keys');
	assert.is(error.path, '.foo');
	assert.is(error.value, inner);
});

test.run();
