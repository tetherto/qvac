package com.qvac.poc.composableruntime

import android.app.Service
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.Process
import android.os.SystemClock
import android.util.Log
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet

class BareRuntimeService : Service() {
  private lateinit var runtimeHandler: Handler
  private val socketWriter = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "qvac-sdk-socket-writer")
  }

  private var worklet: Worklet? = null
  private var ipc: IPC? = null
  private var crashWorklet: Worklet? = null
  private var crashIpc: IPC? = null
  private var socket: ParcelFileDescriptor? = null
  private var socketInput: FileInputStream? = null
  private var socketOutput: FileOutputStream? = null
  private var socketReader: Thread? = null
  private var running = false
  private val generation = SystemClock.elapsedRealtimeNanos()

  private val binder = object : IRuntimeService.Stub() {
    override fun startRuntime(
      socket: ParcelFileDescriptor,
      bundlePath: String,
      filename: String,
      args: Array<out String>
    ): Int {
      onRuntimeThread {
        startRuntimeOnThread(
          socket,
          bundlePath,
          filename,
          Array(args.size) { index -> args[index] }
        )
      }
      return Process.myPid()
    }

    override fun suspendRuntime() {
      runtimeHandler.post { worklet?.suspend() }
    }

    override fun resumeRuntime() {
      runtimeHandler.post { worklet?.resume() }
    }

    override fun terminateRuntime() {
      onRuntimeThread { stopRuntimeOnThread() }
      stopSelf()
    }

    override fun crashRuntime(
      bundlePath: String,
      filename: String,
      args: Array<out String>
    ) {
      runtimeHandler.post {
        val probe = Worklet(Worklet.Options())
        crashWorklet = probe
        probe.start(
          filename,
          loadBundle(bundlePath),
          Array(args.size) { index -> args[index] }
        )
        crashIpc = IPC(probe)
      }
    }

    override fun getRuntimePid() = Process.myPid()

    override fun getRuntimeGeneration() = generation
  }

  override fun onCreate() {
    super.onCreate()
    runtimeHandler = Handler(Looper.getMainLooper())
    Log.i(TAG, "created pid=${Process.myPid()} generation=$generation")
  }

  override fun onBind(intent: Intent?): IBinder = binder

  override fun onDestroy() {
    if (::runtimeHandler.isInitialized) {
      onRuntimeThread { stopRuntimeOnThread() }
    }
    socketWriter.shutdownNow()
    super.onDestroy()
  }

  private fun startRuntimeOnThread(
    descriptor: ParcelFileDescriptor,
    bundlePath: String,
    filename: String,
    args: Array<String>
  ) {
    stopRuntimeOnThread()

    socket = descriptor
    socketInput = FileInputStream(descriptor.fileDescriptor)
    socketOutput = FileOutputStream(descriptor.fileDescriptor)

    val nextWorklet = Worklet(Worklet.Options())
    worklet = nextWorklet
    running = true

    nextWorklet.start(filename, loadBundle(bundlePath), args)
    val nextIpc = IPC(nextWorklet)
    ipc = nextIpc

    readRuntimeOutput(nextIpc)
    startSocketReader(nextIpc)
    Log.i(TAG, "runtime started pid=${Process.myPid()} file=$filename")
  }

  private fun readRuntimeOutput(activeIpc: IPC) {
    activeIpc.read { data, error ->
      if (!running || ipc !== activeIpc) return@read
      if (error != null) {
        Log.e(TAG, "runtime IPC read failed", error)
        closeTransport()
        return@read
      }
      if (data != null) {
        val bytes = ByteArray(data.remaining())
        data.get(bytes)
        socketWriter.execute {
          try {
            socketOutput?.write(bytes)
            socketOutput?.flush()
          } catch (exception: Exception) {
            Log.e(TAG, "socket write failed", exception)
            closeTransport()
          }
        }
      }
      if (running && ipc === activeIpc) readRuntimeOutput(activeIpc)
    }
  }

  private fun startSocketReader(activeIpc: IPC) {
    socketReader = Thread({
      val buffer = ByteArray(SOCKET_BUFFER_BYTES)
      try {
        while (running && ipc === activeIpc) {
          val read = socketInput?.read(buffer) ?: -1
          if (read < 0) break
          if (read == 0) continue
          val bytes = buffer.copyOf(read)
          activeIpc.write(ByteBuffer.wrap(bytes)) { error ->
            if (error != null) {
              Log.e(TAG, "runtime IPC write failed", error)
              closeTransport()
            }
          }
        }
      } catch (exception: Exception) {
        if (running) Log.e(TAG, "socket read failed", exception)
      } finally {
        closeTransport()
      }
    }, "qvac-sdk-socket-reader").also { it.start() }
  }

  private fun stopRuntimeOnThread() {
    running = false
    closeTransport()
    crashIpc?.close()
    crashIpc = null
    crashWorklet?.terminate()
    crashWorklet = null
    ipc?.close()
    ipc = null
    worklet?.terminate()
    worklet = null
  }

  private fun closeTransport() {
    running = false
    try {
      socket?.close()
    } catch (_: Exception) {
    }
    socket = null
    socketInput = null
    socketOutput = null
    socketReader?.interrupt()
    socketReader = null
  }

  private fun onRuntimeThread(action: () -> Unit) {
    if (Looper.myLooper() === runtimeHandler.looper) {
      action()
      return
    }

    val completed = CountDownLatch(1)
    val failure = AtomicReference<Throwable?>()
    runtimeHandler.post {
      try {
        action()
      } catch (error: Throwable) {
        failure.set(error)
      } finally {
        completed.countDown()
      }
    }
    check(completed.await(RUNTIME_COMMAND_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
      "Bare runtime command timed out"
    }
    failure.get()?.let { throw IllegalStateException("Bare runtime command failed", it) }
  }

  private fun normalizePath(value: String): String {
    return if (value.startsWith("file:")) {
      requireNotNull(Uri.parse(value).path) { "Bundle URI has no file path" }
    } else {
      value
    }
  }

  private fun loadBundle(bundlePath: String): ByteBuffer {
    val bytes = FileInputStream(normalizePath(bundlePath)).use { it.readBytes() }
    return ByteBuffer.wrap(bytes)
  }

  companion object {
    private const val TAG = "QvacRuntimeService"
    private const val SOCKET_BUFFER_BYTES = 64 * 1024
    private const val RUNTIME_COMMAND_TIMEOUT_SECONDS = 10L
  }
}
