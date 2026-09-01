// Bare worker that fails before the IPC handshake, like a native addon dlopen error.

throw new Error('QVAC_REPRO_NATIVE_LOAD_ERROR: simulated dlopen failure before worker handshake')
