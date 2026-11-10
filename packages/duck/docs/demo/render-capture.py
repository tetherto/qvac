"""Render captured terminal cells, preserving the product's SGR colours."""
import re, sys
from pathlib import Path
# The inherited terminal background in this captured preview.
DEFAULT_BG=(24,24,28)
from PIL import Image, ImageDraw, ImageFont
font=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc',18)
bold=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc',18,index=1)
cw=round(font.getlength('M'));ch=27
for name in sys.argv[1:]:
 text=Path(name).read_text();lines=text.splitlines();width=max(len(re.sub(r'\x1b\[[0-9;]*[mK]','',l)) for l in lines)
 img=Image.new('RGB',(width*cw+40,len(lines)*ch+32),DEFAULT_BG);d=ImageDraw.Draw(img)
 for y,line in enumerate(lines):
  fg=(212,223,230);bg=DEFAULT_BG;strong=False;reverse=False;x=0
  for token in re.findall(r'\x1b\[[0-9;]*[mK]|[^\x1b]+',line):
   if token.startswith('\x1b'):
    if token.endswith('K'):
     d.rectangle((20+x*cw,16+y*ch,20+(width+1)*cw-1,16+(y+1)*ch-1),fill=bg)
     continue
    params=[int(n or 0) for n in token[2:-1].split(';')];i=0
    while i<len(params):
     n=params[i]
     if n==0:fg=(212,223,230);bg=DEFAULT_BG;strong=False;reverse=False
     elif n==1:strong=True
     elif n==7:reverse=True
     elif n==27:reverse=False
     elif n in [38,48] and i+4<len(params) and params[i+1]==2:
      color=tuple(params[i+2:i+5]);fg,bg=(color,bg) if n==38 else (fg,color);i+=4
     elif n==49:bg=DEFAULT_BG
     elif n==39:fg=(212,223,230)
     elif n==30:fg=(0,0,0)
     elif n==47:bg=(255,255,255)
     i+=1
   else:
    for c in token:
     a,b=(bg,fg) if reverse else (fg,bg)
     px,py=20+x*cw,16+y*ch;d.rectangle((px,py,px+cw-1,py+ch-1),fill=b)
     # Exact half-block coverage keeps QR modules square and scannable.
     if c in '█▀▄':
      top=py if c!='▄' else py+ch//2;bottom=py+ch-1 if c!='▀' else py+ch//2-1;d.rectangle((px,top,px+cw-1,bottom),fill=a)
     else:d.text((px,py+2),c,font=bold if strong else font,fill=a)
     x+=1
 target=Path(name).with_suffix('.png');img.save(target);print(target)
