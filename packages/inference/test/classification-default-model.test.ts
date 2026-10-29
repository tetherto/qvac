import test from 'brittle'
import {
  DEFAULT_CLASSIFICATION_MODEL_SRC,
  classificationModelSrc
} from '@/plugins/builtin/ggml-classification/default-model'

test('classificationModelSrc fills the registry default when modelSrc is omitted', (t) => {
  t.is(classificationModelSrc(undefined, undefined), DEFAULT_CLASSIFICATION_MODEL_SRC)
  t.is(classificationModelSrc('', {}), DEFAULT_CLASSIFICATION_MODEL_SRC)
})

test('classificationModelSrc keeps an explicit source or local weights path', (t) => {
  t.is(
    classificationModelSrc('registry://s3/other/model.gguf', undefined),
    'registry://s3/other/model.gguf'
  )
  t.is(classificationModelSrc('', { modelPath: '/tmp/custom.gguf' }), '')
  t.is(classificationModelSrc(undefined, { modelPath: '/tmp/custom.gguf' }), '')
})
