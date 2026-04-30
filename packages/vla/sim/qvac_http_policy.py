"""Drop-in SmolVLA policy that uses the QVAC VLA addon over HTTP for inference.

Mirrors smolvla-ggml/ggml_policy.py exactly — only difference is the backend
(SmolVLAHTTP instead of SmolVLAGGML). Plugs into LeRobot eval pipeline so all
preprocessing, normalization, action queueing stay in LeRobot.
"""

import torch
import numpy as np

from lerobot.policies.smolvla.modeling_smolvla import SmolVLAPolicy, resize_with_pad, pad_vector
from lerobot.policies.utils import populate_queues
from lerobot.utils.constants import ACTION, OBS_STATE, OBS_LANGUAGE_TOKENS, OBS_LANGUAGE_ATTENTION_MASK

from smolvla_http import SmolVLAHTTP


class SmolVLAQvacHTTPPolicy(SmolVLAPolicy):
    """SmolVLA policy that uses the QVAC VLA addon over HTTP.

    Inherits everything from SmolVLAPolicy except the forward pass, which is
    routed through SmolVLAHTTP.predict_raw().
    """

    @classmethod
    def from_pytorch(cls, pytorch_policy, host='127.0.0.1', port=8765):
        policy = pytorch_policy
        policy.__class__ = cls
        policy.qvac = SmolVLAHTTP(host=host, port=port)
        return policy

    @torch.no_grad()
    def select_action(self, batch, noise=None, **kwargs):
        self.eval()
        batch = self._prepare_batch(batch)
        self._queues = populate_queues(self._queues, batch, exclude_keys=[ACTION])

        if len(self._queues[ACTION]) == 0:
            actions = self._get_action_chunk_qvac(batch, noise)
            self._queues[ACTION].extend(actions.transpose(0, 1)[:self.config.n_action_steps])

        return self._queues[ACTION].popleft()

    def _get_action_chunk_qvac(self, batch, noise=None):
        images_chw = []
        present_img_keys = [k for k in self.config.image_features if k in batch]
        for key in present_img_keys:
            img = batch[key]
            if img.ndim == 5:
                img = img[:, -1]
            if self.config.resize_imgs_with_padding is not None:
                img = resize_with_pad(img, *self.config.resize_imgs_with_padding, pad_value=0)
            img = img * 2.0 - 1.0
            images_chw.append(img[0].cpu().numpy().astype(np.float32))

        missing = [k for k in self.config.image_features if k not in batch]
        for i, _ in enumerate(missing):
            if i >= getattr(self.config, 'empty_cameras', 0):
                break
            images_chw.append(np.full_like(images_chw[-1], -1.0, dtype=np.float32))

        state = batch[OBS_STATE]
        if state.ndim > 2:
            state = state[:, -1, :]
        state_padded = pad_vector(state, self.config.max_state_dim)
        state_np = state_padded[0].cpu().numpy().astype(np.float32)

        lang_tokens = batch[OBS_LANGUAGE_TOKENS][0].cpu().numpy().astype(np.int32)
        lang_mask = batch[OBS_LANGUAGE_ATTENTION_MASK][0].cpu().numpy().astype(np.bool_)

        if noise is None:
            noise = torch.randn(1, self.config.chunk_size, self.config.max_action_dim)
        noise_np = noise[0].cpu().numpy().astype(np.float32)

        actions_np = self.qvac.predict_raw(
            images_chw=images_chw,
            state_padded=state_np,
            token_ids=lang_tokens,
            token_mask=lang_mask,
            noise=noise_np,
        )
        return torch.from_numpy(actions_np).unsqueeze(0).float()
