/**
 * JavaScript port of the Moses Tokenizer from
 * https://github.com/moses-smt/mosesdecoder/blob/master/scripts/tokenizer/tokenizer.perl
 */

const { Perluniprops, NonbreakingPrefixes } = require('./pernuliprops')
const { VIRAMAS, NUKTAS } = require('./indic')
const { isCJK } = require('./cjk')

/**
 * MosesTokenizer class for tokenizing text in various languages
 */
/**
 * JavaScript port of the Moses Tokenizer from
 * https://github.com/moses-smt/mosesdecoder/blob/master/scripts/tokenizer/tokenizer.perl
 */

class MosesTokenizer {
  /**
   * Initialize a new Moses Tokenizer
   * @param {string} lang - Language code (default: "en")
   * @param {string|null} customNonbreakingPrefixesFile - Path to custom prefixes file
   */
  constructor (lang = 'en', customNonbreakingPrefixesFile = null) {
    this.lang = lang

    // Initialize Perluniprops and NonbreakingPrefixes
    this.perluniprops = new Perluniprops()
    this.nonbreaking_prefixes = new NonbreakingPrefixes()

    // Perl Unicode Properties character sets.
    // Note: In JavaScript we'll convert the generator to arrays/strings for regex use
    this.IsN = this._joinFromGenerator(this.perluniprops.chars('IsN'))

    // Build IsAlnum with VIRAMAS and NUKTAS
    const alnumChars = this._joinFromGenerator(
      this.perluniprops.chars('IsAlnum')
    )
    this.IsAlnum = alnumChars + VIRAMAS + NUKTAS

    this.IsSc = this._joinFromGenerator(this.perluniprops.chars('IsSc'))
    this.IsSo = this._joinFromGenerator(this.perluniprops.chars('IsSo'))

    // Build IsAlpha with VIRAMAS and NUKTAS
    const alphaChars = this._joinFromGenerator(
      this.perluniprops.chars('IsAlpha')
    )
    this.IsAlpha = alphaChars + VIRAMAS + NUKTAS

    this.IsLower = this._joinFromGenerator(this.perluniprops.chars('IsLower'))

    // Remove ASCII junk.
    this.DEDUPLICATE_SPACE = [/\s+/g, ' ']
    // eslint-disable-next-line no-control-regex
    this.ASCII_JUNK = [/[\u0000-\u001F]/g, '']

    // Pad all "other" special characters not in IsAlnum.
    this.PAD_NOT_ISALNUM = [
      new RegExp(
        `([^${this._escapeRegExp(this.IsAlnum)}\\s\\.'\`\\,\\-])`,
        'g'
      ),
      ' $1 '
    ]

    // Splits all hyphens (regardless of circumstances), e.g. 'foo-bar' -> 'foo @-@ bar'
    this.AGGRESSIVE_HYPHEN_SPLIT = [
      new RegExp(
        `([${this._escapeRegExp(this.IsAlnum)}])\\-(?=[${this._escapeRegExp(
          this.IsAlnum
        )}])`,
        'g'
      ),
      '$1 @-@ '
    ]

    // Make multi-dots stay together.
    this.REPLACE_DOT_WITH_LITERALSTRING_1 = [/.([.]+)/g, ' DOTMULTI$1']
    this.REPLACE_DOT_WITH_LITERALSTRING_2 = [
      /DOTMULTI\.([^.])/,
      'DOTDOTMULTI $1'
    ]
    this.REPLACE_DOT_WITH_LITERALSTRING_3 = [/DOTMULTI\./g, 'DOTDOTMULTI']

    // Separate out "," except if within numbers (5,300)
    this.COMMA_SEPARATE_1 = [
      new RegExp(`([^${this._escapeRegExp(this.IsN)}])[,]`, 'g'),
      '$1 , '
    ]
    this.COMMA_SEPARATE_2 = [
      new RegExp(`[,]([^${this._escapeRegExp(this.IsN)}])`, 'g'),
      ' , $1'
    ]
    this.COMMA_SEPARATE_3 = [
      new RegExp(`([${this._escapeRegExp(this.IsN)}])[,]$`, 'g'),
      '$1 , '
    ]

    // Attempt to get correct directional quotes.
    this.DIRECTIONAL_QUOTE_1 = [/^``/g, '`` ']
    this.DIRECTIONAL_QUOTE_2 = [/^"/g, '`` ']
    this.DIRECTIONAL_QUOTE_3 = [/^`([^`])/g, '` $1']
    this.DIRECTIONAL_QUOTE_4 = [/^'/g, '` ']
    this.DIRECTIONAL_QUOTE_5 = [/([ ([{<])"/g, '$1 `` ']
    this.DIRECTIONAL_QUOTE_6 = [/([ ([{<])``/g, '$1 `` ']
    this.DIRECTIONAL_QUOTE_7 = [/([ ([{<])`([^`])/g, '$1 ` $2']
    this.DIRECTIONAL_QUOTE_8 = [/([ ([{<])'/g, '$1 ` ']

    // Replace ... with _ELLIPSIS_ and later restore
    this.REPLACE_ELLIPSIS = [/\.\.\./g, ' _ELLIPSIS_ ']
    this.RESTORE_ELLIPSIS = [/_ELLIPSIS_/g, '...']

    // Pad , with tailing space except if within numbers, e.g. 5,300
    this.COMMA_1 = [
      new RegExp(
        `([^${this._escapeRegExp(this.IsN)}])[,]([^${this._escapeRegExp(
          this.IsN
        )}])`,
        'g'
      ),
      '$1 , $2'
    ]
    this.COMMA_2 = [
      new RegExp(
        `([${this._escapeRegExp(this.IsN)}])[,]([^${this._escapeRegExp(
          this.IsN
        )}])`,
        'g'
      ),
      '$1 , $2'
    ]
    this.COMMA_3 = [
      new RegExp(
        `([^${this._escapeRegExp(this.IsN)}])[,]([${this._escapeRegExp(
          this.IsN
        )}])`,
        'g'
      ),
      '$1 , $2'
    ]

    // Pad unicode symbols with spaces.
    this.SYMBOLS = [
      new RegExp(
        `([;:@#\\$%&${this._escapeRegExp(this.IsSc)}${this._escapeRegExp(
          this.IsSo
        )}])`,
        'g'
      ),
      ' $1 '
    ]

    // Separate out intra-token slashes.
    this.INTRATOKEN_SLASHES = [
      new RegExp(
        `([${this._escapeRegExp(this.IsAlnum)}])\\/([${this._escapeRegExp(
          this.IsAlnum
        )}])`,
        'g'
      ),
      '$1 @/@ $2'
    ]

    // Splits final period at end of string.
    this.FINAL_PERIOD = [/([^.])([.])([\\]\)}>"']*) ?$/g, '$1 $2$3']

    // Pad all question marks and exclamation marks with spaces.
    this.PAD_QUESTION_EXCLAMATION_MARK = [/([?!])/g, ' $1 ']

    // Handles parentheses, brackets and converts them to PTB symbols.
    this.PAD_PARENTHESIS = [/([\][(){}<>])/g, ' $1 ']
    this.CONVERT_PARENTHESIS_1 = [/\(/g, '-LRB-']
    this.CONVERT_PARENTHESIS_2 = [/\)/g, '-RRB-']
    this.CONVERT_PARENTHESIS_3 = [/\[/g, '-LSB-']
    this.CONVERT_PARENTHESIS_4 = [/\]/g, '-RSB-']
    this.CONVERT_PARENTHESIS_5 = [/\{/g, '-LCB-']
    this.CONVERT_PARENTHESIS_6 = [/\}/g, '-RCB-']

    // Pads double dashes with spaces.
    this.PAD_DOUBLE_DASHES = [/--/g, ' -- ']

    // Adds spaces to start and end of string to simplify further regexps.
    this.PAD_START_OF_STR = [/^/g, ' ']
    this.PAD_END_OF_STR = [/$/g, ' ']

    // Converts double quotes to two single quotes and pad with spaces.
    this.CONVERT_DOUBLE_TO_SINGLE_QUOTES = [/"/g, " '' "]

    // Handles single quote in possessives or close-single-quote.
    this.HANDLES_SINGLE_QUOTES = [/([^'])' /g, "$1 ' "]

    // Pad apostrophe in possessive or close-single-quote.
    this.APOSTROPHE = [/([^'])'/, "$1 ' "]

    // Prepend space on contraction apostrophe.
    this.CONTRACTION_1 = [/'([sSmMdD]) /g, " '$1 "]
    this.CONTRACTION_2 = [/'ll /g, " 'll "]
    this.CONTRACTION_3 = [/'re /g, " 're "]
    this.CONTRACTION_4 = [/'ve /g, " 've "]
    this.CONTRACTION_5 = [/n't /g, " n't "]
    this.CONTRACTION_6 = [/'LL /g, " 'LL "]
    this.CONTRACTION_7 = [/'RE /g, " 'RE "]
    this.CONTRACTION_8 = [/'VE /g, " 'VE "]
    this.CONTRACTION_9 = [/N'T /g, " N'T "]

    // Informal Contractions.
    this.CONTRACTION_10 = [/ ([Cc])annot /g, ' $1an not ']
    this.CONTRACTION_11 = [/ ([Dd])'ye /g, " $1' ye "]
    this.CONTRACTION_12 = [/ ([Gg])imme /g, ' $1im me ']
    this.CONTRACTION_13 = [/ ([Gg])onna /g, ' $1on na ']
    this.CONTRACTION_14 = [/ ([Gg])otta /g, ' $1ot ta ']
    this.CONTRACTION_15 = [/ ([Ll])emme /g, ' $1em me ']
    this.CONTRACTION_16 = [/ ([Mm])ore'n /g, " $1ore 'n "]
    this.CONTRACTION_17 = [/ '([Tt])is /g, " '$1 is "]
    this.CONTRACTION_18 = [/ '([Tt])was /g, " '$1 was "]
    this.CONTRACTION_19 = [/ ([Ww])anna /g, ' $1an na ']

    // Clean out extra spaces
    this.CLEAN_EXTRA_SPACE_1 = [/  */g, ' ']
    this.CLEAN_EXTRA_SPACE_2 = [/^ */g, '']
    this.CLEAN_EXTRA_SPACE_3 = [/ *$/g, '']

    // Neurotic Perl regexes to escape special characters.
    this.ESCAPE_AMPERSAND = [/&/g, '&amp;']
    this.ESCAPE_PIPE = [/\|/g, '&#124;']
    this.ESCAPE_LEFT_ANGLE_BRACKET = [/</g, '&lt;']
    this.ESCAPE_RIGHT_ANGLE_BRACKET = [/>/g, '&gt;']
    this.ESCAPE_SINGLE_QUOTE = [/'/g, '&apos;']
    this.ESCAPE_DOUBLE_QUOTE = [/"/g, '&quot;']
    this.ESCAPE_LEFT_SQUARE_BRACKET = [/\[/g, '&#91;']
    this.ESCAPE_RIGHT_SQUARE_BRACKET = [/\]/g, '&#93;']

    // English-specific patterns for handling contractions and possessives
    this.EN_SPECIFIC_1 = [
      new RegExp(
        `([^${this._escapeRegExp(this.IsAlpha)}])[']([^${this._escapeRegExp(
          this.IsAlpha
        )}])`,
        'g'
      ),
      "$1 ' $2"
    ]
    this.EN_SPECIFIC_2 = [
      new RegExp(
        `([^${this._escapeRegExp(this.IsAlpha)}${this._escapeRegExp(
          this.IsN
        )}])[']([${this._escapeRegExp(this.IsAlpha)}])`,
        'g'
      ),
      "$1 ' $2"
    ]
    this.EN_SPECIFIC_3 = [
      new RegExp(
        `([${this._escapeRegExp(this.IsAlpha)}])[']([^${this._escapeRegExp(
          this.IsAlpha
        )}])`,
        'g'
      ),
      "$1 ' $2"
    ]
    this.EN_SPECIFIC_4 = [
      new RegExp(
        `([${this._escapeRegExp(this.IsAlpha)}])[']([${this._escapeRegExp(
          this.IsAlpha
        )}])`,
        'g'
      ),
      "$1 '$2"
    ]
    this.EN_SPECIFIC_5 = [
      new RegExp(`([${this._escapeRegExp(this.IsN)}])[']([s])`, 'g'),
      "$1 '$2"
    ]

    this.ENGLISH_SPECIFIC_APOSTROPHE = [
      this.EN_SPECIFIC_1,
      this.EN_SPECIFIC_2,
      this.EN_SPECIFIC_3,
      this.EN_SPECIFIC_4,
      this.EN_SPECIFIC_5
    ]

    // French/Italian specific patterns
    this.FR_IT_SPECIFIC_1 = [
      new RegExp(
        `([^${this._escapeRegExp(this.IsAlpha)}])[']([^${this._escapeRegExp(
          this.IsAlpha
        )}])`,
        'g'
      ),
      "$1 ' $2"
    ]
    this.FR_IT_SPECIFIC_2 = [
      new RegExp(
        `([^${this._escapeRegExp(this.IsAlpha)}])[']([${this._escapeRegExp(
          this.IsAlpha
        )}])`,
        'g'
      ),
      "$1 ' $2"
    ]
    this.FR_IT_SPECIFIC_3 = [
      new RegExp(
        `([${this._escapeRegExp(this.IsAlpha)}])[']([^${this._escapeRegExp(
          this.IsAlpha
        )}])`,
        'g'
      ),
      "$1 ' $2"
    ]
    this.FR_IT_SPECIFIC_4 = [
      new RegExp(
        `([${this._escapeRegExp(this.IsAlpha)}])[']([${this._escapeRegExp(
          this.IsAlpha
        )}])`,
        'g'
      ),
      "$1' $2"
    ]

    this.FR_IT_SPECIFIC_APOSTROPHE = [
      this.FR_IT_SPECIFIC_1,
      this.FR_IT_SPECIFIC_2,
      this.FR_IT_SPECIFIC_3,
      this.FR_IT_SPECIFIC_4
    ]

    this.NON_SPECIFIC_APOSTROPHE = [/'/g, " ' "]

    this.TRAILING_DOT_APOSTROPHE = [/\.' ?$/g, " . ' "]

    // Protected patterns
    this.BASIC_PROTECTED_PATTERN_1 = /<\/?\S+\/?>/
    this.BASIC_PROTECTED_PATTERN_2 = /<\S+( [a-zA-Z0-9]+="?[^"]*")+ ?\/?>/
    this.BASIC_PROTECTED_PATTERN_3 = /<\S+( [a-zA-Z0-9]+='?[^']*')+ ?\/?>/
    this.BASIC_PROTECTED_PATTERN_4 = /[\w\-_.]+@([\w\-_]+\.)+[a-zA-Z]{2,}/
    this.BASIC_PROTECTED_PATTERN_5 =
      /(https?|ftp):\/\/[^:/\s]+(\/\w+)*\/[\w\-.]+/

    // Collected into an array for easy use
    this.BASIC_PROTECTED_PATTERNS = [
      this.BASIC_PROTECTED_PATTERN_1,
      this.BASIC_PROTECTED_PATTERN_2,
      this.BASIC_PROTECTED_PATTERN_3,
      this.BASIC_PROTECTED_PATTERN_4,
      this.BASIC_PROTECTED_PATTERN_5
    ]

    this.WEB_PROTECTED_PATTERNS = [
      /((https?|ftp|rsync):\/\/|www\.)[^ ]*/, // URLs
      /[\w\-_.]+@([\w\-_]+\.)+[a-zA-Z]{2,}/, // Emails
      /@[a-zA-Z0-9_]+/, // @handler such as twitter/github ID
      /#[a-zA-Z0-9_]+/ // @hashtag
    ]

    // Groups of regexes for different stages of tokenization
    this.MOSES_PENN_REGEXES_1 = [
      this.DEDUPLICATE_SPACE,
      this.ASCII_JUNK,
      this.DIRECTIONAL_QUOTE_1,
      this.DIRECTIONAL_QUOTE_2,
      this.DIRECTIONAL_QUOTE_3,
      this.DIRECTIONAL_QUOTE_4,
      this.DIRECTIONAL_QUOTE_5,
      this.DIRECTIONAL_QUOTE_6,
      this.DIRECTIONAL_QUOTE_7,
      this.DIRECTIONAL_QUOTE_8,
      this.REPLACE_ELLIPSIS,
      this.COMMA_1,
      this.COMMA_2,
      this.COMMA_3,
      this.SYMBOLS,
      this.INTRATOKEN_SLASHES,
      this.FINAL_PERIOD,
      this.PAD_QUESTION_EXCLAMATION_MARK,
      this.PAD_PARENTHESIS,
      this.CONVERT_PARENTHESIS_1,
      this.CONVERT_PARENTHESIS_2,
      this.CONVERT_PARENTHESIS_3,
      this.CONVERT_PARENTHESIS_4,
      this.CONVERT_PARENTHESIS_5,
      this.CONVERT_PARENTHESIS_6,
      this.PAD_DOUBLE_DASHES,
      this.PAD_START_OF_STR,
      this.PAD_END_OF_STR,
      this.CONVERT_DOUBLE_TO_SINGLE_QUOTES,
      this.HANDLES_SINGLE_QUOTES,
      this.APOSTROPHE,
      this.CONTRACTION_1,
      this.CONTRACTION_2,
      this.CONTRACTION_3,
      this.CONTRACTION_4,
      this.CONTRACTION_5,
      this.CONTRACTION_6,
      this.CONTRACTION_7,
      this.CONTRACTION_8,
      this.CONTRACTION_9,
      this.CONTRACTION_10,
      this.CONTRACTION_11,
      this.CONTRACTION_12,
      this.CONTRACTION_13,
      this.CONTRACTION_14,
      this.CONTRACTION_15,
      this.CONTRACTION_16,
      this.CONTRACTION_17,
      this.CONTRACTION_18,
      this.CONTRACTION_19
    ]

    this.MOSES_PENN_REGEXES_2 = [
      this.RESTORE_ELLIPSIS,
      this.CLEAN_EXTRA_SPACE_1,
      this.CLEAN_EXTRA_SPACE_2,
      this.CLEAN_EXTRA_SPACE_3,
      this.ESCAPE_AMPERSAND,
      this.ESCAPE_PIPE,
      this.ESCAPE_LEFT_ANGLE_BRACKET,
      this.ESCAPE_RIGHT_ANGLE_BRACKET,
      this.ESCAPE_SINGLE_QUOTE,
      this.ESCAPE_DOUBLE_QUOTE
    ]

    this.MOSES_ESCAPE_XML_REGEXES = [
      this.ESCAPE_AMPERSAND,
      this.ESCAPE_PIPE,
      this.ESCAPE_LEFT_ANGLE_BRACKET,
      this.ESCAPE_RIGHT_ANGLE_BRACKET,
      this.ESCAPE_SINGLE_QUOTE,
      this.ESCAPE_DOUBLE_QUOTE,
      this.ESCAPE_LEFT_SQUARE_BRACKET,
      this.ESCAPE_RIGHT_SQUARE_BRACKET
    ]

    // Initialize the language specific nonbreaking prefixes.
    this.NONBREAKING_PREFIXES = this.nonbreaking_prefixes
      .getWordsAsArray(lang)
      .map((nbp) => nbp.trim())

    // Load custom nonbreaking prefixes file.
    if (customNonbreakingPrefixesFile) {
      // In a real implementation, this would load from a file
      this.NONBREAKING_PREFIXES = []
      // Code to read from file would go here
    }

    this.NUMERIC_ONLY_PREFIXES = this.NONBREAKING_PREFIXES.filter((w) =>
      this.hasNumericOnly(w)
    ).map((w) => w.split(' ')[0])

    // Add CJK characters to alpha and alnum
    if (['zh', 'ja', 'ko', 'cjk'].includes(this.lang)) {
      let cjkChars = ''
      if (['ko', 'cjk'].includes(this.lang)) {
        cjkChars += this._joinFromGenerator(this.perluniprops.chars('Hangul'))
      }
      if (['zh', 'cjk'].includes(this.lang)) {
        cjkChars += this._joinFromGenerator(this.perluniprops.chars('Han'))
      }
      if (['ja', 'cjk'].includes(this.lang)) {
        cjkChars += this._joinFromGenerator(
          this.perluniprops.chars('Hiragana')
        )
        cjkChars += this._joinFromGenerator(
          this.perluniprops.chars('Katakana')
        )
        cjkChars += this._joinFromGenerator(this.perluniprops.chars('Han'))
      }
      this.IsAlpha += cjkChars
      this.IsAlnum += cjkChars

      // Overwrite the alnum regexes
      this.PAD_NOT_ISALNUM = [
        new RegExp(
          `([^${this._escapeRegExp(this.IsAlnum)}\\s\\.'\`\\,\\-])`,
          'g'
        ),
        ' $1 '
      ]
      this.AGGRESSIVE_HYPHEN_SPLIT = [
        new RegExp(
          `([${this._escapeRegExp(this.IsAlnum)}])\\-(?=[${this._escapeRegExp(
            this.IsAlnum
          )}])`,
          'g'
        ),
        '$1 @-@ '
      ]
      this.INTRATOKEN_SLASHES = [
        new RegExp(
          `([${this._escapeRegExp(this.IsAlnum)}])\\/([${this._escapeRegExp(
            this.IsAlnum
          )}])`,
          'g'
        ),
        '$1 @/@ $2'
      ]
    }
  }

  /**
   * Helper method to escape special characters in a string for regex
   * @param {string} str - String to escape
   * @returns {string} - Escaped string
   * @private
   */
  _escapeRegExp (str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * Helper method to convert a generator to a string
   * @param {Generator} generator - Generator to convert
   * @returns {string} - Resulting string
   * @private
   */
  _joinFromGenerator (generator) {
    let result = ''
    for (const char of generator) {
      result += char
    }
    return result
  }

  /**
   * Replaces multi-dots with placeholder text
   * @param {string} text - Input text
   * @returns {string} - Processed text
   */
  replaceMultidots (text) {
    text = text.replace(/\.([.]+)/g, ' DOTMULTI$1')
    const dotmulti = /DOTMULTI\./
    while (dotmulti.test(text)) {
      text = text.replace(/DOTMULTI\.([^.])/g, 'DOTDOTMULTI $1')
      text = text.replace(dotmulti, 'DOTDOTMULTI')
    }
    return text
  }

  /**
   * Restores multi-dots from placeholder text
   * @param {string} text - Input text
   * @returns {string} - Processed text
   */
  restoreMultidots (text) {
    const dotmulti = /DOTDOTMULTI/
    while (dotmulti.test(text)) {
      text = text.replace(dotmulti, 'DOTMULTI.')
    }
    return text.replace(/DOTMULTI/g, '.')
  }

  /**
   * Check if text contains only lowercase characters
   * @param {string} text - Input text
   * @returns {boolean} - True if all characters are lowercase
   */
  islower (text) {
    for (let i = 0; i < text.length; i++) {
      if (!this.IsLower.includes(text[i])) {
        return false
      }
    }
    return true
  }

  /**
   * Check if text contains any alphabetic characters
   * @param {string} text - Input text
   * @returns {boolean} - True if any character is alphabetic
   */
  isanyalpha (text) {
    for (let i = 0; i < text.length; i++) {
      if (this.IsAlpha.includes(text[i])) {
        return true
      }
    }
    return false
  }

  /**
   * Check if text contains numeric-only marker
   * @param {string} text - Input text
   * @returns {boolean} - True if text has a numeric-only marker
   */
  hasNumericOnly (text) {
    return /[\s]+(#NUMERIC_ONLY#)/.test(text)
  }

  /**
   * Handle nonbreaking prefixes in text
   * @param {string} text - Input text
   * @returns {string} - Processed text
   */
  handlesNonbreakingPrefixes (text) {
    // Splits the text into tokens to check for nonbreaking prefixes
    const tokens = text.split(/\s+/)
    const numTokens = tokens.length

    for (let i = 0; i < numTokens; i++) {
      const token = tokens[i]
      // Checks if token ends with a fullstop
      const tokenEndsWithPeriod = /^(\S+)\.$/.exec(token)

      if (tokenEndsWithPeriod) {
        const prefix = tokenEndsWithPeriod[1]
        // Check conditions for nonbreaking prefixes
        if (
          (prefix.includes('.') && this.isanyalpha(prefix)) ||
          (this.NONBREAKING_PREFIXES.includes(prefix) &&
            !this.NUMERIC_ONLY_PREFIXES.includes(prefix)) ||
          (i !== numTokens - 1 &&
            tokens[i + 1] &&
            this.islower(tokens[i + 1][0]))
        ) {
          // No change to the token
        } else if (
          // Check if prefix is in NUMERIC_ONLY_PREFIXES and next token is a digit
          this.NUMERIC_ONLY_PREFIXES.includes(prefix) &&
          i + 1 < numTokens &&
          /^[0-9]+/.test(tokens[i + 1])
        ) {
          // No change to the token
        } else {
          // Adds a space after the tokens before a dot
          tokens[i] = prefix + ' .'
        }
      }
    }

    return tokens.join(' ') // Stitch the tokens back
  }

  /**
   * Escape XML special characters in text
   * @param {string} text - Input text
   * @returns {string} - Processed text
   */
  escapeXml (text) {
    for (const [regexp, substitution] of this.MOSES_ESCAPE_XML_REGEXES) {
      text = text.replace(regexp, substitution)
    }
    return text
  }

  /**
   * Penn Treebank tokenization
   * @param {string} text - Input text
   * @param {boolean} returnStr - Whether to return a string or array
   * @returns {string|Array} - Tokenized text
   */
  pennTokenize (text, returnStr = false) {
    // Converts input string into unicode
    text = String(text)

    // Perform a chain of regex substitutions using MOSES_PENN_REGEXES_1
    for (const [regexp, substitution] of this.MOSES_PENN_REGEXES_1) {
      text = text.replace(regexp, substitution)
    }

    // Handles nonbreaking prefixes
    text = this.handlesNonbreakingPrefixes(text)

    // Restore ellipsis, clean extra spaces, escape XML symbols
    for (const [regexp, substitution] of this.MOSES_PENN_REGEXES_2) {
      text = text.replace(regexp, substitution)
    }

    return returnStr ? text : text.split(/\s+/).filter((t) => t.length > 0)
  }

  /**
   * Main tokenization method
   * @param {string} text - Input text
   * @param {boolean} aggressiveDashSplits - Whether to aggressively split dashes
   * @param {boolean} returnStr - Whether to return a string or array
   * @param {boolean} escape - Whether to escape XML
   * @param {Array} protectedPatterns - Patterns to protect from tokenization
   * @returns {string|Array} - Tokenized text
   */
  tokenize (
    text,
    aggressiveDashSplits = false,
    returnStr = false,
    escape = true,
    protectedPatterns = null
  ) {
    // Converts input string into unicode
    text = String(text)

    // De-duplicate spaces and clean ASCII junk
    for (const [regexp, substitution] of [
      this.DEDUPLICATE_SPACE,
      this.ASCII_JUNK
    ]) {
      text = text.replace(regexp, substitution)
    }

    // Initialize protectedTokens array HERE (properly scoped)
    const protectedTokens = []

    // Process protected patterns
    if (protectedPatterns) {
      try {
        // Compile all patterns with global and case insensitivity flags
        const compiledPatterns = protectedPatterns.map((p) =>
          p instanceof RegExp
            ? new RegExp(
              p.source,
              p.flags.includes('g') ? p.flags : p.flags + 'g'
            )
            : new RegExp(p, 'gi')
        )

        // Find all matches across all patterns
        compiledPatterns.forEach((pattern) => {
          // Reset lastIndex to start from beginning
          pattern.lastIndex = 0

          // Find all matches for this pattern
          let match
          while ((match = pattern.exec(text)) !== null) {
            if (match[0].length > 0) {
              // Skip empty matches
              protectedTokens.push(match[0])
            }

            // Avoid infinite loops for zero-width matches
            if (match.index === pattern.lastIndex) {
              pattern.lastIndex++
            }
          }
        })

        // Ensure we don't exceed 1000 matches (3-digit limit)
        if (protectedTokens.length > 1000) {
          console.warn(
            `More than 1000 protected tokens found (${protectedTokens.length}). Using only the first 1000.`
          )
          protectedTokens.length = 1000 // Truncate to 1000
        }

        // Sort by length (longest first) to prevent substring replacements
        const sortedTokenWithIndices = [...protectedTokens].map((token, i) => ({
          token,
          index: i
        }))
        sortedTokenWithIndices.sort((a, b) => b.token.length - a.token.length)

        // Apply replacements from longest to shortest
        for (const { token, index } of sortedTokenWithIndices) {
          const substitution =
            'THISISPROTECTED' + String(index).padStart(3, '0')

          // Use split and join to replace all occurrences
          text = text.split(token).join(substitution)
        }
      } catch (e) {
        console.error('Error processing protected patterns:', e)
        // Continue without protected pattern processing
      }
    }

    // Strips heading and trailing spaces
    text = text.trim()

    // Separate special characters outside of IsAlnum character set
    const [regexpNotAlnum, substitutionNotAlnum] = this.PAD_NOT_ISALNUM
    text = text.replace(regexpNotAlnum, substitutionNotAlnum)

    // Aggressively splits dashes
    if (aggressiveDashSplits) {
      const [regexpHyphen, substitutionHyphen] = this.AGGRESSIVE_HYPHEN_SPLIT
      text = text.replace(regexpHyphen, substitutionHyphen)
    }

    // Replaces multidots with "DOTDOTMULTI" literal strings
    text = this.replaceMultidots(text)

    // Separate out "," except if within numbers e.g. 5,300
    for (const [regexp, substitution] of [
      this.COMMA_SEPARATE_1,
      this.COMMA_SEPARATE_2,
      this.COMMA_SEPARATE_3
    ]) {
      text = text.replace(regexp, substitution)
    }

    // Language-specific apostrophe tokenization
    if (this.lang === 'en') {
      for (const [regexp, substitution] of this.ENGLISH_SPECIFIC_APOSTROPHE) {
        text = text.replace(regexp, substitution)
      }
    } else if (this.lang === 'fr' || this.lang === 'it') {
      for (const [regexp, substitution] of this.FR_IT_SPECIFIC_APOSTROPHE) {
        text = text.replace(regexp, substitution)
      }
    } else {
      const [regexp, substitution] = this.NON_SPECIFIC_APOSTROPHE
      text = text.replace(regexp, substitution)
    }

    // Handles nonbreaking prefixes
    text = this.handlesNonbreakingPrefixes(text)

    // Cleans up extraneous spaces
    const [regexpSpace, substitutionSpace] = this.DEDUPLICATE_SPACE
    text = text.replace(regexpSpace, substitutionSpace).trim()

    // Split trailing ".'".
    const [regexpDotApostrophe, substitutionDotApostrophe] =
      this.TRAILING_DOT_APOSTROPHE
    text = text.replace(regexpDotApostrophe, substitutionDotApostrophe)

    // Restore the protected tokens
    if (protectedPatterns && protectedTokens.length > 0) {
      // Process from 0 to length (the indices are embedded in the substitution strings)
      for (let i = 0; i < protectedTokens.length; i++) {
        const substitution = 'THISISPROTECTED' + String(i).padStart(3, '0')
        const token = protectedTokens[i]
        text = text.split(substitution).join(token)
      }
    }

    // Restore multidots
    text = this.restoreMultidots(text)

    if (escape) {
      // Escape XML symbols
      text = this.escapeXml(text)
    }

    return returnStr ? text : text.split(/\s+/).filter((t) => t.length > 0)
  }
}

/**
 * MosesDetokenizer class for detokenizing text in various languages
 */
class MosesDetokenizer {
  /**
   * Initialize a new Moses Detokenizer
   * @param {string} lang - Language code (default: "en")
   */
  constructor (lang = 'en') {
    this.lang = lang

    // Initialize Perluniprops - choose implementation based on environment
    this.perluniprops = new Perluniprops()

    // Character sets from Perluniprops - convert generators to strings for regex use
    this.IsAlnum = this._joinFromGenerator(this.perluniprops.chars('IsAlnum'))
    this.IsAlpha = this._joinFromGenerator(this.perluniprops.chars('IsAlpha'))
    this.IsSc = this._joinFromGenerator(this.perluniprops.chars('IsSc'))

    // Regex patterns with their replacements
    this.AGGRESSIVE_HYPHEN_SPLIT = [/ @-@ /g, '-']

    // Merge multiple spaces
    this.ONE_SPACE = [/ {2,}/g, ' ']

    // Unescape special characters
    this.UNESCAPE_FACTOR_SEPARATOR = [/&#124;/g, '|']
    this.UNESCAPE_LEFT_ANGLE_BRACKET = [/&lt;/g, '<']
    this.UNESCAPE_RIGHT_ANGLE_BRACKET = [/&gt;/g, '>']
    this.UNESCAPE_DOUBLE_QUOTE = [/&quot;/g, '"']
    this.UNESCAPE_SINGLE_QUOTE = [/&apos;/g, "'"]
    this.UNESCAPE_SYNTAX_NONTERMINAL_LEFT = [/&#91;/g, '[']
    this.UNESCAPE_SYNTAX_NONTERMINAL_RIGHT = [/&#93;/g, ']']
    this.UNESCAPE_AMPERSAND = [/&amp;/g, '&']

    // Legacy regexes for older Moses versions
    this.UNESCAPE_FACTOR_SEPARATOR_LEGACY = [/&bar;/g, '|']
    this.UNESCAPE_SYNTAX_NONTERMINAL_LEFT_LEGACY = [/&bra;/g, '[']
    this.UNESCAPE_SYNTAX_NONTERMINAL_RIGHT_LEGACY = [/&ket;/g, ']']

    // Group all XML unescape regexes
    this.MOSES_UNESCAPE_XML_REGEXES = [
      this.UNESCAPE_FACTOR_SEPARATOR_LEGACY,
      this.UNESCAPE_FACTOR_SEPARATOR,
      this.UNESCAPE_LEFT_ANGLE_BRACKET,
      this.UNESCAPE_RIGHT_ANGLE_BRACKET,
      this.UNESCAPE_SYNTAX_NONTERMINAL_LEFT_LEGACY,
      this.UNESCAPE_SYNTAX_NONTERMINAL_RIGHT_LEGACY,
      this.UNESCAPE_DOUBLE_QUOTE,
      this.UNESCAPE_SINGLE_QUOTE,
      this.UNESCAPE_SYNTAX_NONTERMINAL_LEFT,
      this.UNESCAPE_SYNTAX_NONTERMINAL_RIGHT,
      this.UNESCAPE_AMPERSAND
    ]

    // Finnish morphological rules
    this.FINNISH_MORPHSET_1 = [
      'N',
      'n',
      'A',
      'a',
      'Ä',
      'ä',
      'ssa',
      'Ssa',
      'ssä',
      'Ssä',
      'sta',
      'stä',
      'Sta',
      'Stä',
      'hun',
      'Hun',
      'hyn',
      'Hyn',
      'han',
      'Han',
      'hän',
      'Hän',
      'hön',
      'Hön',
      'un',
      'Un',
      'yn',
      'Yn',
      'an',
      'An',
      'än',
      'Än',
      'ön',
      'Ön',
      'seen',
      'Seen',
      'lla',
      'Lla',
      'llä',
      'Llä',
      'lta',
      'Lta',
      'ltä',
      'Ltä',
      'lle',
      'Lle',
      'ksi',
      'Ksi',
      'kse',
      'Kse',
      'tta',
      'Tta',
      'ine',
      'Ine'
    ]

    this.FINNISH_MORPHSET_2 = ['ni', 'si', 'mme', 'nne', 'nsa']

    this.FINNISH_MORPHSET_3 = [
      'ko',
      'kö',
      'han',
      'hän',
      'pa',
      'pä',
      'kaan',
      'kään',
      'kin'
    ]

    // Combine Finnish morphsets into a regex pattern
    this.FINNISH_REGEX = new RegExp(
      `^(${this.FINNISH_MORPHSET_1.join('|')})(${this.FINNISH_MORPHSET_2.join(
        '|'
      )})?(${this.FINNISH_MORPHSET_3.join('|')})$`
    )

    // Other regex patterns for text processing
    this.IS_CURRENCY_SYMBOL = new RegExp(
      `^[${this._escapeRegExp(this.IsSc)}\\(\\[\\{\\¿\\¡]+$`
    )
    this.IS_ENGLISH_CONTRACTION = new RegExp(
      `^['][${this._escapeRegExp(this.IsAlpha)}]`
    )
    this.IS_FRENCH_CONRTACTION = new RegExp(
      `[${this._escapeRegExp(this.IsAlpha)}][']$`
    )
    this.STARTS_WITH_ALPHA = new RegExp(
      `^[${this._escapeRegExp(this.IsAlpha)}]`
    )
    // eslint-disable-next-line no-useless-escape
    this.IS_PUNCT = /^[\,\.\?\!\:\;\\\%\}\]\)]+$/
    // eslint-disable-next-line no-useless-escape
    this.IS_OPEN_QUOTE = /^[\'\"\„\"\`]+$/
  }

  /**
   * Helper method to escape special characters in a string for regex
   * @param {string} str - String to escape
   * @returns {string} - Escaped string
   * @private
   */
  _escapeRegExp (str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * Helper method to convert a generator to a string
   * @param {Generator} generator - Generator to convert
   * @returns {string} - Resulting string
   * @private
   */
  _joinFromGenerator (generator) {
    let result = ''
    for (const char of generator) {
      result += char
    }
    return result
  }

  /**
   * Unescape XML-escaped characters in text
   * @param {string} text - Input text
   * @returns {string} - Processed text
   */
  unescapeXml (text) {
    for (const [regexp, substitution] of this.MOSES_UNESCAPE_XML_REGEXES) {
      text = text.replace(regexp, substitution)
    }
    return text
  }

  /**
   * Main detokenization method (named tokenize for compatibility with Python original)
   * @param {Array} tokens - Array of tokens to detokenize
   * @param {boolean} returnStr - Whether to return a string or array
   * @param {boolean} unescape - Whether to unescape XML
   * @returns {string|Array} - Detokenized text
   */
  tokenize (tokens, returnStr = true, unescape = true) {
    // Convert the list of tokens into a string and pad it with spaces
    let text = ` ${tokens.join(' ')} `

    // Detokenize the aggressive hyphen split
    const [regexpHyphen, substitutionHyphen] = this.AGGRESSIVE_HYPHEN_SPLIT
    text = text.replace(regexpHyphen, substitutionHyphen)

    if (unescape) {
      // Unescape the XML symbols
      text = this.unescapeXml(text)
    }

    // Keep track of quotation marks
    const quoteCounts = { "'": 0, '"': 0, '``': 0, '`': 0, "''": 0 }

    // The prependSpace variable controls the "effects" of detokenization
    // as we loop through the tokens
    let prependSpace = ' '
    let detokenizedText = ''

    // Split the text into tokens for processing
    const tokenArray = text.split(/\s+/).filter((t) => t.length > 0)

    // Iterate through every token and apply language specific detokenization rules
    for (let i = 0; i < tokenArray.length; i++) {
      const token = tokenArray[i]

      // Skip empty tokens
      if (!token) continue

      // Check if the first char is CJK
      if (token[0] && isCJK(token[0]) && this.lang !== 'ko') {
        // Perform left shift if this is a second consecutive CJK word
        if (
          i > 0 &&
          tokenArray[i - 1] &&
          tokenArray[i - 1].length > 0 &&
          isCJK(tokenArray[i - 1][tokenArray[i - 1].length - 1])
        ) {
          detokenizedText += token
        } else {
          // Nothing special if this is a CJK word that doesn't follow a CJK word
          detokenizedText += prependSpace + token
        }
        prependSpace = ' '
      } else if (this.IS_CURRENCY_SYMBOL.test(token)) {
        // If it's a currency symbol
        // Perform right shift on currency and other random punctuation items
        detokenizedText += prependSpace + token
        prependSpace = ''
      } else if (this.IS_PUNCT.test(token)) {
        // If it's a punctuation
        // In French, these punctuations are prefixed with a non-breakable space
        if (this.lang === 'fr' && /^[?!:;\\%]$/.test(token)) {
          detokenizedText += ' '
        }
        // Perform left shift on punctuation items
        detokenizedText += token
        prependSpace = ' '
      } else if (
        this.lang === 'en' &&
        i > 0 &&
        this.IS_ENGLISH_CONTRACTION.test(token)
      ) {
        // English contractions
        // For English, left-shift the contraction
        detokenizedText += token
        prependSpace = ' '
      } else if (
        this.lang === 'cs' &&
        i > 1 &&
        /^[0-9]+$/.test(tokenArray[i - 2]) && // Previous previous token is a number
        /^[.,]$/.test(tokenArray[i - 1]) && // Previous token is a dot/comma
        /^[0-9]+$/.test(token) // Current token is a number
      ) {
        // Czech decimal numbers
        // In Czech, left-shift floats that are decimal numbers
        detokenizedText += token
        prependSpace = ' '
      } else if (
        ['fr', 'it', 'ga'].includes(this.lang) &&
        i < tokenArray.length - 1 &&
        this.IS_FRENCH_CONRTACTION.test(token) &&
        this.STARTS_WITH_ALPHA.test(tokenArray[i + 1])
      ) {
        // French/Italian/Gaelic contractions
        // For French and Italian, right-shift the contraction
        detokenizedText += prependSpace + token
        prependSpace = ''
      } else if (
        this.lang === 'cs' &&
        i < tokenArray.length - 2 &&
        this.IS_FRENCH_CONRTACTION.test(token) &&
        /^[-–]$/.test(tokenArray[i + 1]) &&
        /^li$|^mail.*/i.test(tokenArray[i + 2])
      ) {
        // Czech e-mail and -li words
        // In Czech, right-shift "-li" and a few Czech dashed words (e.g. e-mail)
        detokenizedText += prependSpace + token + tokenArray[i + 1]
        i++ // Skip the dash token
        prependSpace = ''
      } else if (this.IS_OPEN_QUOTE.test(token)) {
        // Quote handling
        let normalizedQuo = token
        if (/^[„""]/.test(token)) {
          normalizedQuo = '"'
        }

        // Initialize quote count if not present
        quoteCounts[normalizedQuo] = quoteCounts[normalizedQuo] || 0

        // Special handling for Czech quotes
        if (this.lang === 'cs' && token === '„') {
          quoteCounts[normalizedQuo] = 0
        }
        if (this.lang === 'cs' && token === '"') {
          quoteCounts[normalizedQuo] = 1
        }
        // Even count of quotes (opening quote)
        if (quoteCounts[normalizedQuo] % 2 === 0) {
          // Special case for English possessives ending in 's
          if (
            this.lang === 'en' &&
            token === "'" &&
            i > 0 &&
            /[s]$/.test(tokenArray[i - 1])
          ) {
            // Left shift on single quote for possessives ending in "s"
            detokenizedText += token
            prependSpace = ' '
          } else {
            // Right shift for opening quotes
            detokenizedText += prependSpace + token
            prependSpace = ''
            quoteCounts[normalizedQuo]++
          }
        } else {
          // Left shift for closing quotes
          detokenizedText += token
          prependSpace = ' '
          quoteCounts[normalizedQuo]++
        }
      } else if (
        this.lang === 'fi' &&
        i > 0 &&
        /:$/.test(tokenArray[i - 1]) &&
        this.FINNISH_REGEX.test(token)
      ) {
        // Finnish case suffixes
        // Finnish : without intervening space if followed by case suffix
        detokenizedText += prependSpace + token
        prependSpace = ' '
      } else {
        // Default case - just add the token with appropriate spacing
        detokenizedText += prependSpace + token
        prependSpace = ' '
      }
    }

    // Merge multiple spaces
    const [regexpSpace, substitutionSpace] = this.ONE_SPACE
    detokenizedText = detokenizedText.replace(regexpSpace, substitutionSpace)

    // Remove heading and trailing spaces
    detokenizedText = detokenizedText.trim()

    return returnStr ? detokenizedText : detokenizedText.split(/\s+/)
  }

  /**
   * Alias for tokenize to match the original Python API
   * @param {Array} tokens - Array of tokens to detokenize
   * @param {boolean} returnStr - Whether to return a string or array
   * @param {boolean} unescape - Whether to unescape XML
   * @returns {string|Array} - Detokenized text
   */
  detokenize (tokens, returnStr = true, unescape = true) {
    return this.tokenize(tokens, returnStr, unescape)
  }
}

module.exports = {
  MosesTokenizer,
  MosesDetokenizer
}
