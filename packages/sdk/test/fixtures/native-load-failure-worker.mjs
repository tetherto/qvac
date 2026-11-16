// Bare worker that fails while loading, like a native addon dlopen error.

throw new Error('QVAC_REPRO_NATIVE_LOAD_ERROR: simulated dlopen failure before the worker is ready')
