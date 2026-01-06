'use strict'

// Note: This import will depend on the addon package installed
const HyperdriveDL = require('@qvac/dl-hyperdrive')
const TranslationNmtcpp = require('../index')

const text = 'Hello World!'

async function main () {
  const hdDL = new HyperdriveDL({
    // The hyperdrive key for en-it translation model weights and config
    key: 'hd://268c2e9b2a3420632e4b6649e32822f42d5dfbda4c7e96daec5b629ed20f99f7'
  })

  const args = {
    loader: hdDL,
    params: { mode: 'full', srcLang: 'eng_Latn', dstLang: 'hin_Deva' },
    diskPath: './models',
    modelName: 'ggml-indictrans2-en-indic-dist-200M.bin'
  }

  const model = new TranslationNmtcpp(args, { modelType: TranslationNmtcpp.ModelTypes.IndicTrans })

  await model.load()

  try {
    const response = await model.run(text)

    await response
      .onUpdate(data => {
        console.log(data)
      })
      .await()

    console.log('translation finished!')
  } finally {
    await model.unload()
  }
}

main().catch(console.error)
