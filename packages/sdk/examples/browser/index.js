/* global document, navigator */

const $ = (selector) => document.querySelector(selector)

function isLinuxChrome() {
  const userAgent = navigator.userAgent
  return (
    /\b(?:Chrome|Chromium)\//.test(userAgent) &&
    !/\b(?:Android|Edg|OPR)\//.test(userAgent) &&
    /\bLinux\b/.test(userAgent)
  )
}

// Without a WebGPU adapter that has shader-f16, the engine runs on the CPU.
async function checkWebGpu() {
  let ready = false
  for (const powerPreference of ['high-performance', 'low-power']) {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference }).catch(() => null)
    ready ||= adapter?.features.has('shader-f16') ?? false
  }
  $('#readiness').textContent = ready ? 'WebGPU ready' : 'No WebGPU with shader-f16: CPU only'
  $('#readiness').className = `status ${ready ? 'ready' : 'failed'}`
  $('#webgpu-help').hidden = ready || !isLinuxChrome()
}

$('#webgpu-help').addEventListener('click', () => $('#webgpu-dialog').showModal())
void checkWebGpu()
