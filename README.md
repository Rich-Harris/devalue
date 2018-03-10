# devalue

Like `JSON.stringify`, but handles cyclical references, repeated references, and .

Goals:

* Performance
* Compact output

Non-goals:

* Human-readable output
* Stringifying functions or non-POJOs