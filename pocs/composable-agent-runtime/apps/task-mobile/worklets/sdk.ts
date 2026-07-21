import abort from 'bare-abort'
import { createRuntime } from './runtime.ts'

export default createRuntime({
  component: 'SDK',
  hardCrash: abort
})
