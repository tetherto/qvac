# Changelog v0.13.0

Release Date: 2026-11-25

## 📦 Models

- Prefix QVAC-trained model constants with QVAC_ and regenerate the catalogs. (see PR [#5941](https://github.com/tetherto/qvac/pull/5941)) - See [model changes](./models.md)
  Added: BOTPSY_0_8B_TOOL_CALLING_BF16, BOTPSY_0_8B_TOOL_CALLING_Q4_K_M, BOTPSY_0_8B_TOOL_CALLING_Q8_0, DEEPSEEK_V4_1_552B_A16B_DSPARK_Q8_0, DEEPSEEK_V4_1_552B_A16B_MULTIMODAL_Q4_K_M_SHARD (and 7 more)
- Add Inkling 2 Mini and Ternary Bonsai 2.5 27B model constants. (see PR [#6023](https://github.com/tetherto/qvac/pull/6023)) - See [model changes](./models.md)
  Added: INKLING2_MINI_26B_A3B_MULTIMODAL_UD_Q4_K_M, MMPROJ_INKLING2_MINI_26B_A3B_MULTIMODAL_F16, INKLING2_MINI_26B_A3B_DSPARK_Q8_0, INKLING2_MINI_26B_A3B_DFLASH2_Q8_0, TERNARY_BONSAI_2_5_27B_MULTIMODAL_Q2_0 (and 1 more)

## ⚙️ Infrastructure

- Generate the SDK clients at build time. (see PR [#5827](https://github.com/tetherto/qvac/pull/5827))

## Compatibility

- Released with the SDK train. The optional `@qvac/cli` peer moves to `^0.21.0`.
