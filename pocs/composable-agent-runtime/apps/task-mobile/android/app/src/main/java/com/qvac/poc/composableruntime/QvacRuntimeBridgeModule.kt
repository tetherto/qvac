package com.qvac.poc.composableruntime

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.concurrent.Executors

class QvacRuntimeBridgeModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  private val lock = Any()
  private val socketWriter = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "qvac-runtime-bridge-writer")
  }
  private var service: IRuntimeService? = null
  private var serviceBinder: IBinder? = null
  private var hostSocket: ParcelFileDescriptor? = null
  private var socketInput: FileInputStream? = null
  private var socketOutput: FileOutputStream? = null
  private var socketReader: Thread? = null
  private var pendingStart: StartRequest? = null
  private var bound = false
  private var gracefulStop = false
  private var unexpectedDeathReported = false
  private var runtimePid: Int? = null
  private var runtimeGeneration: Long? = null

  private val deathRecipient = IBinder.DeathRecipient {
    handleUnexpectedDeath("SDK service binder died")
  }

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, binder: IBinder) {
      synchronized(lock) {
        val remote = IRuntimeService.Stub.asInterface(binder)
        try {
          binder.linkToDeath(deathRecipient, 0)
          service = remote
          serviceBinder = binder
          pendingStart?.let { launchRuntime(remote, it) }
        } catch (error: Exception) {
          failPendingStart(error)
          handleUnexpectedDeath("SDK service connection failed: ${error.message}")
        }
      }
    }

    override fun onServiceDisconnected(name: ComponentName) {
      handleUnexpectedDeath("SDK service disconnected")
    }

    override fun onBindingDied(name: ComponentName) {
      handleUnexpectedDeath("SDK service binding died")
    }

    override fun onNullBinding(name: ComponentName) {
      synchronized(lock) {
        failPendingStart(IllegalStateException("SDK service returned a null binding"))
        cleanupBinding()
      }
    }
  }

  override fun getName() = NAME

  @ReactMethod
  fun startRuntime(
    bundlePath: String,
    filename: String,
    args: ReadableArray,
    promise: Promise
  ) {
    synchronized(lock) {
      if (pendingStart != null || service != null || hostSocket != null) {
        promise.reject("E_RUNTIME_ACTIVE", "SDK runtime is already active")
        return
      }

      gracefulStop = false
      unexpectedDeathReported = false
      pendingStart = StartRequest(
        bundlePath,
        filename,
        Array(args.size()) { index -> args.getString(index) ?: "" },
        promise
      )

      val intent = Intent(reactContext, BareRuntimeService::class.java)
      bound = reactContext.bindService(intent, connection, Context.BIND_AUTO_CREATE)
      if (!bound) {
        failPendingStart(IllegalStateException("Could not bind SDK runtime service"))
        cleanupBinding()
      }
    }
  }

  @ReactMethod
  fun write(encoded: String) {
    val bytes = Base64.decode(encoded, Base64.NO_WRAP)
    socketWriter.execute {
      val output = synchronized(lock) { socketOutput }
      try {
        output?.write(bytes)
        output?.flush()
      } catch (error: Exception) {
        handleUnexpectedDeath("SDK runtime socket write failed: ${error.message}")
      }
    }
  }

  @ReactMethod
  fun suspendRuntime() {
    synchronized(lock) {
      service?.suspendRuntime()
    }
  }

  @ReactMethod
  fun resumeRuntime() {
    synchronized(lock) {
      service?.resumeRuntime()
    }
  }

  @ReactMethod
  fun terminateRuntime(promise: Promise) {
    synchronized(lock) {
      gracefulStop = true
      try {
        service?.terminateRuntime()
        cleanupBinding()
        promise.resolve(null)
      } catch (error: Exception) {
        cleanupBinding()
        promise.reject("E_RUNTIME_TERMINATE", error)
      }
    }
  }

  @ReactMethod
  fun crashRuntime(
    bundlePath: String,
    filename: String,
    args: ReadableArray
  ) {
    synchronized(lock) {
      val remote = checkNotNull(service) { "SDK runtime is not active" }
      remote.crashRuntime(
        bundlePath,
        filename,
        Array(args.size()) { index -> args.getString(index) ?: "" }
      )
    }
  }

  @ReactMethod
  fun addListener(eventName: String) {
    // Required by NativeEventEmitter.
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // Required by NativeEventEmitter.
  }

  override fun invalidate() {
    synchronized(lock) {
      gracefulStop = true
      try {
        service?.terminateRuntime()
      } catch (_: Exception) {
      }
      cleanupBinding()
    }
    socketWriter.shutdownNow()
    super.invalidate()
  }

  private fun launchRuntime(remote: IRuntimeService, request: StartRequest) {
    try {
      val pair = ParcelFileDescriptor.createReliableSocketPair()
      val host = pair[0]
      val runtime = pair[1]
      hostSocket = host
      socketInput = FileInputStream(host.fileDescriptor)
      socketOutput = FileOutputStream(host.fileDescriptor)

      val pid = remote.startRuntime(
        runtime,
        request.bundlePath,
        request.filename,
        request.args
      )
      runtime.close()
      runtimePid = pid
      runtimeGeneration = remote.runtimeGeneration
      pendingStart = null
      startSocketReader()

      val result = Arguments.createMap().apply {
        putInt("pid", pid)
        putDouble("generation", runtimeGeneration!!.toDouble())
      }
      request.promise.resolve(result)
    } catch (error: Exception) {
      failPendingStart(error)
      cleanupBinding()
    }
  }

  private fun startSocketReader() {
    socketReader = Thread({
      val buffer = ByteArray(SOCKET_BUFFER_BYTES)
      try {
        while (!Thread.currentThread().isInterrupted) {
          val input = synchronized(lock) { socketInput }
          val read = input?.read(buffer) ?: -1
          if (read < 0) break
          if (read == 0) continue
          val encoded = Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP)
          emit(DATA_EVENT, encoded)
        }
        if (!gracefulStop) handleUnexpectedDeath("SDK runtime socket closed")
      } catch (error: Exception) {
        if (!gracefulStop) {
          handleUnexpectedDeath("SDK runtime socket failed: ${error.message}")
        }
      }
    }, "qvac-runtime-bridge-reader").also { it.start() }
  }

  private fun handleUnexpectedDeath(reason: String) {
    synchronized(lock) {
      if (gracefulStop || unexpectedDeathReported) return
      unexpectedDeathReported = true
      val pid = runtimePid
      val generation = runtimeGeneration
      failPendingStart(IllegalStateException(reason))
      cleanupBinding()
      val event = Arguments.createMap().apply {
        putString("reason", reason)
        if (pid != null) putInt("pid", pid)
        if (generation != null) putDouble("generation", generation.toDouble())
      }
      emit(DEATH_EVENT, event)
    }
  }

  private fun failPendingStart(error: Throwable) {
    pendingStart?.promise?.reject("E_RUNTIME_START", error)
    pendingStart = null
  }

  private fun cleanupBinding() {
    try {
      serviceBinder?.unlinkToDeath(deathRecipient, 0)
    } catch (_: Exception) {
    }
    service = null
    serviceBinder = null
    runtimePid = null
    runtimeGeneration = null
    try {
      hostSocket?.close()
    } catch (_: Exception) {
    }
    hostSocket = null
    socketInput = null
    socketOutput = null
    socketReader?.interrupt()
    socketReader = null
    if (bound) {
      try {
        reactContext.unbindService(connection)
      } catch (_: Exception) {
      }
    }
    bound = false
  }

  private fun emit(event: String, value: Any) {
    if (!reactContext.hasActiveReactInstance()) return
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, value)
  }

  private data class StartRequest(
    val bundlePath: String,
    val filename: String,
    val args: Array<String>,
    val promise: Promise
  )

  companion object {
    const val NAME = "QvacRuntimeBridge"
    const val DATA_EVENT = "QvacRuntimeData"
    const val DEATH_EVENT = "QvacRuntimeDied"
    private const val SOCKET_BUFFER_BYTES = 64 * 1024
  }
}
