#pragma once

#include "OrtTypes.hpp"

#include <cstdint>
#include <vector>

namespace qvac::ttslib::fp16 {

float toFp32(uint16_t h);
uint16_t fromFp32(float f);

bool isFp16(const chatterbox::OrtTensor &tensor);

void readTensorToFloatVector(const chatterbox::OrtTensor &tensor,
                             std::vector<float> &dest,
                             std::vector<float>::iterator destStart);

void readTensorToFloatBuffer(const chatterbox::OrtTensor &tensor, float *dest,
                             int64_t offset, int64_t count);

void writeFloatDataToTensor(const chatterbox::OrtTensor &tensor,
                            const float *src, size_t numElements);

int64_t getNumElements(const chatterbox::OrtTensor &tensor);

} // namespace qvac::ttslib::fp16
