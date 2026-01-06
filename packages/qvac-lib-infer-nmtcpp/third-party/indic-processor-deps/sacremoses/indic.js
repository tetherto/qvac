// Virama marks (vowel killers) in various Indic scripts
const VIRAMAS = [
  '\u094D', // Devanagari ◌्
  '\u09CD', // Bengali ◌্
  '\u0A4D', // Gurmukhi ◌੍
  '\u0ACD', // Gujarati ◌્
  '\u0B4D', // Oriya ◌୍
  '\u0BCD', // Tamil ◌்
  '\u0C4D', // Telugu ◌్
  '\u0CCD', // Kannada ◌್
  '\u0D3B', // Malayalam Sign Vertical Bar ◌഻
  '\u0D3C', // Malayalam Sign Circular ◌഻
  '\u0D4D', // Malayalam ◌്
  '\u0EBA', // Lao Sign Pali ◌຺
  '\u1039', // Myanmar ◌္
  '\u1714', // Tagalog ◌᜔
  '\u1BAB', // Sundanese ◌᮫
  '\uA8C4', // Saurashtra ◌꣄
  '\uA8F3', // Devanagari Sign Candrabindu ꣳ
  '\uA8F4', // Devanagari Sign Double Candrabindu ꣴ
  '\uA953', // Rejang ꥓
  '\uAAF6', // Meetei Mayek ◌꫶
  '\u{10A3F}', // Kharoshthi ◌𐨿
  '\u{11046}', // Brahmi ◌𑁆
  '\u{110B9}', // Kaithi ◌𑂹
  '\u{11133}', // Chakma ◌𑄳
  '\u{111C0}', // Sharada 𑇀
  '\u{11235}', // Khojki 𑈵
  '\u{112EA}', // Khudawadi ◌𑋪
  '\u{1134D}', // Grantha 𑍍
  '\u{11442}', // Newa ◌𑑂
  '\u{114C2}', // Tirhuta ◌𑓂
  '\u{115BF}', // Siddham ◌𑖿
  '\u{1163F}', // Modi ◌𑘿
  '\u{116B6}', // Takri 𑚶
  '\u{11839}', // Dogra ◌𑠹
  '\u{119E0}', // Nandinagari ◌𑧠
  '\u{11A34}', // Zanabazar Square ◌𑨴
  '\u{11C3F}', // Bhaiksuki ◌𑰿
  '\u{11D45}', // Masaram Gondi ◌𑵅
  '\u{11D97}', // Gunjala Gondi ◌𑶗
  '\u0DCA' // Sinhala hal kirīma ්
]

// Nukta marks (diacritical dots) in various Indic scripts
// https://en.wikipedia.org/wiki/Nuqta
const NUKTAS = [
  '\u093C', // Devanagari  ◌़
  '\u09BC', // Bengali  ◌়
  '\u0A3C', // Gurmukhi  ◌਼
  '\u0ABC', // Gujarati  ◌઼
  '\u0AFD', // Gujarati Sign Three-Dot Above ◌૽
  '\u0AFE', // Gujarati Sign Circle Above ◌૾
  '\u0AFF', // Gujarati Sign Two-Circle Above ◌૿
  '\u0B3C', // Oriya  ◌଼
  '\u0CBC', // Kannada  ◌಼
  '\u1C37', // Lepcha  ◌᰷
  '\u{110BA}', // Kaithi  ◌𑂺
  '\u{11173}', // Mahajani  ◌𑅳
  '\u{111CA}', // Sharada  ◌𑇊
  '\u{11236}', // Khojki  ◌𑈶
  '\u{112E9}', // Khudawadi  ◌𑋩
  '\u{1133C}', // Grantha  ◌𑌼
  '\u{11446}', // Newa  ◌𑑆
  '\u{114C3}', // Tirhuta  ◌𑓃
  '\u{115C0}', // Siddham  ◌𑗀
  '\u{116B7}', // Takri  ◌𑚷
  '\u{1183A}', // Dogra  ◌𑠺
  '\u{11D42}', // Masaram Gondi  ◌𑵂
  '\u{1E94A}' // Adlam  ◌𞥊
]

module.exports = {
  VIRAMAS,
  NUKTAS
}
