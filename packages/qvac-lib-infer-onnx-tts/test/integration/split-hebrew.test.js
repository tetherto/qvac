'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadChatterboxTTS, runChatterboxTTSWithSplit } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

const CHATTERBOX_VARIANT = os.getEnv('CHATTERBOX_VARIANT') || 'fp32'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const HEBREW_LONG_TEXT = `בערב שקט בעיירה קטנה על חוף הים, צעיר בשם דניאל עמד בקצה המזח והביט בגלים המתגלגלים תחת שמיים כתומים דועכים. קו האופק השתרע ללא סוף, שם הים פגש את השמיים בקו עדין שנראה כמעט לא אמיתי. עברו שנים מאז שעמד במקום הזה בדיוק, ובכל זאת הכול הרגיש מוכר באופן מוזר, כאילו הזמן החליט להאט את קצבו רק בשבילו. הרוח המלוחה ליטפה את פניו, ונשאה עמה שברי זיכרונות, צחוק ילדות, קולות רחוקים ורגעים שחשב שכבר שכח מזמן.

דניאל לא תכנן את החזרה הזו. למעשה, במשך שנים הוא נמנע מכך בכוונה, ובחר במקום זאת ברעש ובהסחות של העיר הגדולה. אבל משהו השתנה לאחרונה. אולי זו הייתה עייפות, ואולי זו הייתה ההבנה השקטה שלא משנה כמה רחוק הוא נוסע, הוא לעולם לא יוכל לברוח מהעבר לגמרי. תמיד היה חלק ממנו קשור למקום הזה, כמו חוט בלתי נראה שמושך אותו בחזרה, בעדינות אך בעקביות.

כשהלך לאורך המזח, קרשי העץ חרקו מתחת לרגליו, וכל צעד הדהד בשקט אל תוך דממת הערב. הוא הבחין במגדלור הישן עומד גבוה במרחק, אורו מסתובב לאט ובנאמנות מנחה ספינות בדיוק כפי שעשה במשך עשורים. המגדלור הזה ריתק אותו כילד. הוא נהג לדמיין אותו כשומר הים, המשגיח על כל מי שהעז לצאת רחוק מדי.

בסופו של דבר, דניאל הגיע לעיירה. הרחובות היו כמעט ריקים, מוארים רק בכמה פנסים חמים שהטילו צללים ארוכים על המדרכה. הייתה כאן שלווה שכבר שכח שקיימת, שקט שלא הרגיש ריק אלא דווקא מלא בסיפורים שלא נאמרו. כל פינה נראתה כאילו מחזיקה בזיכרון, כל בניין תזכורת לחיים שפעם הכיר.

כשהגיע לבית הקפה הקטן בפינת הרחוב הראשי, הוא עצר. השלט מעל הדלת היה מעט דהוי, אך עדיין ניתן לזיהוי. הוא זכר שבא לכאן עם הוריו, ישב ליד החלון, הסתכל על הגשם יורד ולגם שוקו חם. בלי לחשוב יותר מדי, הוא דחף את הדלת ונכנס פנימה.

החום של בית הקפה חיבק אותו מיד. ריח הקפה והמאפים מילא את האוויר, ומוזיקה שקטה נשמעה ברקע. מאחורי הדלפק עמדה אישה מבוגרת עם עיניים טובות וחיוך עדין. היא הביטה בדניאל לרגע, הטתה מעט את ראשה, כאילו ניסתה למצוא אותו בזיכרונותיה.

"לא היית כאן הרבה זמן," היא אמרה בשקט.

דניאל היסס. "את מכירה אותי?" הוא שאל.

האישה חייכה שוב. "לא בדיוק. אבל ראיתי הרבה אנשים באים והולכים. יש לך את המראה של מישהו שחוזר."

המילים שלה נשארו באוויר, ודניאל הרגיש שמשהו זז בתוכו. הוא ישב ליד שולחן קטן ליד החלון, בדיוק כמו שנהג לפני שנים. הכיסא הרגיש מוכר, הנוף לא השתנה, ולראשונה מזה זמן רב הוא הרשה לעצמו פשוט לשבת ולהיות בלי למהר.

הם התחילו לדבר. בהתחלה על דברים קטנים, מזג האוויר, העיירה, השינויים שחלו לאורך השנים. אבל בהדרגה, השיחה העמיקה. האישה סיפרה על האנשים שעזבו, אלה שנשארו, והסיפורים שקושרים את כולם יחד. דניאל מצא את עצמו מקשיב יותר מדבר, סופג כל מילה כאילו היא נושאת חלק ממשהו שחסר לו.

הזמן חלף בלי שהבחין. בחוץ השמיים החשיכו לגמרי, והכוכבים החלו להופיע אחד אחד, כמו עדים שקטים ללילה שנפרש. בתוך בית הקפה, האור נותר חם ויציב, ויצר מקלט קטן מהעולם שמעבר לקירותיו.

בשלב מסוים, דניאל הבין שהמשקל שנשא, הלחץ המתמיד, חוסר הוודאות, החרדה השקטה שליוותה אותו לכל מקום, החלו להתמוסס. הם לא נעלמו לגמרי, אבל הרגישו קלים יותר, ניתנים יותר לניהול. כאילו להיות כאן, במקום הזה, משחזר לאט משהו בתוכו.

כשיצא שוב החוצה, האוויר הרגיש קריר יותר, אך גם צלול יותר. הוא חזר שוב למזח, נמשך פעם נוספת לקול הים. הגלים נעו בקצב, תנועתם יציבה וצפויה, בניגוד לכאוס שהתרגל אליו בחיי היומיום.

הוא נשען על המעקה והביט אל תוך החשיכה. המגדלור המשיך בעבודתו השקטה, קרן האור שלו סורקת את פני המים בעקביות בלתי מתפשרת. דניאל הבין אז שיש דברים שלא משתנים, לא כי הם לא מסוגלים, אלא כי הם לא צריכים.

הוא חשב על השנים שבילה ברדיפה אחרי הצלחה, נע קדימה ללא הפסקה בלי לעצור אף פעם לשאול את עצמו למה. הוא בנה חיים שנראו מרשימים מבחוץ, אבל איפשהו בדרך איבד את תחושת המשמעות שפעם הנחתה אותו.

עומד שם, מקשיב לגלים, הוא החל להבין משהו פשוט אך עמוק. התשובות שחיפש לא היו מוסתרות במקומות רחוקים או בהישגים עתידיים. הן היו כאן, ברגעים השקטים, במרחבים שבין ההחלטות, בזיכרונות שניסה כל כך קשה להשאיר מאחור.

תחושת שלווה שקעה עליו, עמוקה מכל מה שהרגיש בשנים. זו לא הייתה התרגשות, ולא הקלה. זה היה משהו יציב יותר, קבלה שקטה של מקומו, וסקרנות עדינה לגבי לאן ילך הלאה.

הלילה העמיק, והעיירה נותרה דוממת. דניאל נשאר שם זמן רב, מביט באופק, חושב, נזכר. ולראשונה מזה זמן רב, הוא לא ניסה לברוח משום דבר.

כשהגאות עלתה לאט וקול המים התחזק, דניאל נשם עמוק ועצם את עיניו. מחר יביא בחירות, כמו תמיד. יהיו החלטות לקבל, דרכים לשקול, ואי ודאויות לעמוד בפניהן.

אבל כרגע, שום דבר מזה לא חשוב.

ברגע הזה, מתחת לשמיים הפתוחים, עם הים שנמתח ללא סוף לפניו, דניאל הרגיש משהו שכמעט שכח שאפשרי.

הוא הרגיש שלווה.

ובהבנה השקטה הזו, הוא הבין שלפעמים, המסע הביתה אינו חזרה למקום, אלא גילוי מחדש של מי שאתה כשאתה סוף סוף מפסיק לברוח.`

test('Chatterbox Hebrew TTS with split: Long narrative', { timeout: 7200000 }, async (t) => {
  if (isMobile) {
    t.pass('Skipped on mobile')
    return
  }

  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox-multilingual')

  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, language: 'multilingual', variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox multilingual models should be downloaded')
  if (!downloadResult.success) return

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: path.join(modelDir, 'speech_encoder.onnx'),
    embedTokensPath: path.join(modelDir, 'embed_tokens.onnx'),
    conditionalDecoderPath: path.join(modelDir, 'conditional_decoder.onnx'),
    languageModelPath: path.join(modelDir, 'language_model.onnx'),
    language: 'he'
  }

  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Model should be loaded')

  const wavPath = path.join(baseDir, 'test', 'output', 'chatterbox-hebrew-split-long.wav')

  const expectation = {
    minSamples: 100000,
    maxSamples: 50000000,
    minDurationMs: 30000,
    maxDurationMs: 1800000
  }

  const startTime = Date.now()

  const result = await runChatterboxTTSWithSplit(
    model,
    { text: HEBREW_LONG_TEXT, saveWav: true, wavOutputPath: wavPath },
    expectation
  )

  const elapsedMs = Date.now() - startTime
  const elapsedSec = elapsedMs / 1000

  console.log(result.output)
  t.ok(result.passed, 'Split synthesis should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Should produce audio samples')

  const durationSec = result.data.durationMs / 1000
  const rtf = elapsedSec / durationSec

  console.log('\n============================================================')
  console.log('GENERATION SUMMARY (Hebrew)')
  console.log('============================================================')
  console.log(`  Text length:       ${HEBREW_LONG_TEXT.length} chars`)
  console.log(`  Total samples:     ${result.data.sampleCount}`)
  console.log(`  Audio duration:    ${durationSec.toFixed(1)}s`)
  console.log(`  Processing time:   ${elapsedSec.toFixed(1)}s`)
  console.log(`  Real-time factor:  ${rtf.toFixed(2)}x`)
  console.log('============================================================')

  await model.unload()
})
