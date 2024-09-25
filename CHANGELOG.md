# devalue changelog

## 5.1.1

- Only iterate over own properties of reducers ([#80](https://github.com/Rich-Harris/devalue/pull/80))

## 5.1.0

- Handle typed arrays and array buffers ([#69](https://github.com/Rich-Harris/devalue/pull/69))
- Add `sideEffects: false` to `package.json` ([#81](https://github.com/Rich-Harris/devalue/pull/81))
- Better errors when keys are invalid identifiers ([#82](https://github.com/Rich-Harris/devalue/pull/82))

## 5.0.0

- Ignore non-enumerable symbolic keys ([#78](https://github.com/Rich-Harris/devalue/pull/78))

## 4.3.3

- Support invalid dates ([#61](https://github.com/Rich-Harris/devalue/pull/61))
- Fix incorrect `error.path` when object contains a map ([#64](https://github.com/Rich-Harris/devalue/pull/64))

## 4.3.2

- Better type declarations ([#66](https://github.com/Rich-Harris/devalue/pull/66))

## 4.3.1

- Faster ([#65](https://github.com/Rich-Harris/devalue/pull/65))

## 4.3.0

- Support custom types ([#58](https://github.com/Rich-Harris/devalue/pull/58))

## 4.2.3

- Correctly escape control characters ([#57](https://github.com/Rich-Harris/devalue/pull/57))

## 4.2.2

- Remove `pkg.main` ([#56](https://github.com/Rich-Harris/devalue/pull/56))

## 4.2.1

- Re-use internal helper ([#55](https://github.com/Rich-Harris/devalue/pull/55))

## 4.2.0

- Add `unflatten` ([#48](https://github.com/Rich-Harris/devalue/pull/48))

## 4.1.0

- Only deduplicate non-primitives ([#44](https://github.com/Rich-Harris/devalue/pull/44))
- Error on invalid input ([#43](https://github.com/Rich-Harris/devalue/pull/43))
- Fix `pkg.exports` ([#45](https://github.com/Rich-Harris/devalue/pull/45))

## 4.0.1

- Remove `devalue` export so that run time errors become build time errors

## 4.0.0

- Rename `devalue` function to `uneval`
- Add `parse` and `stringify` functions

## 3.1.3

- Add `pkg.main`

## 3.1.2

- Include `pkg.types`

## 3.1.1

- Include `types` in `pkg.files`

## 3.1.0

- Include `path` in error object if value is unserializable

## 3.0.1

- Prevent duplicate parameter names ([#33](https://github.com/Rich-Harris/devalue/pull/33))

## 3.0.0

- Convert to ESM
- Change `import devalue` to `import { devalue }`
- Support `BigInt`

## 2.0.1

- Prevent regex XSS vulnerability in non-Node environments

## 2.0.0

- Change license to MIT

## 1.1.1

- Prevent object key XSS vulnerability ([#19](https://github.com/Rich-Harris/devalue/issues/19))

## 1.1.0

- Escape lone surrogates ([#13](https://github.com/Rich-Harris/devalue/issues/13))

## 1.0.4

- Smaller output ([#10](https://github.com/Rich-Harris/devalue/pull/10))

## 1.0.3

- Detect POJOs cross-realm ([#7](https://github.com/Rich-Harris/devalue/pull/7))
- Error on symbolic keys ([#7](https://github.com/Rich-Harris/devalue/pull/7))

## 1.0.2

- Fix global name for UMD build

## 1.0.1

- XSS mitigation ([#1](https://github.com/Rich-Harris/devalue/issues/1))

## 1.0.0

- First release
