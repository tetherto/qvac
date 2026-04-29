# @qvac/vla

Hello-world inference addon scaffold built on `qvac-lib-inference-addon-cpp`.
Inference backend: **raw ggml**.

## Build

```
npm install
bare-make generate
bare-make build
bare-make install
```

## Test

```
npm run test:unit          # JS unit tests (brittle)
npm run test:integration   # loads the native addon and calls sayHello()
npm run test:cpp           # GoogleTest C++ unit tests
```

## Usage

```js
const { sayHello } = require('@qvac/vla')
console.log(sayHello('qvac')) // => "hello, qvac"
```
