# devalue

Like `JSON.stringify`, but handles

* cyclical references (`obj.self = obj`)
* repeated references (`[value, value]`)
* `undefined`, `Infinity`, `NaN`, `-0`
* regular expressions
* dates
* `Map` and `Set`


## Goals:

* Performance
* Compact output


## Non-goals:

* Human-readable output
* Stringifying functions or non-POJOs


## Usage

```js
import devalue from 'devalue';

let obj = { a: 1, b: 2 };
obj.c = 3;

devalue(obj); // '{a:1,b:2,c:3}'

obj.self = obj;
devalue(obj); // '(function(a){a.a=1;a.b=2;a.c=3;a.self=a;return a}({}))'
```

If `devalue` encounters a function or a non-POJO, it will throw an error.


## See also

* [lave](https://github.com/jed/lave) by Jed Schmidt
* [arson](https://github.com/benjamn/arson) by Ben Newman
* [tosource](https://github.com/marcello3d/node-tosource) by Marcello Bastéa-Forte


## License

[LIL](LICENSE)