# Build instructions

## Prerequisites

You must have installed node, npm, and vcpkg, as well as the build tools appropriate for your environment.

## Linux

Install prerequisite packages.
```
sudo apt install build-essential autoconf automake libtool pkg-config
```

Install vcpkg ([docs](https://learn.microsoft.com/en-us/vcpkg/get_started/get-started?pivots=shell-bash)).

```
git clone https://github.com/microsoft/vcpkg.git
cd vcpkg && ./bootstrap-vcpkg.sh -disableMetrics
cd ..
```

Configure the VCPKG_ROOT environment variable.
```
export VCPKG_ROOT=/path/to/vcpkg
export PATH=$VCPKG_ROOT:$PATH
```

Install node and npm ([docs](https://nodejs.org/en/download)).
```
curl -o- https://fnm.vercel.app/install | bash
fnm install 22
```

Globally install bare and bare-make from npm.
```
npm install -g bare bare-make
```

Clone the repository, install dependencies, and build.
```
git clone https://github.com/tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext.git
cd qvac-lib-inference-addon-onnx-ocr-fasttext
npm install
bare-make generate && bare-make build && bare-make install
```

Run test
```
bare test/addon.test.js
```

