'use strict'

/**
 * Tests for IndicProcessor
 *
 * These tests verify the preprocessing and postprocessing of text
 * for various Indic languages (Malayalam, Oriya, Hindi, Bengali, etc.).
 */

const test = require('brittle')
const { IndicProcessor } = require('../../third-party/indic-processor')

test('IndicProcessor, should preprocess from eng_Latn to mal_Mlym', (t) => {
  const ip = new IndicProcessor(true)
  const sentences = [
    'Modern science is objective analysis, while spirituality is subjective understanding. Science explores the outer world with a series of questions beginning with the basic query, “What is this? What is this world all about?”, while spirituality begins with the questions, “Who am I?”'
  ]
  const preProcessedBatch = ip.preprocessBatch(
    sentences,
    'eng_Latn',
    'mal_Mlym'
  )
  t.alike(preProcessedBatch, [
    'eng_Latn mal_Mlym Modern science is objective analysis , while spirituality is subjective understanding . Science explores the outer world with a series of questions beginning with the basic query , “ What is this ? What is this world all about ? ” , while spirituality begins with the questions , “ Who am I ? ”'
  ])
})

test('IndicProcessor, should preprocess from mal_Mlym to eng_Latn', (t) => {
  const ip = new IndicProcessor(true)
  const sentences = ['ശരിയായ സമയത്ത് ശരിയായ ചിന്ത ലഭിക്കുക എന്നതാണ് അവബോധം.']
  const preProcessedBatch = ip.preprocessBatch(
    sentences,
    'mal_Mlym',
    'eng_Latn'
  )
  t.alike(preProcessedBatch, [
    'mal_Mlym eng_Latn शरियाय समयत्त् शरियाय चिन्त लभिक्कुक ऎन्नताण् अवबोधं .'
  ])
})

test('IndicProcessor, should preprocess from mal_Mlym to ory_Orya', (t) => {
  const ip = new IndicProcessor(true)
  const sentences = ['ശരിയായ സമയത്ത് ശരിയായ ചിന്ത ലഭിക്കുക എന്നതാണ് അവബോധം.']
  const preProcessedBatch = ip.preprocessBatch(
    sentences,
    'mal_Mlym',
    'ory_Orya'
  )
  t.alike(preProcessedBatch, [
    'mal_Mlym ory_Orya शरियाय समयत्त् शरियाय चिन्त लभिक्कुक ऎन्नताण् अवबोधं .'
  ])
})

test('IndicProcessor, should preprocess from eng_Latn to hin_Deva', (t) => {
  const ip = new IndicProcessor(true)
  const sentences = [
    'Please send an SMS to 9876543210 and an email on newemail123@xyz.com by 15th October, 2023.'
  ]
  const preProcessedBatch = ip.preprocessBatch(
    sentences,
    'eng_Latn',
    'hin_Deva'
  )
  t.alike(preProcessedBatch, [
    'eng_Latn hin_Deva Please send an SMS to 9876543210 and an email on < ID1 > by 15th October , 2023 .'
  ])
})

test('IndicProcessor, should postprocess in mal_Mlym', (t) => {
  const ip = new IndicProcessor(true)
  const sentences = [
    'आधुनिक शास्त्रं वस्तुनिष्ठ विशकलनमाण्, ऎन्नाൽ आत्मीयत आत्मनिष्ठमाय ग्राह्यमाण्. शास्त्रं बाह्यलोकत्तॆ पर्यवेक्षणं चॆय्युन्नत् " इत् ऎन्ताण्? ई लोकं ऎन्ताण्? " ऎन्न अटिस्थान चोद्यङ्ङळिൽ आरंभिक्कुन्न चोद्यङ्ङळुटॆ ऒरु परम्परयोटॆयाण्, आत्मीयत आरंभिक्कुन्नत् " ञाൻ आराण्? "'
  ]

  const postprocessBatch = ip.postprocessBatch(sentences, 'mal_Mlym')
  t.alike(postprocessBatch, [
    'ആധുനിക ശാസ്ത്രം വസ്തുനിഷ്ഠ വിശകലനമാണ്, എന്നാൽ ആത്മീയത ആത്മനിഷ്ഠമായ ഗ്രാഹ്യമാണ്. ശാസ്ത്രം ബാഹ്യലോകത്തെ പര്യവേക്ഷണം ചെയ്യുന്നത് "ഇത് എന്താണ്? ഈ ലോകം എന്താണ്?" എന്ന അടിസ്ഥാന ചോദ്യങ്ങളിൽ ആരംഭിക്കുന്ന ചോദ്യങ്ങളുടെ ഒരു പരമ്പരയോടെയാണ്, ആത്മീയത ആരംഭിക്കുന്നത് "ഞാൻ ആരാണ്?"'
  ])
})

test('IndicProcessor, should postprocess in ory_Orya', (t) => {
  const ip = new IndicProcessor(true)
  const sentences = [
    "अन्तर्दृष्टि हेउछि ठिक् समय़रे सठिक् चिन्ताधारा पाइबा । अन्तर्दृष्टिरु किछि बाहारिबा सर्बदा सठिक् | आपणङ्कर सफळता आपणङ्क अन्तर्दृष्टि उपरे निर्भर करे | आपणङ्क कार्य्य़ सफळतारे समाप्त हुए | ताहा अन्तर्दृष्टि | सफळता कार्य्य़रे समाप्ति अन्तर्दृष्टि | अन्तर्दृष्टि निश्चित भाबरे पुस्तकरु आसिपारिब नाहिँ | अन्तर्दृष्टि = इन + ट्य़ुसन् ; एहार अर्थ हेउछि'ट्य़ुसन्'( ज्ञान ) याहा भितरु आसे |"
  ]
  const postprocessBatch = ip.postprocessBatch(sentences, 'ory_Orya')
  t.alike(postprocessBatch, [
    "ଅନ୍ତର୍ଦୃଷ୍ଟି ହେଉଛି ଠିକ୍ ସମଯ଼ରେ ସଠିକ୍ ଚିନ୍ତାଧାରା ପାଇବା। ଅନ୍ତର୍ଦୃଷ୍ଟିରୁ କିଛି ବାହାରିବା ସର୍ବଦା ସଠିକ୍ | ଆପଣଙ୍କର ସଫଳତା ଆପଣଙ୍କ ଅନ୍ତର୍ଦୃଷ୍ଟି ଉପରେ ନିର୍ଭର କରେ | ଆପଣଙ୍କ କାର୍ଯ୍ଯ଼ ସଫଳତାରେ ସମାପ୍ତ ହୁଏ | ତାହା ଅନ୍ତର୍ଦୃଷ୍ଟି | ସଫଳତା କାର୍ଯ୍ଯ଼ରେ ସମାପ୍ତି ଅନ୍ତର୍ଦୃଷ୍ଟି | ଅନ୍ତର୍ଦୃଷ୍ଟି ନିଶ୍ଚିତ ଭାବରେ ପୁସ୍ତକରୁ ଆସିପାରିବ ନାହିଁ | ଅନ୍ତର୍ଦୃଷ୍ଟି = ଇନ + ଟ୍ଯ଼ୁସନ୍; ଏହାର ଅର୍ଥ ହେଉଛି'ଟ୍ଯ଼ୁସନ୍'(ଜ୍ଞାନ) ଯାହା ଭିତରୁ ଆସେ |"
  ])
})

test('IndicProcessor, should postprocess in mni_Beng', (t) => {
  const ip = new IndicProcessor(true)
  const sentences = [
    'इॎथ्नोग्रफि हाय़बसि मतम चाना अचुम्बा ৱाखल फंलकपा असिनि । इॎथ्नोग्रफिगी मतुं इन्ना लाकपा अमना मतम चुप्पदा अचुम्बा ओइ । मसिगी माय़ पाकपसिना मसिगी इनत्युइसनगी मखा पोल्लि । मसिगी माय़ पाकपसि माय़ पाकपगी मखा पोल्लि । मसिगी माय़ पाकपसि इनत्युइसनगी ৱाखल्लोन्नि । माय़ पाकपगी थौओंबु मपुं फाहनबा हाय़बसिना इॎथ्नोग्रफिनि । मसिगी ममिनि हाय़बदि इनत्युइजन्ना लाइरिकशिंदगी लाकपदा नत्तना इनत्युइजनगी ৱाखल्लोन्ना मरम ओइदे ।'
  ]
  const postprocessBatch = ip.postprocessBatch(sentences, 'mni_Beng')
  t.alike(postprocessBatch, [
    'ইৎথ্নোগ্রফি হায়বসি মতম চানা অচুম্বা ৱাখল ফংলকপা অসিনি। ইৎথ্নোগ্রফিগী মতুং ইন্না লাকপা অমনা মতম চুপ্পদা অচুম্বা ওই। মসিগী মায় পাকপসিনা মসিগী ইনত্যুইসনগী মখা পোল্লি। মসিগী মায় পাকপসি মায় পাকপগী মখা পোল্লি। মসিগী মায় পাকপসি ইনত্যুইসনগী ৱাখল্লোন্নি। মায় পাকপগী থৌওংবু মপুং ফাহনবা হায়বসিনা ইৎথ্নোগ্রফিনি। মসিগী মমিনি হায়বদি ইনত্যুইজন্না লাইরিকশিংদগী লাকপদা নত্তনা ইনত্যুইজনগী ৱাখল্লোন্না মরম ওইদে।'
  ])
})

test('IndicProcessor,should postprocess & postprocess from eng_Latn to hin_Deva, create placeholders and postprocess', (t) => {
  const ip = new IndicProcessor(true)
  const sentences = [
    'Please send an SMS to 9876543210 and an email on newemail123@xyz.com by 15th October, 2023.'
  ]
  const preProcessedBatch = ip.preprocessBatch(
    sentences,
    'eng_Latn',
    'hin_Deva'
  )
  t.alike(preProcessedBatch, [
    'eng_Latn hin_Deva Please send an SMS to 9876543210 and an email on < ID1 > by 15th October , 2023 .'
  ])

  const postprocessBatch = ip.postprocessBatch(
    [
      'कृपया 9876543210 पर एक एस. एम. एस. और 15 अक्टूबर, 2023 तक < ID1 > पर एक ईमेल भेजें ।'
    ],
    'hin_Deva'
  )
  t.alike(postprocessBatch, [
    'कृपया 9876543210 पर एक एस. एम. एस. और 15 अक्टूबर, 2023 तक newemail123@xyz.com पर एक ईमेल भेजें।'
  ])
})
