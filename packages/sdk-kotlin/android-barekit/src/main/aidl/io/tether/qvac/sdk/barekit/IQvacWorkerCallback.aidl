package io.tether.qvac.sdk.barekit;

interface IQvacWorkerCallback {
    void onNext(String payload);
    void onChunk(String payloadChunk, boolean endOfEnvelope);
    void onError(String message);
    void onComplete();
}
