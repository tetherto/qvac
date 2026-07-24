package com.qvac.poc.composableruntime;

import android.os.ParcelFileDescriptor;

interface IRuntimeService {
  int startRuntime(
    in ParcelFileDescriptor socket,
    String bundlePath,
    String filename,
    in String[] args
  );
  void suspendRuntime();
  void resumeRuntime();
  void terminateRuntime();
  void crashRuntime(String bundlePath, String filename, in String[] args);
  int getRuntimePid();
  long getRuntimeGeneration();
}
