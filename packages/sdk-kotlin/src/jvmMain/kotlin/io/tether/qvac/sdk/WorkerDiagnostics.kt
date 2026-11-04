package io.tether.qvac.sdk

import java.io.InputStream

/** A continuously drained, bounded tail. Even a worker emitting no newlines cannot fill memory. */
internal class WorkerDiagnostics(input: InputStream) {
    private val tail = StringBuilder()
    val text: String get() = synchronized(tail) { tail.toString() }
    init {
        Thread({
            runCatching {
                input.reader(Charsets.UTF_8).use { reader ->
                    val buffer = CharArray(2048)
                    while (true) {
                        val count = reader.read(buffer)
                        if (count < 0) break
                        synchronized(tail) {
                            tail.append(buffer, 0, count)
                            if (tail.length > 16_384) tail.delete(0, tail.length - 16_384)
                        }
                    }
                }
            }
        }, "qvac-worker-log-drain").apply { isDaemon = true; start() }
    }
}
