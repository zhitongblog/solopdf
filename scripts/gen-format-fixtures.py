#!/usr/bin/env python3
"""
Reproducible fixtures for the FB2 and TIFF readers.

    python3 scripts/gen-format-fixtures.py            # writes into test-fixtures/

Needs Pillow (any 10.1+; uses the built-in scalable font, no system fonts)
and libtiff's `tiffcp` for stitching pages with *different* compression into
one file (Pillow can only write one compression per multi-page save):
    macOS: brew install libtiff    Debian: apt install libtiff-tools

Outputs:
  fb2-cyrillic-1251.fb2   FictionBook 2 in windows-1251 (the classic Russian
                          e-book encoding): nested sections → TOC, a cover and
                          an inline image as base64 <binary>, epigraph, poem,
                          footnotes body, emphasis/strong.
  fb2-chinese.fbz         a zipped UTF-8 FB2 (Chinese text) — .fbz is just a
                          zip holding one .fb2.
  tiff-mixed-3p.tiff      3 pages, 3 compressions: CCITT G4 bilevel fax page,
                          LZW RGB page, Deflate grayscale landscape page.
"""
import base64
import io
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'test-fixtures'))


def font(size):
    return ImageFont.load_default(size=size)


def png_bytes(img, fmt='PNG', **kw):
    buf = io.BytesIO()
    img.save(buf, fmt, **kw)
    return buf.getvalue()


# ── images used inside the FB2 books ─────────────────────────────────────

def cover_image(title_latin, accent):
    img = Image.new('RGB', (360, 520), (245, 240, 228))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 359, 140], fill=accent)
    d.rectangle([24, 170, 336, 172], fill=(60, 60, 60))
    d.text((24, 40), title_latin, fill=(255, 255, 255), font=font(34))
    d.text((24, 190), 'FB2 fixture', fill=(40, 40, 40), font=font(26))
    for i in range(6):
        d.ellipse([60 + i * 40, 300 + (i % 2) * 40, 100 + i * 40, 340 + (i % 2) * 40], outline=accent, width=4)
    return png_bytes(img, 'JPEG', quality=80)


def figure_image():
    img = Image.new('RGB', (420, 220), (255, 255, 255))
    d = ImageDraw.Draw(img)
    bars = [60, 120, 90, 170, 140]
    for i, h in enumerate(bars):
        d.rectangle([30 + i * 75, 200 - h, 80 + i * 75, 200], fill=(40 + i * 40, 90, 200 - i * 30))
    d.line([20, 200, 410, 200], fill=(0, 0, 0), width=2)
    d.text((30, 8), 'Figure 1: bar chart', fill=(0, 0, 0), font=font(18))
    return png_bytes(img)


def b64(data):
    s = base64.b64encode(data).decode('ascii')
    return '\n'.join(s[i:i + 76] for i in range(0, len(s), 76))


# ── FB2 #1: Russian, windows-1251 ────────────────────────────────────────

FB2_RU = '''<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
  <title-info>
    <genre>prose_classic</genre>
    <author><first-name>Александр</first-name><middle-name>Сергеевич</middle-name><last-name>Пушкин</last-name></author>
    <book-title>Пробная книга: стихи и проза</book-title>
    <annotation><p>Тестовый образец формата FB2 в кодировке windows-1251 для SoloPDF.</p></annotation>
    <coverpage><image l:href="#cover.jpg"/></coverpage>
    <lang>ru</lang>
  </title-info>
  <document-info>
    <author><nickname>solopdf</nickname></author>
    <program-used>scripts/gen-format-fixtures.py</program-used>
    <date value="2026-10-07">7 октября 2026</date>
    <id>solopdf-fixture-fb2-ru</id>
    <version>1.0</version>
  </document-info>
</description>
<body>
  <title><p>Пробная книга</p><p>стихи и проза</p></title>
  <epigraph>
    <p>Привычка свыше нам дана: Замена счастию она.</p>
    <text-author>А. С. Пушкин</text-author>
  </epigraph>
  <section>
    <title><p>Часть первая. Стихи</p></title>
    <section>
      <title><p>Глава 1. К ***</p></title>
      <poem>
        <stanza>
          <v>Я помню чудное мгновенье:</v>
          <v>Передо мной явилась ты,</v>
          <v>Как мимолетное виденье,</v>
          <v>Как гений чистой красоты.</v>
        </stanza>
        <stanza>
          <v>В томленьях грусти безнадежной,</v>
          <v>В тревогах шумной суеты,</v>
          <v>Звучал мне долго голос нежный</v>
          <v>И снились милые черты.</v>
        </stanza>
        <text-author>1825</text-author>
      </poem>
      <p>Это стихотворение посвящено Анне Петровне Керн<a l:href="#n1" type="note">[1]</a>.</p>
    </section>
    <section>
      <title><p>Глава 2. Зимнее утро</p></title>
      <p>Мороз и солнце; день чудесный! Еще ты дремлешь, друг прелестный — пора, красавица, проснись.</p>
      <p>Здесь проверяются <emphasis>курсив</emphasis>, <strong>полужирный</strong> и <strikethrough>зачёркнутый</strikethrough> текст, а также «ёлочки» и тире — всё в однобайтовой кодировке.</p>
    </section>
  </section>
  <section>
    <title><p>Часть вторая. Проза</p></title>
    <section>
      <title><p>Глава 3. Рисунок</p></title>
      <p>Ниже находится встроенная картинка, закодированная в base64 внутри элемента binary.</p>
      <image l:href="#figure1.png"/>
      <p>Подпись: столбчатая диаграмма для проверки отображения изображений.</p>
      <subtitle>* * *</subtitle>
      <p>Съешь же ещё этих мягких французских булок, да выпей чаю.</p>
      <empty-line/>
      <cite><p>Цитата: лучше поздно, чем никогда.</p><text-author>Пословица</text-author></cite>
    </section>
    <section>
      <title><p>Глава 4. Таблица</p></title>
      <table>
        <tr><th>Город</th><th>Год</th></tr>
        <tr><td>Москва</td><td>1147</td></tr>
        <tr><td>Санкт-Петербург</td><td>1703</td></tr>
      </table>
      <p>Конец пробной книги. Уникальное слово для поиска: ЖУРАВЛЬ.</p>
    </section>
  </section>
</body>
<body name="notes">
  <title><p>Примечания</p></title>
  <section id="n1">
    <title><p>1</p></title>
    <p>Анна Петровна Керн (1800–1879) — адресат стихотворения.</p>
  </section>
</body>
<binary id="cover.jpg" content-type="image/jpeg">
{cover}
</binary>
<binary id="figure1.png" content-type="image/png">
{figure}
</binary>
</FictionBook>
'''

# ── FB2 #2: Chinese, UTF-8, shipped zipped as .fbz ───────────────────────

FB2_ZH = '''<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
  <title-info>
    <genre>prose_classic</genre>
    <author><first-name>测试</first-name><last-name>作者</last-name></author>
    <book-title>压缩包里的书</book-title>
    <coverpage><image l:href="#cover.jpg"/></coverpage>
    <lang>zh</lang>
  </title-info>
</description>
<body>
  <section>
    <title><p>第一章 起</p></title>
    <p>　　这是一个装在 zip 压缩包（.fbz）里的 FB2 文件，编码为 UTF-8。</p>
    <p>　　床前明月光，疑是地上霜。举头望明月，低头思故乡。</p>
  </section>
  <section>
    <title><p>第二章 承</p></title>
    <p>　　第二章的正文。用于检索的独特词语：青花瓷。</p>
  </section>
</body>
<binary id="cover.jpg" content-type="image/jpeg">
{cover}
</binary>
</FictionBook>
'''


def write_fb2():
    ru = FB2_RU.replace('{cover}', b64(cover_image('Probnaya kniga', (150, 40, 40)))) \
               .replace('{figure}', b64(figure_image()))
    with open(os.path.join(ROOT, 'fb2-cyrillic-1251.fb2'), 'wb') as f:
        f.write(ru.encode('cp1251'))

    zh = FB2_ZH.replace('{cover}', b64(cover_image('Zipped book', (30, 90, 150))))
    out = os.path.join(ROOT, 'fb2-chinese.fbz')
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        info = zipfile.ZipInfo('fb2-chinese.fb2', date_time=(2026, 10, 7, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, zh.encode('utf-8'))


# ── TIFF: three pages, three compressions ────────────────────────────────

def fax_page():
    img = Image.new('1', (1275, 1650), 1)  # 150 dpi letter, bilevel
    d = ImageDraw.Draw(img)
    d.text((90, 90), 'FACSIMILE TRANSMISSION', fill=0, font=font(64))
    d.line([90, 180, 1185, 180], fill=0, width=4)
    lines = [
        'To: SoloPDF Reader',
        'From: Test Fixture Generator',
        'Pages: 3 (including this cover)',
        'Compression: CCITT Group 4',
        '',
        'The quick brown fox jumps over the lazy dog.',
        'Page one of three.',
    ]
    for i, s in enumerate(lines):
        d.text((90, 240 + i * 80), s, fill=0, font=font(44))
    d.rectangle([90, 1300, 1185, 1500], outline=0, width=4)
    d.text((120, 1370), 'CONFIDENTIAL', fill=0, font=font(56))
    return img


def color_page():
    img = Image.new('RGB', (800, 1000), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.text((40, 40), 'Page two - LZW RGB', fill=(20, 20, 120), font=font(48))
    for i, c in enumerate([(220, 50, 50), (50, 170, 70), (40, 90, 220), (240, 180, 20)]):
        d.rectangle([60 + i * 170, 300, 200 + i * 170, 700], fill=c)
    d.text((40, 800), 'Colour blocks: red green blue yellow', fill=(0, 0, 0), font=font(32))
    return img


def gray_page():
    img = Image.new('L', (1000, 700), 255)  # landscape: rotate test
    d = ImageDraw.Draw(img)
    for x in range(0, 1000, 4):
        d.line([x, 500, x, 690], fill=int(x / 1000 * 255))
    d.text((40, 40), 'Page three - Deflate grayscale', fill=0, font=font(48))
    d.text((40, 140), 'Landscape page: rotate me.', fill=40, font=font(40))
    return img


def write_tiff():
    tiffcp = shutil.which('tiffcp')
    if not tiffcp:
        sys.exit('tiffcp not found (brew install libtiff / apt install libtiff-tools)')
    with tempfile.TemporaryDirectory() as tmp:
        a = os.path.join(tmp, 'a.tif')
        b = os.path.join(tmp, 'b.tif')
        c = os.path.join(tmp, 'c.tif')
        fax_page().save(a, compression='group4', dpi=(150, 150))
        color_page().save(b, compression='tiff_lzw', dpi=(100, 100))
        gray_page().save(c, compression='tiff_adobe_deflate', dpi=(100, 100))
        out = os.path.join(ROOT, 'tiff-mixed-3p.tiff')
        if os.path.exists(out):
            os.remove(out)
        subprocess.run([tiffcp, a, b, c, out], check=True)


if __name__ == '__main__':
    write_fb2()
    write_tiff()
    for n in ('fb2-cyrillic-1251.fb2', 'fb2-chinese.fbz', 'tiff-mixed-3p.tiff'):
        p = os.path.join(ROOT, n)
        print(f'{n}: {os.path.getsize(p)} bytes')
