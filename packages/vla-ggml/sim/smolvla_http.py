"""HTTP-backed wrapper around the QVAC VLA addon (vla-server).

Drop-in replacement for smolvla_ggml.SmolVLAGGML — same predict() signature,
same image preprocessing, same SmolVLM2 tokenizer. Only difference: instead of
calling libsmolvla.so via ctypes, it POSTs a binary blob to the Bare HTTP
server (server.js) which loads the QVAC VlaModel once and stays warm.

Wire protocol (little-endian, no padding):
  request body =
    uint32 header_len
    bytes  header_json   {state_dim, n_images, img_w, img_h, n_tokens, has_noise}
    float32[state_dim]   state (zero-padded to maxStateDim=32 by caller)
    float32[3*h*w] * n_images
    int32[n_tokens]      tokens
    uint8[n_tokens]      mask (0/1)
    float32[chunk*maxActionDim] noise   (only if has_noise)
  response body =
    uint32 header_len
    bytes  header_json   {chunk_size, action_dim, stats}
    float32[chunk_size*action_dim]
"""

import json
import struct
from http.client import HTTPConnection
from typing import Sequence

import numpy as np
import torch
import torch.nn.functional as F


MAX_STATE_DIM = 32
MAX_TOKEN_LEN = 48
IMAGE_SIZE = 512


def preprocess_image(img: np.ndarray) -> np.ndarray:
    """Resize+letterbox to 512x512, normalize to [-1, 1], output (3,512,512) f32.
    Mirrors smolvla_ggml.SmolVLAGGML.preprocess_image exactly.
    """
    img = np.array(img, dtype=np.float32, copy=True)
    if img.max() > 1.0:
        img = img / 255.0
    if img.ndim == 3 and img.shape[2] == 3:
        img = np.ascontiguousarray(np.transpose(img, (2, 0, 1)))  # HWC -> CHW
    t = torch.from_numpy(img).unsqueeze(0)  # (1,3,H,W)
    cur_h, cur_w = t.shape[2:]
    ratio = max(cur_w / IMAGE_SIZE, cur_h / IMAGE_SIZE)
    new_h = int(cur_h / ratio)
    new_w = int(cur_w / ratio)
    t = F.interpolate(t, size=(new_h, new_w), mode='bilinear', align_corners=False)
    pad_h = IMAGE_SIZE - new_h
    pad_w = IMAGE_SIZE - new_w
    t = F.pad(t, (pad_w, 0, pad_h, 0), value=0)
    t = t * 2.0 - 1.0
    return t.squeeze(0).numpy()  # (3, 512, 512)


class SmolVLAHTTP:
    def __init__(self, host: str = '127.0.0.1', port: int = 8765,
                 tokenizer_name: str = 'HuggingFaceTB/SmolVLM2-500M-Video-Instruct'):
        self.host = host
        self.port = port
        from transformers import AutoTokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(tokenizer_name)

        # Pull hparams from the live server so callers can introspect.
        info = self._get_info()
        hp = info['hparams']
        self.chunk_size = hp['chunkSize']
        self.action_dim = hp['actionDim']
        self.max_action_dim = hp['maxActionDim']
        self.max_state_dim = hp['maxStateDim']
        self.max_token_len = hp['tokenizerMaxLength']
        self.image_size = hp['visionImageSize']
        self.last_stats = None

    def _get_info(self) -> dict:
        conn = HTTPConnection(self.host, self.port, timeout=10)
        try:
            conn.request('GET', '/info')
            resp = conn.getresponse()
            body = resp.read()
            if resp.status != 200:
                raise RuntimeError(f'GET /info failed: {resp.status} {body!r}')
            return json.loads(body)
        finally:
            conn.close()

    def tokenize(self, instruction: str):
        tokens = self.tokenizer(
            instruction,
            return_tensors='np',
            padding='max_length',
            max_length=self.max_token_len,
            truncation=True,
        )
        return (
            tokens['input_ids'][0].astype(np.int32),
            tokens['attention_mask'][0].astype(np.uint8),
        )

    def _pad_state(self, state) -> np.ndarray:
        s = np.asarray(state, dtype=np.float32).reshape(-1)
        if s.size > self.max_state_dim:
            raise ValueError(
                f'state length {s.size} exceeds maxStateDim {self.max_state_dim}'
            )
        out = np.zeros(self.max_state_dim, dtype=np.float32)
        out[:s.size] = s
        return out

    def predict(
        self,
        images: Sequence[np.ndarray],
        state,
        instruction: str,
        noise: np.ndarray | None = None,
    ) -> np.ndarray:
        processed = [np.ascontiguousarray(preprocess_image(im), dtype=np.float32)
                     for im in images]
        for i, p in enumerate(processed):
            if p.shape != (3, self.image_size, self.image_size):
                raise ValueError(f'image[{i}] shape {p.shape} != (3,{self.image_size},{self.image_size})')

        state_padded = self._pad_state(state)
        token_ids, mask = self.tokenize(instruction)

        header = {
            'state_dim': int(state_padded.size),
            'n_images': len(processed),
            'img_w': self.image_size,
            'img_h': self.image_size,
            'n_tokens': int(token_ids.size),
            'has_noise': noise is not None,
        }
        header_bytes = json.dumps(header).encode('utf-8')

        parts = [
            struct.pack('<I', len(header_bytes)),
            header_bytes,
            state_padded.tobytes(),
        ]
        for img in processed:
            parts.append(img.tobytes())
        parts.append(token_ids.tobytes())
        parts.append(mask.tobytes())
        if noise is not None:
            n = np.asarray(noise, dtype=np.float32).reshape(-1)
            expected = self.chunk_size * self.max_action_dim
            if n.size != expected:
                raise ValueError(f'noise length {n.size} != {expected}')
            parts.append(n.tobytes())

        body = b''.join(parts)

        conn = HTTPConnection(self.host, self.port, timeout=120)
        try:
            conn.request('POST', '/predict', body=body, headers={
                'content-type': 'application/octet-stream',
                'content-length': str(len(body)),
            })
            resp = conn.getresponse()
            data = resp.read()
            if resp.status != 200:
                raise RuntimeError(f'POST /predict failed: {resp.status} {data!r}')
        finally:
            conn.close()

        (resp_header_len,) = struct.unpack_from('<I', data, 0)
        resp_header = json.loads(data[4:4 + resp_header_len])
        chunk_size = resp_header['chunk_size']
        action_dim = resp_header['action_dim']
        self.last_stats = resp_header.get('stats')

        offset = 4 + resp_header_len
        n_floats = chunk_size * action_dim
        actions = np.frombuffer(data, dtype=np.float32, count=n_floats, offset=offset).copy()
        return actions.reshape(chunk_size, action_dim)

    def predict_raw(self, images_chw, state_padded, token_ids, token_mask, noise=None):
        """Inference with already-preprocessed inputs. Mirrors the lerobot
        integration contract — same shapes/dtypes as smolvla_ggml.predict_raw.

        Args:
            images_chw:   list of (3, H, W) float32 in [-1, 1]
            state_padded: (max_state_dim,) float32 already normalized + zero-padded
            token_ids:    (max_token_len,) int32 already tokenized
            token_mask:   (max_token_len,) bool/uint8 attention mask
            noise:        optional (chunk_size, max_action_dim) float32

        Returns: (chunk_size, action_dim) float32 normalized actions.
        """
        for i, img in enumerate(images_chw):
            if img.shape != (3, self.image_size, self.image_size):
                raise ValueError(f'image[{i}] shape {img.shape} != (3,{self.image_size},{self.image_size})')

        state_arr = np.ascontiguousarray(state_padded, dtype=np.float32).reshape(-1)
        if state_arr.size != self.max_state_dim:
            raise ValueError(f'state shape {state_arr.size} != maxStateDim {self.max_state_dim}')

        tokens = np.ascontiguousarray(token_ids, dtype=np.int32).reshape(-1)
        mask = np.ascontiguousarray(token_mask, dtype=np.uint8).reshape(-1)

        header = {
            'state_dim': int(state_arr.size),
            'n_images': len(images_chw),
            'img_w': self.image_size,
            'img_h': self.image_size,
            'n_tokens': int(tokens.size),
            'has_noise': noise is not None,
        }
        header_bytes = json.dumps(header).encode('utf-8')

        parts = [
            struct.pack('<I', len(header_bytes)),
            header_bytes,
            state_arr.tobytes(),
        ]
        for img in images_chw:
            parts.append(np.ascontiguousarray(img, dtype=np.float32).tobytes())
        parts.append(tokens.tobytes())
        parts.append(mask.tobytes())
        if noise is not None:
            n = np.ascontiguousarray(noise, dtype=np.float32).reshape(-1)
            expected = self.chunk_size * self.max_action_dim
            if n.size != expected:
                raise ValueError(f'noise size {n.size} != {expected}')
            parts.append(n.tobytes())

        body = b''.join(parts)
        conn = HTTPConnection(self.host, self.port, timeout=120)
        try:
            conn.request('POST', '/predict', body=body, headers={
                'content-type': 'application/octet-stream',
                'content-length': str(len(body)),
            })
            resp = conn.getresponse()
            data = resp.read()
            if resp.status != 200:
                raise RuntimeError(f'POST /predict failed: {resp.status} {data!r}')
        finally:
            conn.close()

        (resp_header_len,) = struct.unpack_from('<I', data, 0)
        resp_header = json.loads(data[4:4 + resp_header_len])
        chunk_size = resp_header['chunk_size']
        action_dim = resp_header['action_dim']
        self.last_stats = resp_header.get('stats')
        offset = 4 + resp_header_len
        n_floats = chunk_size * action_dim
        actions = np.frombuffer(data, dtype=np.float32, count=n_floats, offset=offset).copy()
        return actions.reshape(chunk_size, action_dim)
