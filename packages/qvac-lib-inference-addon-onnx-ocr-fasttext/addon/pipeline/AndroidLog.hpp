#ifndef ANDROID_LOG_HPP
#define ANDROID_LOG_HPP

#ifdef __ANDROID__
#include <android/log.h>
#define ANDROID_LOG_TAG "OCR_ADDON"
#define ALOG_INFO(msg) __android_log_print(ANDROID_LOG_INFO, ANDROID_LOG_TAG, "%s", (msg).c_str())
#define ALOG_DEBUG(msg) __android_log_print(ANDROID_LOG_DEBUG, ANDROID_LOG_TAG, "%s", (msg).c_str())
#define ALOG_ERROR(msg) __android_log_print(ANDROID_LOG_ERROR, ANDROID_LOG_TAG, "%s", (msg).c_str())
#else
#define ALOG_INFO(msg) (void)0
#define ALOG_DEBUG(msg) (void)0
#define ALOG_ERROR(msg) (void)0
#endif

#endif // ANDROID_LOG_HPP
