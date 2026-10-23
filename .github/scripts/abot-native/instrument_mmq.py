"""Add opt-in scratch-padding controls to a disposable pinned CUDA checkout."""
from pathlib import Path
import argparse
from instrument import replace_once


def instrument_mmq(root):
    path = Path(root) / 'src/ggml-cuda/mmq.cu'
    source = path.read_text()
    source = replace_once(source, '#include <cstdint>', '#include <cstdint>\n#include <cstdio>\n#include <cstdlib>')
    anchor = '        ggml_cuda_pool_alloc<char> src1_q8_1(ctx.pool(), nbytes_src1_q8_1);'
    source = replace_once(source, anchor, anchor + '''
        const size_t diag_payload = ne13*ne12 * ne11*ne10_padded * y_block_size/y_values_per_block;
        const char* diag_pattern = std::getenv("QVAC_MMQ_TAIL_PATTERN");
        const char* diag_poison = std::getenv("QVAC_MMQ_POISON_VALID");
        if (std::getenv("QVAC_MMQ_TRACE")) {
            std::fprintf(stderr, "MMQ_SCRATCH {\\"base\\":\\"%p\\",\\"tail\\":\\"%p\\",\\"payloadBytes\\":%zu,\\"allocatedBytes\\":%zu,\\"k\\":%lld,\\"m\\":%lld,\\"n\\":%lld}\\n",
                static_cast<void*>(src1_q8_1.get()), static_cast<void*>(src1_q8_1.get() + diag_payload),
                diag_payload, nbytes_src1_q8_1, static_cast<long long>(ne00), static_cast<long long>(ne01), static_cast<long long>(ne11));
            std::fflush(stderr);
        }
        if (diag_pattern && src0->type == GGML_TYPE_Q8_0) {
            const int value = std::atoi(diag_pattern);
            GGML_ASSERT(value == 0 || value == 165 || value == 255);
            CUDA_CHECK(cudaMemsetAsync(src1_q8_1.get() + diag_payload, value,
                                      nbytes_src1_q8_1 - diag_payload, stream));
        }
''')
    source = replace_once(source, '        // Stride depends on quantization format', '''        // Positive control only: deliberately corrupt the initialized payload.
        if (diag_poison && src0->type == GGML_TYPE_Q8_0) {
            CUDA_CHECK(cudaMemsetAsync(src1_q8_1.get(), 0, diag_payload, stream));
        }

        // Stride depends on quantization format''')
    path.write_text(source)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('ggml', type=Path)
    instrument_mmq(parser.parse_args().ggml)
