import { stringify } from "./src/stringify.js"
import { parse} from "./src/parse.js"


const thing = new Uint8Array(3);
thing[0] = 1;
thing[1] = 2;
thing[2] = 3;

const otherThing = new Float32Array(10);
otherThing[0] = -Infinity;


const a = {
    foo: thing,
    bar: otherThing,
    buff: otherThing.buffer
}


const stringified = stringify(a);
const parsed = parse(stringified);
console.log(a, stringified, parsed);
